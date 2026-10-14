"""FastAPI app for the Upload & Analyze prototype (contract: docs/web_api_contract.md).

Run: ``.venv-test/Scripts/python -m uvicorn webapp.api:app --port 8000`` then open
http://localhost:8000/. Models load lazily on the first analyze request.
"""

from __future__ import annotations

import logging
import json
import math
import re
import sys
import asyncio
import queue
import threading
import tempfile
import uuid
import time
from threading import BoundedSemaphore
from time import perf_counter
from pathlib import Path
from typing import Literal
from typing import Iterator

from fastapi import Depends, FastAPI, File, Form, Query, Request, UploadFile, WebSocket, WebSocketDisconnect
from pydantic import BaseModel
from fastapi.exception_handlers import http_exception_handler
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from fastapi.staticfiles import StaticFiles
from starlette.datastructures import UploadFile as StarletteUploadFile
from starlette.exceptions import HTTPException as StarletteHTTPException

_REPO_ROOT = Path(__file__).resolve().parents[1]
if str(_REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(_REPO_ROOT))

from cctv_safety.detector import load_thresholds  # noqa: E402
from cctv_safety.ppe import assess_ppe  # noqa: E402
from cctv_safety.privacy import (  # noqa: E402
    DEFAULT_FACE_BLUR_STRENGTH, DEFAULT_FACE_CONFIDENCE, DEFAULT_FACE_PADDING,
    FaceModelUnavailable, YuNetFaceAnonymizer, anonymize, bridge_short_face_gaps, elapsed_ms,
)
from cctv_safety.schema import CLASS_NAMES, CLASS_TO_ID, DETECTOR_SCHEMA_VERSION  # noqa: E402
from cctv_safety.stage2 import CLASS_NAMES as STAGE2_CLASS_NAMES, FRAMES  # noqa: E402
from cctv_safety.tracking import (  # noqa: E402
    MAX_TRACK_GAP_S,
    MOTION_DIAGONALS_PER_S,
    PROXIMITY_DIAGONALS,
    add_track_ids,
    summarize_window,
)
from webapp import config, media  # noqa: E402
from webapp.media import ApiError  # noqa: E402
from webapp.models import ModelLoadFailed, ModelRegistry, WeightsMissing, resolve_device, runtime_status  # noqa: E402
from webapp.live import LiveSession, validate_source  # noqa: E402
from webapp.event_store import EventStore, StorageUnavailable, EVENT_TYPES, frame_observations, window_observation  # noqa: E402

logger = logging.getLogger("webapp.api")


class ReviewStatusUpdate(BaseModel):
    status: Literal["new", "ack", "closed"]

_HTTP_ERROR_CODES = {404: "not_found", 405: "method_not_allowed"}


def _r(value: float) -> float:
    return round(float(value), 4)


def _envelope(model: str | None, is_model_output: bool = True) -> dict:
    return {
        "is_model_output": is_model_output,
        "model": model,
        "schema_version": config.SCHEMA_VERSION,
        "disclaimer": config.DISCLAIMER,
    }


def _error(status: int, code: str, message: str) -> JSONResponse:
    return JSONResponse(status_code=status, content={"error": {"code": code, "message": message}})


def _status_models(status: dict) -> tuple[dict, str]:
    models = status.get("models", status)
    return {name: models.get(name, "missing") for name in config.WEIGHT_FILES}, str(status.get("device", "cpu"))


def _source(width: int, height: int, info: media.VideoInfo | None) -> dict:
    return {
        "width": int(width),
        "height": int(height),
        "fps": _r(info.fps) if info else None,
        "frame_count": int(info.frame_count) if info else None,
        "duration_s": _r(info.duration_s) if info else None,
    }


def _check_upload(file: UploadFile | None) -> tuple[str | None, int]:
    if file is None or not isinstance(file, StarletteUploadFile):
        raise ApiError(400, "missing_file", "No file was uploaded; send it in the multipart field 'file'.")
    size = file.size if file.size is not None else media.upload_size(file.file)
    if size <= 0:
        raise ApiError(400, "missing_file", "The uploaded file is empty (0 bytes).")
    return media.media_kind(file.filename), size


def _check_kind_and_size(file: UploadFile, kind: str | None, size: int) -> None:
    if kind is None:
        allowed = ", ".join(config.IMAGE_EXTENSIONS + config.VIDEO_EXTENSIONS)
        raise ApiError(415, "unsupported_media_type",
                       f"Unsupported file type '{Path(file.filename or '').suffix}'. Allowed: {allowed}.")
    if size > config.MAX_UPLOAD_BYTES:
        raise media.too_large(config.MAX_UPLOAD_BYTES)


def _too_long(info: media.VideoInfo) -> ApiError:
    windows = len(media.stage2_windows(info.duration_s))
    return ApiError(422, "video_too_long",
                    f"The video is {info.duration_s:.1f} s long and would need {windows} windows of "
                    f"{config.WINDOW_S:g} s; the limit is {config.MAX_WINDOWS} windows (about 60 s).")


def _cleanup_stale_live_uploads() -> int:
    """Remove only this app's UUID-named Live replay files after a process restart."""
    temp_dir = Path(tempfile.gettempdir()) / "cctv-safety-live"
    if not temp_dir.is_dir():
        return 0
    cutoff = time.time() - 24 * 60 * 60
    removed = 0
    for path in temp_dir.iterdir():
        if (not path.is_file() or path.suffix.lower() not in config.VIDEO_EXTENSIONS
                or not re.fullmatch(r"[0-9a-f]{32}", path.stem)):
            continue
        try:
            if path.stat().st_mtime < cutoff:
                path.unlink(missing_ok=True)
                removed += 1
        except OSError:
            logger.warning("Could not remove a stale Live replay upload")
    return removed


