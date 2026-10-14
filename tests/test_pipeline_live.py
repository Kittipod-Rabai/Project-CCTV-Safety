"""Regression tests for combined analysis and replay ownership/cleanup."""
import queue
import threading
import time
from pathlib import Path

import cv2
import numpy as np
import pytest
from fastapi.testclient import TestClient
from starlette.websockets import WebSocketDisconnect

from conftest import write_video
from test_api import NoFaceFixture, StubRegistry
from webapp.api import _analysis_settings, create_app
from webapp.live import LiveSession
from cctv_safety.detector import load_thresholds
from cctv_safety.ppe import Detection
from webapp import config


class Registry(StubRegistry):
    def stage1(self, name, frames, thresholds=None, options=None, device=None):
        return super().stage1(name, frames, thresholds, options)

    def stage2(self, clips, device=None):
        return super().stage2(clips)


class Capture:
    def __init__(self, count=40, opened=True, release_gate=None, release_entered=None):
        self.left = count
        self.opened = opened
        self.release_gate = release_gate
        self.release_entered = release_entered
        self.released = False

    def isOpened(self):
        return self.opened

    def get(self, _key):
        return 0  # no wall-clock pacing in deterministic tests

    def read(self):
        if not self.left:
            return False, None
        self.left -= 1
        return True, np.zeros((48, 64, 3), np.uint8)

    def release(self):
        if self.release_entered:
            self.release_entered.set()
        if self.release_gate:
            assert self.release_gate.wait(5), "test release gate timed out"
        self.released = True


def session(capture, registry=None, faces=NoFaceFixture):
    return LiveSession("file", "test.avi", "yolov8n", "cpu", registry or Registry(),
                       _analysis_settings(None, load_thresholds(config.THRESHOLDS_PATH)),
                       config.WEIGHTS_DIR, capture_factory=lambda _: capture,
                       face_anonymizer_factory=faces)


def wait_finished(live):
    assert live.wait(5), "replay workers did not finish within 5 seconds"
    assert not live._capture_thread.is_alive()
    assert not live._worker_thread.is_alive()


def test_cleanup_waits_for_capture_release():
    gate, entered, cleaned = threading.Event(), threading.Event(), threading.Event()
    cap = Capture(2, release_gate=gate, release_entered=entered)
    live = session(cap)
    live.on_finish = cleaned.set
    live.start()
    try:
        assert entered.wait(5)
        assert not cleaned.is_set()
        assert live.state in {"running", "stopping"}
    finally:
        gate.set()
    wait_finished(live)
    assert cleaned.is_set() and cap.released and live.state == "stopped"


def test_replay_drains_received_frames_and_tags_events():
    live = session(Capture(80))
    live._frames = queue.Queue(maxsize=1)
    live.start()
    wait_finished(live)
    assert live.frames_received == live.frames_processed == live.frames_face_scanned == 80
    events = list(live._events.queue)
    assert events and all(e["session_id"] == live.session_id for e in events)
    assert events[-1]["state"] == "stopped"
    assert any(e["type"] == "x3d" for e in events)
    assert all(e.get("start_s", 0) >= 0 for e in events)


def test_stop_drains_and_cleans_once():
    class Slow(Registry):
        def stage1(self, *args, **kwargs):
            time.sleep(0.005)
            return super().stage1(*args, **kwargs)
    live = session(Capture(1000), Slow())
    calls = []
    live.on_finish = lambda: calls.append(1)
    live.start()
    live.stop()
    live.stop()
    wait_finished(live)
    assert live.frames_received == live.frames_processed
    assert calls == [1]


@pytest.mark.parametrize("failure", ["privacy", "yolo", "x3d", "source", "decode"])
def test_worker_failure_cannot_deadlock_or_publish_raw_preview(failure):
    class Faces(NoFaceFixture):
        def detect(self, frame):
            if failure == "privacy":
                raise RuntimeError("fixture failure")
            return []
    class Broken(Registry):
        def stage1(self, *args, **kwargs):
            if failure == "yolo":
                raise RuntimeError("fixture failure")
            return super().stage1(*args, **kwargs)
        def stage2(self, *args, **kwargs):
            if failure == "x3d":
                raise RuntimeError("fixture failure")
            return super().stage2(*args, **kwargs)
    class BrokenCapture(Capture):
        def get(self, _key):
            return 1000  # enough video-time samples for X3D without slowing the test
        def read(self):
            if failure == "decode":
                raise RuntimeError("fixture decode failure")
            return super().read()
    cap = BrokenCapture(3000, opened=failure != "source")
    live = session(cap, Broken(), Faces)
    live._frames = queue.Queue(maxsize=1)
    live.start()
    wait_finished(live)
    assert live.state == "error" and cap.released
    if failure in {"privacy", "source", "decode"}:
        assert not any(e["type"] == "preview" for e in live._events.queue)


