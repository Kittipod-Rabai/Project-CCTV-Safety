"""Prepare the ignored local replay pack from an existing verified result; never infer.

Normal use: python scripts/prepare_demo_assets.py
After a new preview has been visually reviewed: --approve-preview --write-manifest
The latter deliberately updates the tracked evidence manifest for review.
"""
from __future__ import annotations
import argparse
import base64
import hashlib
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
REPORT = ROOT / "reports/settings_verification/real-defaults.json"
SOURCE = ROOT / "data/raw/dfire/data/test/images/WEB11091.jpg"
MANIFEST = ROOT / "mockup/demo-manifest.json"
PACK = ROOT / "mockup/demo-assets"

def digest(data):
    return hashlib.sha256(data).hexdigest()

def prepare(approve=False, write_manifest=False):
    raw = REPORT.read_bytes()
    report = json.loads(raw)
    result = report["result"]
    assert result["is_model_output"] is True and result["model"] == "yolov8n"
    assert result["source"]["width"] == 640 and result["source"]["height"] == 360
    boxes = result["frames"][0]["detections"]
    assert [(d["class_name"], d["confidence"]) for d in boxes] == [("smoke", .8779), ("fire", .3589)]
    preview = base64.b64decode(result["frames"][0]["image_jpeg_b64"], validate=True)
    assert preview[:2] == b"\xff\xd8"
    # Keep the original report hash and metadata; move only the image out of JSON.
    result["frames"][0].pop("image_jpeg_b64")
    payload = json.dumps({"result": result}, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode()
    manifest = {
        "version": 1, "sample_id": "captured-smoke", "source_file": str(SOURCE.relative_to(ROOT)).replace("\\", "/"),
        "source_sha256": digest(SOURCE.read_bytes()), "evidence": str(REPORT.relative_to(ROOT)).replace("\\", "/"),
        "evidence_sha256": digest(raw), "captured_at": None,
        "capture_time_note": "Original report does not record inference timestamp; do not infer it from filesystem dates.",
        "model": result["model"], "device_used": result["device_used"], "settings": result["analysis_settings"],
        "privacy_review": "Reviewed preview: smoke/vegetation only, no identifiable people. Not a claim of a complete face scan.",
        "approved_preview": True, "media_kind": "still-image-replay", "width": 640, "height": 360,
        "source_notes": "D-Fire test sample. Local educational replay; raw dataset media are not distributed in Git.",
        "source_audit": "docs/stage1_dataset_primary_source_audit.md",
        "payload": {"path": "demo-assets/smoke-result.json", "sha256": digest(payload)},
        "preview": {"path": "demo-assets/smoke-preview.jpg", "sha256": digest(preview)},
    }
    if write_manifest:
        if not approve:
            raise ValueError("Visually review preview before --approve-preview --write-manifest")
        MANIFEST.write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    else:
        recorded = json.loads(MANIFEST.read_text(encoding="utf-8"))
        if recorded != manifest:
            raise ValueError("Evidence differs from reviewed manifest; do not silently approve another preview")
    PACK.mkdir(exist_ok=True)
    (PACK / "smoke-result.json").write_bytes(payload)
    (PACK / "smoke-preview.jpg").write_bytes(preview)
    print("Prepared local replay pack. Model inference was not executed.")

if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--approve-preview", action="store_true")
    parser.add_argument("--write-manifest", action="store_true")
    args = parser.parse_args()
    prepare(args.approve_preview, args.write_manifest)
