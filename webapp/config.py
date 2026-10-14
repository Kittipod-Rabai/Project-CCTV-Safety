"""Web prototype configuration: paths, upload limits and fixed response text."""

from __future__ import annotations

import os
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[1]

# Weights directory: env CCTV_WEIGHTS_DIR, default <repo>/weights (git-ignored).
WEIGHTS_DIR = Path(os.environ.get("CCTV_WEIGHTS_DIR", REPO_ROOT / "weights"))
WEIGHT_FILES = {
    "yolov8n": "YOLOv8n_best.pt",
    "yolov8s": "YOLOv8s_best.pt",
    "x3d_s": "X3D-S_best.pt",
}
STAGE1_MODELS = ("yolov8n", "yolov8s")
STAGE2_MODEL = "x3d_s"

THRESHOLDS_PATH = REPO_ROOT / "configs" / "thresholds.yaml"
STATIC_DIR = REPO_ROOT / "mockup"
EVENT_DB_PATH = Path(os.environ.get("CCTV_EVENTS_DB_PATH", REPO_ROOT / "data/local/cctv_safety.sqlite3"))

SCHEMA_VERSION = "1.0"
DISCLAIMER = (
    "ต้นแบบเพื่อการศึกษา (pilot) ฝึกด้วยชุดข้อมูลสาธารณะเท่านั้น ไม่ใช่ระบบใช้งานจริง "
    "และยังไม่ได้ตรวจสอบความถูกต้องกับกล้อง CCTV เป้าหมาย / Educational pilot trained on public "
    "datasets only. Not a production system and not validated on the target CCTV cameras."
)

# Uploads (contract section 0.2). Read at request time so tests may monkeypatch it.
MAX_UPLOAD_BYTES = 100 * 1024 * 1024
# Bound decoded memory independently of upload bytes (compressed media can expand greatly).
MAX_IMAGE_PIXELS = 40_000_000
MAX_VIDEO_PIXELS = 16_777_216  # includes standard 4K frames
IMAGE_EXTENSIONS = (".jpg", ".jpeg", ".png", ".bmp", ".webp")
VIDEO_EXTENSIONS = (".mp4", ".avi", ".mov", ".mkv")

# Stage 1 frame sampling.
DEFAULT_MAX_FRAMES = 16
MAX_FRAMES_LIMIT = 60

# Stage 1 dense mode (boxes only, for the playback overlay).
STAGE1_MODES = ("frames", "dense")
DEFAULT_SAMPLE_FPS = 10.0
MIN_SAMPLE_FPS = 1.0
MAX_SAMPLE_FPS = 30.0
DENSE_BATCH = 16  # frames handed to the detector at once; only this many full-res frames are alive

# Stage 2 windowing.
WINDOW_S = 2.0
MIN_PARTIAL_WINDOW_S = 1.0
MAX_WINDOWS = 30
STAGE2_BATCH = 8

JPEG_QUALITY = 90