def test_terminal_health_survives_full_event_queue():
    live = session(Capture(1))
    live._events = queue.Queue(maxsize=2)
    live.publish({"type": "confidence"})
    live.publish({"type": "candidate"})
    live.start()
    wait_finished(live)
    assert any(e.get("state") == "stopped" for e in live._events.queue)


def test_empty_decodable_source_is_error_and_releases():
    cap = Capture(0)
    live = session(cap)
    live.start()
    wait_finished(live)
    assert live.state == "error" and live.reason == "decode_failed" and cap.released


def test_live_api_restart_cleanup_and_websocket_identity(tmp_path):
    video = write_video(tmp_path / "replay.avi", n_frames=20, fps=100)
    with TestClient(create_app(registry=Registry(), face_anonymizer_factory=NoFaceFixture)) as client:
        ids = []
        for _ in range(3):
            response = client.post("/api/live/start-upload", files={"file": (video.name, video.read_bytes())},
                                   data={"device": "cpu"})
            assert response.status_code == 200, response.text
            live = client.app.state.live_session
            ids.append(response.json()["session_id"])
            with client.websocket_connect(f"/api/live/events?session_id={ids[-1]}") as ws:
                events = []
                while True:
                    event = ws.receive_json()
                    events.append(event)
                    assert event["session_id"] == ids[-1]
                    if event.get("state") in {"stopped", "error", "degraded"}:
                        break
                assert events[-1]["state"] == "stopped"
                with pytest.raises(WebSocketDisconnect) as closed:
                    ws.receive_json()
                assert closed.value.code == 1000
            wait_finished(live)
            assert not Path(live.source).exists()
            assert client.get("/api/live/status").json()["session_id"] == ids[-1]
        assert len(set(ids)) == 3
        with client.websocket_connect(f"/api/live/events?session_id={ids[0]}") as ws:
            assert ws.receive_json()["reason"] == "session_mismatch"
            with pytest.raises(WebSocketDisconnect):
                ws.receive_json()


@pytest.mark.parametrize("fight,fall,decision", [(True, True, "review_fall_fight_conflict"),
    (True, False, "fight_candidate"), (False, True, "fall_detected"),
    (False, False, "no_fight_candidate")])
def test_pipeline_shadow_and_decision_without_person(tmp_path, fight, fall, decision):
    class Fixed(Registry):
        def stage1(self, name, frames, *args, **kwargs):
            return [[Detection("fall", .9, (0, 0, 32, 32))] if fall else [] for _ in frames]
        def stage2(self, clips, **kwargs):
            return [(.1, .9) if fight else (.9, .1) for _ in clips]
    video = write_video(tmp_path / "p.avi", n_frames=35, fps=10)
    with TestClient(create_app(registry=Fixed(), face_anonymizer_factory=NoFaceFixture)) as client:
        result = client.post("/api/pipeline/analyze", files={"file": (video.name, video.read_bytes())},
                             data={"model": "yolov8n", "device": "cpu"})
    assert result.status_code == 200, result.text
    body = result.json()
    assert body["x3d_policy"] == "evaluate_every_window_shadow_mode"
    assert len(body["stage2"]["windows"]) == 2
    assert all(w["decision"] == decision and w["x3d_evaluated"] and not w["person_triggered"]
               for w in body["pipeline"]["windows"])
    assert len(body["face_blur"]["faces_by_frame"]) == 35


@pytest.mark.parametrize("name,payload,data,code", [
    ("bad.txt", b"bad", {}, "unsupported_media_type"),
    ("empty.avi", b"", {}, "missing_file"),
    ("bad.avi", b"not a video", {}, "decode_failed"),
    ("p.avi", None, {"sample_fps": "nan"}, "invalid_parameter"),
    ("p.avi", None, {"device": "invalid"}, "invalid_parameter"),
])
def test_pipeline_errors_recover(tmp_path, name, payload, data, code):
    video = write_video(tmp_path / "p.avi", n_frames=20, fps=10)
    with TestClient(create_app(registry=Registry(), face_anonymizer_factory=NoFaceFixture)) as client:
        response = client.post("/api/pipeline/analyze", files={"file": (name, video.read_bytes() if payload is None else payload)},
                               data={"model": "yolov8n", "device": "cpu", **data})
        assert response.json()["error"]["code"] == code
        assert client.post("/api/pipeline/analyze", files={"file": (video.name, video.read_bytes())},
                           data={"model": "yolov8n", "device": "cpu"}).status_code == 200


