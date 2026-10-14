"""Bounded real-weight verification; writes only ignored local reports, never trains.

Run: .venv-test/Scripts/python.exe scripts/verify_pipeline_live.py
Each device/model case runs in a child process with a 180-second deadline.
"""
from __future__ import annotations

import argparse
import csv
import hashlib
import importlib.metadata
import json
from pathlib import Path
import subprocess
import sys
import time
from datetime import datetime, timedelta, timezone

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
REPORT = ROOT / "reports" / "pipeline_live_verification"


def sha(path):
    with Path(path).open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def selected_clips():
    with (ROOT / "data/processed/scfd_pilot/test_manifest.csv").open(encoding="utf-8-sig", newline="") as stream:
        rows = list(csv.DictReader(stream))
    chosen = [next(row for row in rows if row["binary_source_label"] == label)
              for label in ("fight", "non_fight")]
    for row in chosen:
        assert row["split"] == "test" and float(row["duration_sec"]) <= 5
        assert sha(ROOT / row["relative_path"]) == row["sha256"], "clip differs from recorded test manifest"
    return chosen


def run_case(device, model):
    import torch
    torch.set_num_threads(2)
    from fastapi.testclient import TestClient
    from webapp.api import create_app
    from webapp.event_store import EventStore
    from webapp.models import runtime_status
    from starlette.websockets import WebSocketDisconnect

    if device == "cuda" and not torch.cuda.is_available():
        raise RuntimeError("CUDA unavailable: GPU acceptance remains unverified")
    rows = selected_clips()
    result = {"device": device, "model": model, "runtime": runtime_status(), "pipelines": [], "replays": []}
    # Verification history belongs to the report, never the user's default database.
    with TestClient(create_app(event_store=EventStore(REPORT / f"{device}_{model}.sqlite3"))) as client:
        for row in rows:
            path = ROOT / row["relative_path"]
            started = time.perf_counter()
            response = client.post("/api/pipeline/analyze", files={"file": (path.name, path.read_bytes(), "video/mp4")},
                                   data={"model": model, "device": device})
            assert response.status_code == 200, response.text
            body = response.json()
            assert body["device_used"] == ("cuda:0" if device == "cuda" else "cpu")
            assert body["face_blur"]["complete"]
            assert len(body["face_blur"]["faces_by_frame"]) == body["stage1"]["source"]["frame_count"]
            assert body["stage1"]["frames"] and body["stage2"]["windows"]
            assert len(body["pipeline"]["windows"]) == len(body["stage2"]["windows"])
            assert all(w["x3d_evaluated"] for w in body["pipeline"]["windows"])
            result["pipelines"].append({"clip": row["relative_path"], "sha256": row["sha256"],
                "duration_s": float(row["duration_sec"]), "width": int(row["width"]), "height": int(row["height"]),
                "seconds": round(time.perf_counter() - started, 3), "timings_ms": body["timings_ms"],
                "summary": body["pipeline"]["summary"], "device_used": body["device_used"]})
        ids = set()
        for stop_early in (False, True):
            for index in range(3):
                row = rows[index % 2]
                path = ROOT / row["relative_path"]
                started = time.perf_counter()
                response = client.post("/api/live/start-upload", files={"file": (path.name, path.read_bytes(), "video/mp4")},
                                       data={"model": model, "device": device})
                assert response.status_code == 200, response.text
                sid = response.json()["session_id"]
                assert sid not in ids
                ids.add(sid)
                live = client.app.state.live_session
                received = []
                stop_requested = False
                with client.websocket_connect("/api/live/events?session_id=" + sid) as ws:
                    while True:
                        event = ws.receive_json()
                        assert event["session_id"] == sid
                        received.append(event["type"])
                        if stop_early and not stop_requested and event["type"] == "confidence":
                            assert client.post("/api/live/stop").status_code == 200
                            stop_requested = True
                        if event.get("state") in {"stopped", "error", "degraded"}:
                            assert event["state"] == "stopped", event
                            break
                    try:
                        ws.receive_json()
                        raise AssertionError("WebSocket did not close after final health")
                    except WebSocketDisconnect as closed:
                        assert closed.code == 1000
                assert live.wait(5)
                assert live.frames_received == live.frames_processed == live.frames_face_scanned
                assert not Path(live.source).exists()
                assert "confidence" in received
                if not stop_early:
                    assert "preview" in received and "x3d" in received
                result["replays"].append({"clip": row["relative_path"], "stop_early": stop_early,
                    "seconds": round(time.perf_counter() - started, 3), "event_types": sorted(set(received)),
                    **live.status()})
        # The inference lock must also be usable after replay finishes.
        assert client.app.state.analysis_semaphore.acquire(blocking=False)
        client.app.state.analysis_semaphore.release()
    return result


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--device", choices=("cpu", "cuda"))
    parser.add_argument("--model", choices=("yolov8n", "yolov8s"))
    args = parser.parse_args()
    REPORT.mkdir(parents=True, exist_ok=True)
    if args.device:
        try:
            result = {"passed": True, **run_case(args.device, args.model)}
        except Exception as exc:
            result = {"passed": False, "device": args.device, "model": args.model,
                      "error": type(exc).__name__ + ": " + str(exc)}
        (REPORT / f"{args.device}_{args.model}.json").write_text(json.dumps(result, indent=2), encoding="utf-8")
        print(json.dumps({k: v for k, v in result.items() if k in ("passed", "device", "model", "error")}))
        return 0 if result["passed"] else 1
    from webapp import config
    baseline = {"python": sys.version, "code_revision": subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=ROOT, text=True).strip(),
        "recorded_at": datetime.now(timezone(timedelta(hours=7))).isoformat(),
        "source_sha256": {path: sha(ROOT / path) for path in (
            "webapp/api.py", "webapp/live.py", "mockup/analyze.js", "mockup/live.js", "mockup/index.html",
            "scripts/verify_pipeline_live.py", "tests/test_pipeline_live.py")},
        "working_tree": subprocess.check_output(["git", "status", "--short"], cwd=ROOT, text=True),
        "weights": {name: sha(config.WEIGHTS_DIR / filename) for name, filename in config.WEIGHT_FILES.items()},
        "yunet_sha256": sha(config.WEIGHTS_DIR / "face_detection_yunet_2023mar.onnx"),
        "dependencies": {name: importlib.metadata.version(name) for name in
                         ("torch", "torchvision", "ultralytics", "pytorchvideo", "opencv-python", "fastapi", "starlette", "httpx", "pytest")}}
    (REPORT / "baseline.json").write_text(json.dumps(baseline, indent=2), encoding="utf-8")
    failed = False
    for device in ("cpu", "cuda"):
        for model in ("yolov8n", "yolov8s"):
            print(f"Verifying {device}/{model}", flush=True)
            try:
                completed = subprocess.run([sys.executable, "-u", __file__, "--device", device, "--model", model],
                                           cwd=ROOT, timeout=180, capture_output=True, text=True)
                print(completed.stdout.strip(), flush=True)
                if completed.returncode:
                    print(completed.stderr[-2000:], flush=True)
                    failed = True
            except subprocess.TimeoutExpired:
                failed = True
                (REPORT / f"{device}_{model}.json").write_text(json.dumps({"passed": False, "error": "180-second timeout"}), encoding="utf-8")
                print("180-second timeout", flush=True)
    return int(failed)


if __name__ == "__main__":
    raise SystemExit(main())
