"""Shared helpers for the web-prototype tests: paths, weights skips and synthetic media.

There is no sample media in the repo and no ffmpeg, so every image/video is synthesized
in ``tmp_path`` with Pillow / OpenCV.
"""

from __future__ import annotations

import io
import json
import sys
from pathlib import Path

import numpy as np
import pytest

REPO_ROOT = Path(__file__).resolve().parents[1]
if str(REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(REPO_ROOT))

WEIGHTS_DIR = REPO_ROOT / "weights"
FIXTURES_DIR = REPO_ROOT / "tests" / "fixtures" / "api"
YOLO_WEIGHTS = {"yolov8n": WEIGHTS_DIR / "YOLOv8n_best.pt", "yolov8s": WEIGHTS_DIR / "YOLOv8s_best.pt"}
X3D_WEIGHTS = WEIGHTS_DIR / "X3D-S_best.pt"


def require_weights(*paths: Path) -> None:
    missing = [str(p) for p in paths if not p.is_file()]
    if missing:
        pytest.skip(f"real weights not present: {missing}")


def load_fixture(name: str):
    return json.loads((FIXTURES_DIR / name).read_text(encoding="utf-8"))


def frame_gray(index: int, width: int = 64, height: int = 48) -> np.ndarray:
    """BGR frame whose every pixel equals ``index * 4`` (lets tests identify a decoded frame)."""
    return np.full((height, width, 3), (index * 4) % 256, np.uint8)


def write_video(path: Path, n_frames: int, fps: float = 10.0, width: int = 64, height: int = 48,
                frame_fn=None) -> Path:
    """Write a synthetic video. ``.avi`` uses MJPG (lossless enough to identify frames by grey
    level), anything else uses ``mp4v``."""
    import cv2

    fourcc = cv2.VideoWriter_fourcc(*("MJPG" if path.suffix.lower() == ".avi" else "mp4v"))
    writer = cv2.VideoWriter(str(path), fourcc, float(fps), (width, height))
    assert writer.isOpened(), f"cv2.VideoWriter could not open {path}"
    for i in range(n_frames):
        frame = frame_fn(i) if frame_fn else frame_gray(i, width, height)
        writer.write(frame)
    writer.release()
    cap = cv2.VideoCapture(str(path))
    count = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))
    cap.release()
    assert count == n_frames, f"synthetic video has {count} frames, expected {n_frames}"
    return path


def image_bytes(width: int = 160, height: int = 120, color=(255, 0, 0), fmt: str = "JPEG") -> bytes:
    """Solid-colour image (``color`` is RGB) encoded with Pillow."""
    from PIL import Image

    buffer = io.BytesIO()
    Image.new("RGB", (width, height), color).save(buffer, format=fmt)
    return buffer.getvalue()


@pytest.fixture
def make_video(tmp_path):
    def _make(name: str = "clip.mp4", **kwargs) -> Path:
        return write_video(tmp_path / name, **kwargs)

    return _make


@pytest.fixture(autouse=True)
def isolate_observation_database(tmp_path, monkeypatch):
    # API/model fixtures must never insert synthetic test observations in user history.
    from webapp import config
    monkeypatch.setattr(config, "EVENT_DB_PATH", tmp_path / "history.sqlite3")