def test_live_busy_stop_and_pipeline_recovery(tmp_path):
    video = write_video(tmp_path / "p.avi", n_frames=50, fps=10)
    with TestClient(create_app(registry=Registry(), face_anonymizer_factory=NoFaceFixture)) as client:
        upload = lambda: client.post("/api/live/start-upload", files={"file": (video.name, video.read_bytes())},
                                     data={"device": "cpu"})
        assert upload().status_code == 200
        live = client.app.state.live_session
        assert upload().status_code == 409
        assert client.post("/api/pipeline/analyze", files={"file": (video.name, video.read_bytes())},
                           data={"model": "yolov8n", "device": "cpu"}).status_code == 429
        assert client.post("/api/live/stop").status_code == 200
        wait_finished(live)
        assert live.frames_received == live.frames_processed
        assert not Path(live.source).exists()
        assert client.post("/api/pipeline/analyze", files={"file": (video.name, video.read_bytes())},
                           data={"model": "yolov8n", "device": "cpu"}).status_code == 200


def test_pipeline_privacy_failure_cleans_upload(tmp_path, monkeypatch):
    from webapp import media
    class Broken(NoFaceFixture):
        def detect(self, frame):
            raise RuntimeError("fixture privacy failure")
    saved = []
    original = media.save_to_temp
    def save(*args):
        path = original(*args)
        saved.append(path)
        return path
    monkeypatch.setattr(media, "save_to_temp", save)
    video = write_video(tmp_path / "p.avi", n_frames=20, fps=10)
    with TestClient(create_app(registry=Registry(), face_anonymizer_factory=Broken), raise_server_exceptions=False) as client:
        response = client.post("/api/pipeline/analyze", files={"file": (video.name, video.read_bytes())},
                               data={"model": "yolov8n", "device": "cpu"})
        assert response.status_code == 500 and "preview" not in response.text
        assert saved and not any(p.exists() for p in saved)


def test_live_disconnect_can_stop_and_reconnect(tmp_path):
    video = write_video(tmp_path / "replay.avi", n_frames=40, fps=10)
    with TestClient(create_app(registry=Registry(), face_anonymizer_factory=NoFaceFixture)) as client:
        response = client.post("/api/live/start-upload", files={"file": (video.name, video.read_bytes())}, data={"device": "cpu"})
        sid = response.json()["session_id"]
        with client.websocket_connect("/api/live/events?session_id=" + sid) as ws:
            assert ws.receive_json()["session_id"] == sid
        assert client.post("/api/live/stop").status_code == 200
        wait_finished(client.app.state.live_session)
        with client.websocket_connect("/api/live/events?session_id=" + sid) as ws:
            while True:
                event = ws.receive_json()
                assert event["session_id"] == sid
                if event.get("state") == "stopped":
                    break


@pytest.mark.parametrize("route", ["/api/pipeline/analyze", "/api/live/start-upload"])
def test_upload_size_limits_release_inference_slot(tmp_path, monkeypatch, route):
    video = write_video(tmp_path / "p.avi", n_frames=20, fps=10)
    monkeypatch.setattr(config, "MAX_UPLOAD_BYTES", 10)
    with TestClient(create_app(registry=Registry(), face_anonymizer_factory=NoFaceFixture)) as client:
        response = client.post(route, files={"file": (video.name, video.read_bytes())}, data={"model": "yolov8n", "device": "cpu"})
        assert response.status_code == 413
        assert client.app.state.analysis_semaphore.acquire(blocking=False)
        client.app.state.analysis_semaphore.release()


def test_pipeline_too_long_and_unavailable_cuda(tmp_path, monkeypatch):
    video = write_video(tmp_path / "p.avi", n_frames=61, fps=1, width=32, height=24)
    with TestClient(create_app(registry=Registry(), face_anonymizer_factory=NoFaceFixture)) as client:
        response = client.post("/api/pipeline/analyze", files={"file": (video.name, video.read_bytes())}, data={"model": "yolov8n", "device": "cpu"})
        assert response.json()["error"]["code"] == "video_too_long"
        monkeypatch.setattr("webapp.models.runtime_status", lambda: {"cuda_available": False})
        response = client.post("/api/pipeline/analyze", files={"file": (video.name, video.read_bytes())}, data={"model": "yolov8n", "device": "cuda"})
        assert response.json()["error"]["code"] == "device_unavailable"