def _privacy_settings(face_confidence: str | None, face_padding: str | None,
                      face_blur_strength: str | None) -> dict[str, float]:
    specs = (
        ("face_confidence", face_confidence, DEFAULT_FACE_CONFIDENCE, 0.20, 0.90),
        ("padding_fraction", face_padding, DEFAULT_FACE_PADDING, 0.0, 0.50),
        ("blur_strength", face_blur_strength, DEFAULT_FACE_BLUR_STRENGTH, 0.40, 1.50),
    )
    values = {}
    for name, raw, default, low, high in specs:
        try:
            value = float(raw.strip()) if raw is not None and raw.strip() else default
        except ValueError:
            value = float("nan")
        if not math.isfinite(value) or not low <= value <= high:
            raise ApiError(400, "invalid_parameter",
                           f"'{name}' must be a number in {low:g}..{high:g}; got {raw!r}.")
        values[name] = value
    return values


def _analysis_settings(raw: str | None, base_thresholds: dict) -> dict:
    """Parse and validate per-request model and trigger controls."""
    defaults = {
        "yolo": {"thresholds": dict(base_thresholds), "iou": 0.7, "imgsz": 640, "max_det": 300},
        "x3d": {"fight_threshold": 0.5},
        "tracking": {"proximity_diagonals": PROXIMITY_DIAGONALS,
                     "motion_diagonals_per_s": MOTION_DIAGONALS_PER_S,
                     "max_track_gap_s": MAX_TRACK_GAP_S},
    }
    if not raw or not raw.strip():
        return defaults
    try:
        payload = json.loads(raw)
    except (TypeError, json.JSONDecodeError):
        raise ApiError(400, "invalid_parameter", "'analysis_settings' must be valid JSON.")
    if not isinstance(payload, dict):
        raise ApiError(400, "invalid_parameter", "'analysis_settings' must be a JSON object.")
    try:
        yolo = payload.get("yolo", {})
        x3d = payload.get("x3d", {})
        tracking = payload.get("tracking", {})
        thresholds = {name: float(yolo.get("thresholds", {}).get(name, base_thresholds[name]))
                      for name in CLASS_NAMES}
        if any(not math.isfinite(v) or not 0.01 <= v <= 0.99 for v in thresholds.values()):
            raise ValueError("each YOLO threshold must be in 0.01..0.99")
        iou = float(yolo.get("iou", 0.7)); imgsz = int(yolo.get("imgsz", 640)); max_det = int(yolo.get("max_det", 300))
        fight = float(x3d.get("fight_threshold", 0.5))
        proximity = float(tracking.get("proximity_diagonals", PROXIMITY_DIAGONALS))
        motion = float(tracking.get("motion_diagonals_per_s", MOTION_DIAGONALS_PER_S))
        gap = float(tracking.get("max_track_gap_s", MAX_TRACK_GAP_S))
        if not 0.1 <= iou <= 0.95: raise ValueError("YOLO NMS IoU must be in 0.1..0.95")
        if imgsz not in (320, 480, 640, 800, 960, 1280): raise ValueError("YOLO image size must be one of 320, 480, 640, 800, 960, 1280")
        if not 1 <= max_det <= 1000: raise ValueError("YOLO max detections must be in 1..1000")
        if not 0.05 <= fight <= 0.95: raise ValueError("X3D fight threshold must be in 0.05..0.95")
        if not 0.01 <= proximity <= 0.5: raise ValueError("tracking proximity must be in 0.01..0.5")
        if not 0.01 <= motion <= 2.0: raise ValueError("tracking motion must be in 0.01..2.0")
        if not 0.1 <= gap <= 3.0: raise ValueError("tracking max gap must be in 0.1..3.0")
    except (AttributeError, TypeError, ValueError, OverflowError) as exc:
        raise ApiError(400, "invalid_parameter", f"Invalid analysis setting: {exc}") from exc
    return {"yolo": {"thresholds": thresholds, "iou": iou, "imgsz": imgsz, "max_det": max_det},
            "x3d": {"fight_threshold": fight},
            "tracking": {"proximity_diagonals": proximity, "motion_diagonals_per_s": motion,
                         "max_track_gap_s": gap}}


def create_app(registry=None, weights_dir: Path | None = None, face_anonymizer_factory=None,
               capture_factory=None, event_store=None) -> FastAPI:
    weights_dir = Path(weights_dir) if weights_dir is not None else config.WEIGHTS_DIR
    face_anonymizer_factory = face_anonymizer_factory or YuNetFaceAnonymizer
    if registry is None:
        registry = ModelRegistry(weights_dir, load_thresholds(config.THRESHOLDS_PATH))
    thresholds = getattr(registry, "thresholds", None) or load_thresholds(config.THRESHOLDS_PATH)
    thresholds = {name: float(thresholds[name]) for name in CLASS_NAMES}
    ppe_min_confidence = min(thresholds["person"], thresholds["helmet"], thresholds["vest"])

    app = FastAPI(title="CCTV Safety — Upload & Analyze (pilot)", version=config.SCHEMA_VERSION)
    app.state.registry = registry
    store = event_store if event_store is not None else EventStore(config.EVENT_DB_PATH)
    app.state.event_store = store
    analysis_semaphore = BoundedSemaphore(1)
    app.state.analysis_semaphore = analysis_semaphore
    live_lock = threading.Lock()
    app.state.live_session = None

    @app.on_event("startup")
    def cleanup_stale_live_uploads():
        removed = _cleanup_stale_live_uploads()
        if removed:
            logger.info("Removed %d stale Live replay upload(s)", removed)
        try:
            store.interrupt_running()
        except StorageUnavailable:
            logger.warning("Observation database unavailable; history requests will return 503")

    @app.on_event("shutdown")
    async def stop_live_on_shutdown():
        session = app.state.live_session
        if session:
            session.stop()
            if not await asyncio.to_thread(session.wait, 180):
                logger.error("Live workers did not finish during shutdown")

    def analysis_slot() -> Iterator[None]:
        """Keep only one CPU/GPU-heavy analysis active per local pilot process."""
        live = app.state.live_session
        if live and live.state in {"starting", "running", "stopping"}:
            raise ApiError(429, "analysis_busy", "A live session is using the inference runtime. Retry after it stops.")
        if not analysis_semaphore.acquire(blocking=False):
            raise ApiError(429, "analysis_busy", "Another analysis is running. Retry after it finishes.")
        try:
            yield
        finally:
            analysis_semaphore.release()

    @app.exception_handler(ApiError)
    async def _api_error(_: Request, exc: ApiError):
        return _error(exc.status, exc.code, exc.message)

    @app.exception_handler(WeightsMissing)
    async def _weights_missing(_: Request, exc: WeightsMissing):
        return _error(503, "weights_missing", str(exc))

    @app.exception_handler(ModelLoadFailed)
    async def _load_failed(_: Request, exc: ModelLoadFailed):
        return _error(503, "model_load_failed", str(exc))

    @app.exception_handler(FaceModelUnavailable)
    async def _face_model_unavailable(_: Request, exc: FaceModelUnavailable):
        return _error(503, "privacy_model_unavailable", str(exc))

    @app.exception_handler(StorageUnavailable)
    async def _storage_unavailable(_: Request, exc: StorageUnavailable):
        return _error(503, "storage_unavailable", str(exc))

    @app.exception_handler(StarletteHTTPException)
    async def _http_error(request: Request, exc: StarletteHTTPException):
        code = _HTTP_ERROR_CODES.get(exc.status_code)
        if code is not None and request.url.path.startswith("/api/"):
            text = "No API endpoint at this path." if exc.status_code == 404 else (
                f"Method {request.method} is not allowed for this endpoint.")
            response = _error(exc.status_code, code, f"{text} ({request.method} {request.url.path})")
            if exc.headers:
                response.headers.update(exc.headers)
            return response
        return await http_exception_handler(request, exc)

    @app.exception_handler(Exception)
    async def _internal_error(request: Request, exc: Exception):
        # Full traceback goes to the server log only; the body never carries it.
        logger.error("Unhandled error on %s %s", request.method, request.url.path, exc_info=exc)
        return _error(500, "internal_error", "Internal server error while processing the request; see the server log.")

    @app.exception_handler(RequestValidationError)
    async def _validation(_: Request, exc: RequestValidationError):
        errors = exc.errors()
        if any("file" in (err.get("loc") or ()) for err in errors):
            return _error(400, "missing_file", "No file was uploaded; send it in the multipart field 'file'.")
        detail = "; ".join(f"{'.'.join(str(p) for p in err.get('loc', ()))}: {err.get('msg')}" for err in errors)
        return _error(400, "invalid_parameter", f"Invalid request parameters: {detail}")

    def choose_device(raw: str | None) -> str:
        try:
            return resolve_device(raw)
        except ValueError as exc:
            raise ApiError(400, "invalid_parameter", str(exc)) from exc
        except RuntimeError as exc:
            raise ApiError(503, "device_unavailable", str(exc)) from exc

    def ensure_model(name: str, device: str = "cpu") -> None:
        """weights_missing / model_load_failed come before decode_failed (contract section 4)."""
        models, _ = _status_models(registry.status())
        if models.get(name) == "missing":
            raise WeightsMissing(name, weights_dir / config.WEIGHT_FILES[name])
        load = getattr(registry, "load", None)
        if callable(load):
            import inspect
            if "device" in inspect.signature(load).parameters:
                load(name, device=device)
            else:
                load(name)

    def stage1_on_device(name, frames, active_thresholds, options, device):
        import inspect
        method = registry.stage1
        if "device" in inspect.signature(method).parameters:
            return method(name, frames, active_thresholds, options, device=device)
        return method(name, frames, active_thresholds, options)

    def stage2_on_device(clips, device):
        import inspect
        method = registry.stage2
        if "device" in inspect.signature(method).parameters:
            return method(clips, device=device)
        return method(clips)

    @app.get("/api/health")
    def health():
        models, device = _status_models(registry.status())
        return {**_envelope(None, is_model_output=False), "status": "ok", "device": device,
                "runtime": runtime_status(), "models": models}

    @app.get("/api/logs")
    def list_logs(page: int = Query(1, ge=1), page_size: int = Query(10, ge=1, le=100),
                  q: str = Query("", max_length=200), status: Literal["new", "ack", "closed"] | None = None,
                  event_type: str | None = None, run_id: str | None = Query(None, max_length=64),
                  period: Literal["all", "today", "yesterday", "7d"] = "all"):
        if event_type is not None and event_type not in EVENT_TYPES:
            raise ApiError(400, "invalid_parameter", "Unknown observation type")
        return store.list(page=page,page_size=page_size,q=q,status=status,event_type=event_type,run_id=run_id,period=period)

    @app.get("/api/logs/sources")
    def log_sources():
        return {"items": store.sources()}

    @app.get("/api/logs/{event_id}")
    def log_detail(event_id: int):
        item = store.get(event_id)
        if item is None:
            raise ApiError(404, "not_found", "Observation was not found")
        return item

    @app.patch("/api/logs/{event_id}")
    def log_review(event_id: int, payload: ReviewStatusUpdate):
        if not store.set_status(event_id, payload.status):
            raise ApiError(404, "not_found", "Observation was not found")
        return store.get(event_id)

    def prepare_live_history(session, name, source_type):
        store.begin(name, source_type, session.session_id)
        session.on_frame = lambda entry: store.observe(session.session_id, session.model, frame_observations(entry))
        session.on_prediction = lambda window: store.observe(session.session_id, config.STAGE2_MODEL, [window_observation(window)])

    def finish_live_history(session, cleanup):
        try:
            store.finish(session.session_id, session._outcome)
        finally:
            cleanup()

    @app.post("/api/live/start")
    def live_start(payload: dict):
        """Start one local file replay or RTSP stream. Source/credentials are never echoed."""
        source_type = str(payload.get("source_type", ""))
        source = str(payload.get("source", ""))
        model = payload.get("model", "yolov8n")
        requested_device = payload.get("device", "auto")
        if model not in config.STAGE1_MODELS:
            raise ApiError(400, "invalid_parameter", "model must be yolov8n or yolov8s")
        try:
            safe_source = validate_source(source_type, source, config.REPO_ROOT)
        except (ValueError, OSError) as exc:
            raise ApiError(400, "invalid_source", str(exc)) from exc
        active_device = choose_device(requested_device)
        active_settings = _analysis_settings(json.dumps(payload.get("analysis_settings", {})), thresholds)
        with live_lock:
            current = app.state.live_session
            if current and current.state in {"starting", "running", "stopping"}:
                raise ApiError(409, "live_session_busy", "A live session is already active or draining.")
            if not analysis_semaphore.acquire(blocking=False):
                raise ApiError(409, "analysis_busy", "Another inference task is running; retry after it finishes.")
            try:
                ensure_model(model, active_device)
                ensure_model(config.STAGE2_MODEL, active_device)
                session = LiveSession(source_type, safe_source, model, active_device, registry,
                                      active_settings, weights_dir, device_requested=requested_device,
                                      capture_factory=capture_factory,
                                      face_anonymizer_factory=face_anonymizer_factory)
                prepare_live_history(session, safe_source, source_type)
                session.on_finish = lambda: finish_live_history(session, analysis_semaphore.release)
                app.state.live_session = session
                session.start()
            except Exception:
                analysis_semaphore.release()
                raise
        return {"status": "starting", "device_requested": requested_device,
                "device_used": active_device,
                "device_components": {"yolo": active_device, "x3d": active_device, "yunet": "cpu"},
                "source_type": source_type,
                "session_id": session.session_id}

    @app.post("/api/live/start-upload")
    async def live_start_upload(file: UploadFile = File(...), model: str = Form("yolov8n"),
                                device: str = Form("auto")):
        """Replay a browser-selected video. The temporary upload is deleted when the session ends."""
        suffix = Path(file.filename or "").suffix.lower()
        if suffix not in config.VIDEO_EXTENSIONS:
            raise ApiError(400, "invalid_source", "เลือกไฟล์วิดีโอ MP4, AVI, MOV หรือ MKV")
        if model not in config.STAGE1_MODELS:
            raise ApiError(400, "invalid_parameter", "model must be yolov8n or yolov8s")

        temp_dir = Path(tempfile.gettempdir()) / "cctv-safety-live"
        temp_dir.mkdir(parents=True, exist_ok=True)
        uploaded_path = temp_dir / f"{uuid.uuid4().hex}{suffix}"
        total = 0
        try:
            with uploaded_path.open("wb") as output:
                while chunk := await file.read(1024 * 1024):
                    total += len(chunk)
                    if total > config.MAX_UPLOAD_BYTES:
                        raise ApiError(413, "file_too_large", "วิดีโอต้องมีขนาดไม่เกิน 100 MB")
                    output.write(chunk)
            if total == 0:
                raise ApiError(400, "invalid_source", "ไฟล์วิดีโอว่างเปล่า")

            active_device = choose_device(device)
            active_settings = _analysis_settings("{}", thresholds)
            with live_lock:
                current = app.state.live_session
                if current and current.state in {"starting", "running", "stopping"}:
                    raise ApiError(409, "live_session_busy", "A live session is already active or draining.")
                if not analysis_semaphore.acquire(blocking=False):
                    raise ApiError(409, "analysis_busy", "Another inference task is running; retry after it finishes.")
                try:
                    ensure_model(model, active_device)
                    ensure_model(config.STAGE2_MODEL, active_device)
                    session = LiveSession("file", str(uploaded_path), model, active_device, registry,
                                          active_settings, weights_dir, device_requested=device,
                                          capture_factory=capture_factory,
                                          face_anonymizer_factory=face_anonymizer_factory)
                    def cleanup_upload():
                        try:
                            uploaded_path.unlink(missing_ok=True)
                        finally:
                            analysis_semaphore.release()
                    prepare_live_history(session, file.filename, "replay")
                    session.on_finish = lambda: finish_live_history(session, cleanup_upload)
                    app.state.live_session = session
                    session.start()
                except Exception:
                    analysis_semaphore.release()
                    raise
            return {"status": "starting", "device_requested": device,
                    "device_used": active_device,
                    "device_components": {"yolo": active_device, "x3d": active_device, "yunet": "cpu"},
                    "source_type": "file",
                    "session_id": session.session_id}
        except Exception:
            uploaded_path.unlink(missing_ok=True)
            raise
        finally:
            await file.close()

    @app.post("/api/live/stop")
    def live_stop():
        session = app.state.live_session
        if not session:
            raise ApiError(404, "live_session_missing", "No live session exists.")
        session.stop()
        return {"status": session.state, **session.status()}

    @app.get("/api/live/status")
    def live_status():
        session = app.state.live_session
        return {"status": "idle", "device_requested": None, "device_used": None,
                "device_components": None, "session_id": None} if not session else {"status": session.state, **session.status()}

    @app.websocket("/api/live/events")
    async def live_events(websocket: WebSocket, session_id: str | None = None):
        await websocket.accept()
        session = app.state.live_session
        if session is None:
            await websocket.send_json({"type": "health", "state": "idle"})
            await websocket.close()
            return
        if session_id is not None and session_id != session.session_id:
            await websocket.send_json({"type": "health", "state": "error",
                                       "reason": "session_mismatch", "session_id": session_id})
            await websocket.close(code=1008)
            return
        try:
            while True:
                if session.wait(0) and session._events.empty():
                    await websocket.send_json({"type": "health", **session.status()})
                    await websocket.close(code=1000)
                    return
                try:
                    event = await asyncio.to_thread(session._events.get, True, 0.25)
                except queue.Empty:
                    event = {"type": "health", **session.status()}
                await websocket.send_json(event)
                if event.get("type") == "health" and event.get("state") in {"stopped", "error", "degraded"}:
                    await websocket.close(code=1000)
                    return
        except (WebSocketDisconnect, RuntimeError):
            return

    @app.post("/api/stage1/analyze")
    def stage1_analyze(
        _analysis_slot: None = Depends(analysis_slot),
        file: UploadFile | None = File(None),
        model: str | None = Form(None),
        max_frames: str | None = Form(None),
        mode: str | None = Form(None),
        sample_fps: str | None = Form(None),
        face_confidence: str | None = Form(None),
        face_padding: str | None = Form(None),
        face_blur_strength: str | None = Form(None),
        analysis_settings: str | None = Form(None),
        device: str | None = Form("auto"),
    ):
        actual_device = choose_device(device)
        kind, size = _check_upload(file)
        if model not in config.STAGE1_MODELS:
            raise ApiError(400, "invalid_parameter",
                           f"'model' must be one of {list(config.STAGE1_MODELS)}; got {model!r}.")
        mode_used = mode.strip() if mode is not None and mode.strip() != "" else "frames"
        if mode_used not in config.STAGE1_MODES:
            raise ApiError(400, "invalid_parameter",
                           f"'mode' must be one of {list(config.STAGE1_MODES)}; got {mode!r}.")
        dense = mode_used == "dense"
        limit = config.DEFAULT_MAX_FRAMES
        fps_used = config.DEFAULT_SAMPLE_FPS
        if not dense and max_frames is not None and max_frames.strip() != "":
            try:
                limit = int(max_frames.strip())
            except ValueError:
                limit = -1
            if not 1 <= limit <= config.MAX_FRAMES_LIMIT:
                raise ApiError(400, "invalid_parameter",
                               f"'max_frames' must be an integer in 1..{config.MAX_FRAMES_LIMIT}; got {max_frames!r}.")
        if dense and sample_fps is not None and sample_fps.strip() != "":
            try:
                fps_used = float(sample_fps.strip())
            except ValueError:
                fps_used = float("nan")
            if not (math.isfinite(fps_used) and config.MIN_SAMPLE_FPS <= fps_used <= config.MAX_SAMPLE_FPS):
                raise ApiError(400, "invalid_parameter",
                               f"'sample_fps' must be a number in {config.MIN_SAMPLE_FPS:g}..{config.MAX_SAMPLE_FPS:g}; "
                               f"got {sample_fps!r}.")
        _check_kind_and_size(file, kind, size)
        if dense and kind != "video":
            raise ApiError(422, "video_required",
                           "Stage 1 dense mode needs a video file (mp4, avi, mov, mkv); an image was uploaded. "
                           "Use mode=frames for images.")
        privacy_settings = _privacy_settings(face_confidence, face_padding, face_blur_strength)
        active_settings = _analysis_settings(analysis_settings, thresholds)
        active_thresholds = active_settings["yolo"]["thresholds"]
        ppe_confidence = min(active_thresholds["person"], active_thresholds["helmet"], active_thresholds["vest"])
        ensure_model(model, actual_device)
        face_anonymizer = face_anonymizer_factory(weights_dir, **privacy_settings, device="cpu")

        frames: list[dict] = []
        info = None
        path = media.save_to_temp(file.file, Path(file.filename).suffix.lower(), config.MAX_UPLOAD_BYTES)
        try:
            if kind == "image":
                frame = media.decode_image(path)
                height, width = frame.shape[:2]
                (detections,) = stage1_on_device(model, [frame], active_thresholds, {k: active_settings["yolo"][k] for k in ("iou", "imgsz", "max_det")}, actual_device)
                safe_frame, _ = anonymize(face_anonymizer, frame)
                frames.append(_frame_entry(0, None, media.encode_jpeg_b64(safe_frame), detections, ppe_confidence))
            elif not dense:
                info = media.probe_video(path)
                width, height = info.width, info.height
                indices = media.stage1_indices(info.frame_count, limit)
                decoded = media.read_frames(path, indices)
                per_frame = stage1_on_device(model, [decoded[index] for index in indices], active_thresholds, {k: active_settings["yolo"][k] for k in ("iou", "imgsz", "max_det")}, actual_device)
                for index, detections in zip(indices, per_frame):
                    safe_frame, _ = anonymize(face_anonymizer, decoded[index])
                    frames.append(_frame_entry(index, _r(index / info.fps),
                                               media.encode_jpeg_b64(safe_frame), detections, ppe_confidence))
            else:
                info = media.probe_video(path)
                width, height = info.width, info.height
                if len(media.stage2_windows(info.duration_s)) > config.MAX_WINDOWS:
                    raise _too_long(info)
                # Detect while reading, in small batches: no full-res frame list, no JPEG encoding.
                batch: list = []
                for item in media.iter_frames(path, media.dense_indices(info, fps_used)):
                    batch.append(item)
                    if len(batch) >= config.DENSE_BATCH:
                        frames.extend(_detect_batch(model, batch, info, active_settings["yolo"], ppe_confidence, actual_device))
                        batch = []
                if batch:
                    frames.extend(_detect_batch(model, batch, info, active_settings["yolo"], ppe_confidence, actual_device))
        finally:
            media.remove_quietly(path)

        result = {
            **_envelope(model),
            "detector_schema_version": DETECTOR_SCHEMA_VERSION,
            "class_names": list(CLASS_NAMES),
            "media_type": kind,
            "source": _source(width, height, info),
            "thresholds": {name: _r(value) for name, value in active_thresholds.items()},
            "ppe_min_confidence": _r(ppe_confidence),
            "analysis_settings": active_settings,
            "device_requested": device or "auto", "device_used": actual_device,
            "mode": mode_used,
            "sample_fps": _r(fps_used) if dense else None,
            "frames": frames,
        }
        store.save_analysis(file.filename, stage1=result)
        return result

    def _detect_batch(model: str, batch: list, info: media.VideoInfo, yolo_settings=None, ppe_confidence=None, device="cpu") -> list[dict]:
        yolo_settings = yolo_settings or {"thresholds": thresholds, "iou": 0.7, "imgsz": 640, "max_det": 300}
        ppe_confidence = ppe_confidence if ppe_confidence is not None else ppe_min_confidence
        options = {key: yolo_settings[key] for key in ("iou", "imgsz", "max_det")}
        per_frame = stage1_on_device(model, [frame for _, frame in batch], yolo_settings["thresholds"], options, device)
        return [_frame_entry(index, _r(index / info.fps), None, detections, ppe_confidence)
                for (index, _), detections in zip(batch, per_frame)]

    def _frame_entry(index: int, time_s, jpeg_b64, detections, ppe_confidence=None) -> dict:
        ordered = sorted(detections, key=lambda item: item.confidence, reverse=True)
        ppe_rows = assess_ppe(ordered, ppe_confidence if ppe_confidence is not None else ppe_min_confidence)
        for row in ppe_rows:
            row["person_confidence"] = _r(row["person_confidence"])
        return {
            "index": int(index),
            "time_s": time_s,
            "image_jpeg_b64": jpeg_b64,
            "detections": [
                {
                    "class_id": CLASS_TO_ID[item.class_name],
                    "class_name": item.class_name,
                    "confidence": _r(item.confidence),
                    "xyxy": [_r(value) for value in item.xyxy],
                }
                for item in ordered
            ],
            "ppe": ppe_rows,
        }

    @app.post("/api/stage2/analyze")
    def stage2_analyze(
        _analysis_slot: None = Depends(analysis_slot),
        file: UploadFile | None = File(None), analysis_settings: str | None = Form(None),
        device: str | None = Form("auto"),
    ):
        actual_device = choose_device(device)
        active_settings = _analysis_settings(analysis_settings, thresholds)
        kind, size = _check_upload(file)
        _check_kind_and_size(file, kind, size)
        if kind != "video":
            raise ApiError(422, "video_required",
                           "Stage 2 (X3D-S fight classifier) needs a video file (mp4, avi, mov, mkv); "
                           "an image was uploaded.")
        ensure_model(config.STAGE2_MODEL, actual_device)

        path = media.save_to_temp(file.file, Path(file.filename).suffix.lower(), config.MAX_UPLOAD_BYTES)
        try:
            info = media.probe_video(path)
            spans = media.stage2_windows(info.duration_s)
            if len(spans) > config.MAX_WINDOWS:
                raise _too_long(info)
            clip_indices = [media.window_frame_indices(start, end, info) for start, end in spans]
            decoded = media.read_frames(path, [i for clip in clip_indices for i in clip], media.letterbox_bgr)
        finally:
            media.remove_quietly(path)

        clips = [[decoded[i] for i in clip] for clip in clip_indices]
        probs = stage2_on_device(clips, actual_device)
        windows = []
        for index, ((start, end), (p_non, p_fight)) in enumerate(zip(spans, probs)):
            windows.append({
                "index": index,
                "start_s": _r(start),
                "end_s": _r(end),
                "probs": {"non_fight": _r(p_non), "fight": _r(p_fight)},
                "label": STAGE2_CLASS_NAMES[1] if p_fight > active_settings["x3d"]["fight_threshold"] else STAGE2_CLASS_NAMES[0],
            })
        result = {
            **_envelope(config.STAGE2_MODEL),
            "device_requested": device or "auto", "device_used": actual_device,
            "source": _source(info.width, info.height, info),
            "class_names": list(STAGE2_CLASS_NAMES),
            "frames_per_window": FRAMES,
            "window_s": config.WINDOW_S,
            "fight_threshold": active_settings["x3d"]["fight_threshold"],
            "analysis_settings": active_settings,
            "windows": windows,
            "summary": {
                "max_fight_prob": max(window["probs"]["fight"] for window in windows),
                "fight_windows": sum(1 for window in windows if window["label"] == "fight"),
                "total_windows": len(windows),
            },
        }
        store.save_analysis(file.filename, stage2=result)
        return result

    @app.post("/api/pipeline/analyze")
    def pipeline_analyze(
        _analysis_slot: None = Depends(analysis_slot),
        file: UploadFile | None = File(None),
        model: str | None = Form(None),
        sample_fps: str | None = Form(None),
        face_confidence: str | None = Form(None),
        face_padding: str | None = Form(None),
        face_blur_strength: str | None = Form(None),
        analysis_settings: str | None = Form(None),
        device: str | None = Form("auto"),
    ):
        """Run YOLO and X3D as one auditable shadow-mode pipeline.

        X3D is evaluated on every window while the person-trigger is measured,
        so a missed person cannot silently suppress a possible fight result.
        """
        pipeline_started = perf_counter()
        actual_device = choose_device(device)
        decode_timings: dict[str, float] = {}
        metadata_ms = 0.0
        stage2_decode_ms = 0.0
        preview_encode_ms = 0.0
        kind, size = _check_upload(file)
        if model not in config.STAGE1_MODELS:
            raise ApiError(400, "invalid_parameter",
                           f"'model' must be one of {list(config.STAGE1_MODELS)}; got {model!r}.")
        try:
            fps_used = float(sample_fps.strip()) if sample_fps and sample_fps.strip() else config.DEFAULT_SAMPLE_FPS
        except ValueError:
            fps_used = float("nan")
        if not (math.isfinite(fps_used) and config.MIN_SAMPLE_FPS <= fps_used <= config.MAX_SAMPLE_FPS):
            raise ApiError(400, "invalid_parameter",
                           f"'sample_fps' must be a number in {config.MIN_SAMPLE_FPS:g}..{config.MAX_SAMPLE_FPS:g}.")
        _check_kind_and_size(file, kind, size)
        if kind != "video":
            raise ApiError(422, "video_required", "The combined pipeline requires a video file.")
        privacy_settings = _privacy_settings(face_confidence, face_padding, face_blur_strength)
        active_settings = _analysis_settings(analysis_settings, thresholds)
        active_thresholds = active_settings["yolo"]["thresholds"]
        ppe_confidence = min(active_thresholds["person"], active_thresholds["helmet"], active_thresholds["vest"])
        ensure_model(model, actual_device)
        ensure_model(config.STAGE2_MODEL, actual_device)
        face_anonymizer = face_anonymizer_factory(weights_dir, **privacy_settings, device="cpu")

        path = media.save_to_temp(file.file, Path(file.filename).suffix.lower(), config.MAX_UPLOAD_BYTES)
        try:
            metadata_start = perf_counter()
            info = media.probe_video(path)
            metadata_ms += (perf_counter() - metadata_start) * 1000
            spans = media.stage2_windows(info.duration_s)
            if len(spans) > config.MAX_WINDOWS:
                raise _too_long(info)

            # Scan every decoded display frame for faces. YOLO still receives the original
            # sampled frames; only encoded/display pixels are anonymized.
            indices = media.dense_indices(info, fps_used)
            selected = set(indices)
            stage1_frames: list[dict] = []
            batch: list = []
            faces_by_frame: list[list[list[int]]] = []
            first_safe_jpeg = None
            face_scan_start = perf_counter()
            face_detection_ms = 0.0
            yolo_batch_ms = 0.0
            for index, frame in media.iter_video_frames(path, decode_timings):
                detect_start = perf_counter()
                boxes = face_anonymizer.detect(frame)
                face_detection_ms += (perf_counter() - detect_start) * 1000
                faces_by_frame.append(boxes)
                if index == 0:
                    encode_start = perf_counter()
                    first_safe_jpeg = media.encode_jpeg_b64(
                        face_anonymizer.blur(frame, boxes, privacy_settings["blur_strength"])
                    )
                    preview_encode_ms += (perf_counter() - encode_start) * 1000
                if index in selected:
                    batch.append((index, frame))
                    if len(batch) >= config.DENSE_BATCH:
                        yolo_start = perf_counter()
                        stage1_frames.extend(_detect_batch(model, batch, info, active_settings["yolo"], ppe_confidence, actual_device))
                        yolo_batch_ms += (perf_counter() - yolo_start) * 1000
                        batch = []
            if batch:
                yolo_start = perf_counter()
                stage1_frames.extend(_detect_batch(model, batch, info, active_settings["yolo"], ppe_confidence, actual_device))
                yolo_batch_ms += (perf_counter() - yolo_start) * 1000
            face_scan_wall_ms = round(max(0.0, (perf_counter() - face_scan_start) * 1000 - yolo_batch_ms), 2)
            if len(faces_by_frame) != info.frame_count or first_safe_jpeg is None:
                raise ApiError(422, "anonymization_incomplete",
                               "Face anonymization did not process every video frame; no original video was shown.")
            faces_by_frame = bridge_short_face_gaps(
                faces_by_frame, info.width, info.height
            )

            # Stage 2: classify every 2 s window, independent of the trigger.
            clip_indices = [media.window_frame_indices(start, end, info) for start, end in spans]
            decode_start = perf_counter()
            decoded = media.read_frames(path, [i for clip in clip_indices for i in clip], media.letterbox_bgr)
            stage2_decode_ms += (perf_counter() - decode_start) * 1000
        finally:
            media.remove_quietly(path)

        clips = [[decoded[i] for i in clip] for clip in clip_indices]
        x3d_start = perf_counter()
        probs = stage2_on_device(clips, actual_device)
        x3d_ms = (perf_counter() - x3d_start) * 1000
        add_track_ids(stage1_frames, info.width, info.height, active_settings["tracking"]["max_track_gap_s"])
        s2_windows = []
        combined_windows = []
        for index, ((start, end), (p_non, p_fight)) in enumerate(zip(spans, probs)):
            label = STAGE2_CLASS_NAMES[1] if p_fight > active_settings["x3d"]["fight_threshold"] else STAGE2_CLASS_NAMES[0]
            fall_frames = [
                frame for frame in stage1_frames
                if start <= (frame["time_s"] or 0.0) < end
                and any(det["class_name"] == "fall" for det in frame["detections"])
            ]
            person_frames = [frame for frame in stage1_frames
                             if start <= (frame["time_s"] or 0.0) < end
                             and any(det["class_name"] == "person" for det in frame["detections"])]
            trigger_summary = summarize_window(stage1_frames, start, end, info.width, info.height,
                active_settings["tracking"]["proximity_diagonals"], active_settings["tracking"]["motion_diagonals_per_s"])
            # X3D only distinguishes fight/non-fight. A fall signal makes a raw
            # fight prediction ambiguous, so keep the model output but request review.
            if label == "fight" and fall_frames:
                decision, decision_label = "review_fall_fight_conflict", "ล้ม/Fight กำกวม · ตรวจสอบ"
            elif label == "fight":
                decision, decision_label = "fight_candidate", "สงสัย Fight · pilot"
            elif fall_frames:
                decision, decision_label = "fall_detected", "พบสัญญาณ Fall · ตรวจสอบ"
            else:
                decision, decision_label = "no_fight_candidate", "ไม่พบ Fight candidate"
            s2_windows.append({
                "index": index, "start_s": _r(start), "end_s": _r(end),
                "probs": {"non_fight": _r(p_non), "fight": _r(p_fight)}, "label": label,
            })
            combined_windows.append({
                "index": index, "start_s": _r(start), "end_s": _r(end),
                "person_triggered": bool(person_frames),
                "person_frames": len(person_frames),
                "fall_detected": bool(fall_frames),
                "fall_frames": len(fall_frames),
                "decision": decision,
                "decision_label": decision_label,
                **trigger_summary,
                "x3d_evaluated": True,
                "fight_probability": _r(p_fight),
                "x3d_label": label,
            })

        source = _source(info.width, info.height, info)
        stage1 = {
            **_envelope(model), "detector_schema_version": DETECTOR_SCHEMA_VERSION,
            "class_names": list(CLASS_NAMES), "media_type": "video", "source": source,
            "thresholds": {name: _r(value) for name, value in active_thresholds.items()},
            "ppe_min_confidence": _r(ppe_confidence), "mode": "dense",
            "analysis_settings": active_settings,
            "sample_fps": _r(fps_used), "frames": stage1_frames,
        }
        fight_windows = sum(window["label"] == "fight" for window in s2_windows)
        stage2 = {
            **_envelope(config.STAGE2_MODEL), "source": source,
            "class_names": list(STAGE2_CLASS_NAMES), "frames_per_window": FRAMES,
            "window_s": config.WINDOW_S, "windows": s2_windows,
            "fight_threshold": active_settings["x3d"]["fight_threshold"],
            "analysis_settings": active_settings,
            "summary": {
                "max_fight_prob": max(window["probs"]["fight"] for window in s2_windows),
                "fight_windows": fight_windows, "total_windows": len(s2_windows),
            },
        }
        response_started = perf_counter()
        response = {
            "device_requested": device or "auto", "device_used": actual_device,
            "pipeline_mode": "tracking_trigger_shadow",
            "trigger": "candidate if person proximity or multi-person motion is observed",
            "trigger_parameters": {
                "proximity_max_distance_frame_diagonals": active_settings["tracking"]["proximity_diagonals"],
                "motion_min_speed_frame_diagonals_per_s": active_settings["tracking"]["motion_diagonals_per_s"],
                "track_max_gap_s": active_settings["tracking"]["max_track_gap_s"],
            },
            "x3d_policy": "evaluate_every_window_shadow_mode",
            "face_blur": {
                "complete": True,
                "model": "OpenCV YuNet (local)",
                "settings": privacy_settings,
                "frame_count": len(faces_by_frame),
                "faces_detected": sum(len(boxes) for boxes in faces_by_frame),
                "detection_ms": round(face_detection_ms, 2),
                "scan_wall_ms": face_scan_wall_ms,
                "faces_by_frame": faces_by_frame,
            },
            "preview_jpeg_b64": first_safe_jpeg,
            "stage1": stage1,
            "stage2": stage2,
            "pipeline": {
                "source": source,
                "windows": combined_windows,
                "summary": {
                    "total_windows": len(combined_windows),
                    "person_triggered_windows": sum(w["person_triggered"] for w in combined_windows),
                    "candidate_triggered_windows": sum(w["candidate_triggered"] for w in combined_windows),
                    "fight_windows": fight_windows,
                    "fight_windows_without_candidate_trigger": sum(
                        w["x3d_label"] == "fight" and not w["candidate_triggered"] for w in combined_windows
                    ),
                    "review_fall_fight_conflict_windows": sum(
                        w["decision"] == "review_fall_fight_conflict" for w in combined_windows
                    ),
                    "fight_candidate_windows": sum(
                        w["decision"] == "fight_candidate" for w in combined_windows
                    ),
                    "fall_detected_windows": sum(w["fall_detected"] for w in combined_windows),
                },
            },
        }
        response["timings_ms"] = {
            "video_decode_ms": round(decode_timings.get("decode_ms", 0.0) + metadata_ms + stage2_decode_ms, 2),
            "face_detection_ms": round(face_detection_ms, 2),
            "face_scan_wall_ms": face_scan_wall_ms,
            "yolo_ms": round(yolo_batch_ms, 2),
            "x3d_ms": round(x3d_ms, 2),
            "preview_encode_ms": round(preview_encode_ms, 2),
            "response_assembly_ms": round((perf_counter() - response_started) * 1000, 2),
            "total_ms": round((perf_counter() - pipeline_started) * 1000, 2),
        }
        store.save_analysis(file.filename, stage1=stage1, stage2=stage2, pipeline=response["pipeline"])
        return response

    api_methods: dict[str, set[str]] = {}
    for route in app.routes:
        path = getattr(route, "path", "")
        if path.startswith("/api/"):
            api_methods.setdefault(path, set()).update(getattr(route, "methods", None) or ())

    @app.api_route("/api/{rest:path}", methods=["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
                   include_in_schema=False)
    def api_fallback(rest: str):
        """Unknown /api/ paths and wrong methods get the contract error body (before the static mount)."""
        allowed = api_methods.get(f"/api/{rest}")
        if allowed:
            raise StarletteHTTPException(405, headers={"Allow": ", ".join(sorted(allowed))})
        raise StarletteHTTPException(404)

    if config.STATIC_DIR.is_dir():
        app.mount("/", StaticFiles(directory=str(config.STATIC_DIR), html=True), name="mockup")
    return app


app = create_app()
