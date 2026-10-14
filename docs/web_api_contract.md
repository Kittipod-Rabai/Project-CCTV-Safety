# Web API contract — Upload & Analyze (v1, `schema_version` "1.0")

`schema_version` stays `"1.0"`: additive request/response settings retain defaults for existing clients. Pixels displayed by the current web UI are anonymized with local YuNet face detection; dense pipeline video includes face boxes for every decoded frame, while image/frame JPEGs contain blurred pixels.

Educational pilot only. A single-stream replay/RTSP Live pilot endpoint is available separately; file replay is the current test path. RTSP has not been validated against a target camera because no camera is available, and neither Live nor Upload & Analyze is production-ready.
Example responses: `tests/fixtures/api/*.json` (they conform exactly to this document).

## 0. Conventions

- All bodies are JSON (`application/json; charset=utf-8`). Numbers are JSON numbers; `float` values are rounded to 4 decimals.
- **Coordinates:** `xyxy` = `[x1, y1, x2, y2]`, `float`, **pixels in the coordinate system of the original source frame** (`source.width` × `source.height`, origin top-left, x right, y down), `0 <= x1 < x2 <= width`, `0 <= y1 < y2 <= height`. Never letterboxed/model-input coordinates, never normalised.
- **Time:** every `*_s` field is seconds (`float`), measured from the start of the video.
- **Images in responses:** `image_jpeg_b64` = standard base64 (RFC 4648, with `=` padding) of a full-resolution JPEG with detected faces blurred and no detection annotations. **No** `data:image/jpeg;base64,` prefix — the client adds it. Detection boxes are drawn by the browser.
- "Nullable: no" means the key is always present and never `null`. Keys are never omitted.
- Unknown extra request fields are ignored.

### 0.1 Common envelope (analyze responses and health)

| Field | Type | Nullable | Notes |
|---|---|---|---|
| `is_model_output` | bool | no | `true` on both analyze endpoints. `false` on `/api/health` (it carries no model output). |
| `model` | string | health: yes (`null`); analyze: no | `"yolov8n"` \| `"yolov8s"` (Stage 1), `"x3d_s"` (Stage 2) |
| `schema_version` | string | no | This contract's version: `"1.0"` |
| `disclaimer` | string | no | Fixed text below, identical in every response |

Disclaimer (exact string):

```text
ต้นแบบเพื่อการศึกษา (pilot) ฝึกด้วยชุดข้อมูลสาธารณะเท่านั้น ไม่ใช่ระบบใช้งานจริง และยังไม่ได้ตรวจสอบความถูกต้องกับกล้อง CCTV เป้าหมาย / Educational pilot trained on public datasets only. Not a production system and not validated on the target CCTV cameras.
```

Error responses do **not** use the envelope (see section 4).

### 0.2 Uploads (both analyze endpoints)

- `multipart/form-data`; file field name **`file`** (exactly one file).
- Media type is decided by the **file extension** (case-insensitive); the part's `Content-Type` is not trusted.
  - Image: `.jpg .jpeg .png .bmp .webp` (`image/jpeg`, `image/png`, `image/bmp`, `image/webp`)
  - Video: `.mp4 .avi .mov .mkv` (`video/mp4`, `video/x-msvideo`, `video/quicktime`, `video/x-matroska`)
  - Any other extension → `415 unsupported_media_type`.
- Size limit **100 MB** (104 857 600 bytes) per file → above it `413 file_too_large`.
- Decoded size limits: images ≤ 40,000,000 pixels and video frames ≤ 16,777,216 pixels (4K supported); exceeding a limit returns `413 media_dimensions_too_large`.
- At most one analysis request runs per server process; another concurrent analysis returns `429 analysis_busy`. Multipart data may already be spooled by the server before this inference gate runs.
- A file with an allowed extension that OpenCV/Pillow cannot decode (or a video with 0 decodable frames or fps <= 0) → `422 decode_failed`. Codec support depends on the local OpenCV build; mp4/avi/mov are expected to work.
- Optional privacy fields: `face_confidence` (0.20..0.90, default 0.35), `face_padding` (0..0.50, default 0.25), and `face_blur_strength` (0.40..1.50, default 0.80). Lower confidence accepts weaker face detections; greater padding/strength obscures more area. The detector still processes every frame and cannot be disabled from this endpoint.
- Optional `analysis_settings`: JSON string with YOLO thresholds/inference controls, X3D fight probability cutoff, and experimental tracking/trigger parameters. Omitted values use the defaults below; invalid values return `400 invalid_parameter`. Per-class YOLO confidence defaults to `configs/thresholds.yaml`; inference defaults are IoU `0.7`, image size `640`, max detections `300`. X3D fight cutoff defaults to `0.5`. Tracking defaults are proximity `0.16` frame diagonals, motion `0.25` diagonals/s, track gap `0.75` s. Bounds are checked server-side. These controls affect inference/decision rules, not trained model weights; changing them does not retrain or calibrate a model.
- Optional `device`: `auto` (default), `cpu`, or `cuda`. `auto` selects CUDA for YOLO/X3D when PyTorch CUDA is available; YuNet remains on CPU in the current mixed runtime. Explicit `cuda` requires CUDA-enabled PyTorch and otherwise returns `503 device_unavailable`. The response reports `device_requested` and `device_used`.

## Live pilot endpoints

- `POST /api/live/start` accepts JSON `{source_type:"file"|"rtsp", source, model:"yolov8n"|"yolov8s", device:"auto"|"cpu"|"cuda"}`. Replay files must be below repository `data/`; only one stream can run. The RTSP source is never echoed in responses. Do not log the request body because it may contain credentials.
- `POST /api/live/start-upload` accepts a browser-selected video as multipart `file`, plus optional `model` and `device`. It is limited to 100 MB and supported video extensions; the temporary file is deleted when the session ends. If the process exits before cleanup, UUID-named replay files older than 24 hours are removed at the next startup.
- `POST /api/live/stop` requests stop and drains already-received frames. `GET /api/live/status` reports state, device components, frame counters, replay mode, average processing FPS and rolling timings without the source URI. Timing names are `decode`, `face`, `yolo`, `x3d`, `preview_encode`, and `frame_total`; each reports the latest and mean milliseconds over up to 120 recent samples.
- `WS /api/live/events` emits fail-closed anonymized preview images, preliminary candidate events, X3D window results and health (including rolling stage timings). A candidate is not a confirmed event. File replay slows under back-pressure to preserve received frames; a real-time source that cannot keep up ends in `degraded`. That state must not be interpreted as no incident.

Example `analysis_settings` value:

```json
{"yolo":{"thresholds":{"person":0.25,"helmet":0.2,"vest":0.2,"fall":0.2,"fire":0.2,"smoke":0.2},"iou":0.7,"imgsz":640,"max_det":300},"x3d":{"fight_threshold":0.5},"tracking":{"proximity_diagonals":0.16,"motion_diagonals_per_s":0.25,"max_track_gap_s":0.75}}
```

### 0.3 `source` object (Stage 1 and Stage 2)

| Field | Type | Units | Nullable | Notes |
|---|---|---|---|---|
| `width` | int | px | no | Original frame width |
| `height` | int | px | no | Original frame height |
| `fps` | float | frames/s | image: `null` | Video frame rate reported by the decoder |
| `frame_count` | int | frames | image: `null` | Total frames in the video |
| `duration_s` | float | s | image: `null` | `frame_count / fps` |

## 1. `GET /api/health`

Never loads models; only reports state. Always `200` while the server is up.

| Field | Type | Nullable | Notes |
|---|---|---|---|
| envelope | — | — | `is_model_output: false`, `model: null` |
| `status` | string | no | Always `"ok"` |
| `device` | string | no | e.g. `"cuda:0"` or `"cpu"` |
| `models` | object | no | Keys exactly `yolov8n`, `yolov8s`, `x3d_s`; each value `"loaded"` (in memory) \| `"available"` (weights file present, not loaded yet) \| `"missing"` (weights file absent) |

Fixture: `health.json`.

## 2. `POST /api/stage1/analyze` — YOLOv8 detector (image or video)

Form fields:

| Name | Type | Required | Default | Notes |
|---|---|---|---|---|
| `file` | file | yes | — | Image or video (0.2) |
| `model` | string | yes | — | `yolov8n` \| `yolov8s`; else `400 invalid_parameter` |
| `max_frames` | int | no | `16` | `1..60` inclusive; else `400 invalid_parameter`. Validated in `frames` mode, including images, though images do not use it. Ignored (not validated) in `dense` mode |
| `mode` | string | no | `"frames"` | `"frames"` (sampled frames with JPEGs, the v1 behaviour) \| `"dense"` (video only, boxes only, for playback overlay); anything else → `400 invalid_parameter` |
| `sample_fps` | float | no | `10` | Dense mode only: finite number in `1..30` inclusive (e.g. `"10"`, `"12.5"`); else `400 invalid_parameter`. Ignored (not validated) in `frames` mode |
| `analysis_settings` | JSON string | no | see 0.2 | Per-request settings for all model and trigger controls |

Empty-string form values count as "not sent" and get the default. The `mode` value has surrounding whitespace trimmed before it is checked.

Response `200`:

| Field | Type | Nullable | Notes |
|---|---|---|---|
| envelope | — | — | `is_model_output: true`, `model` = requested model |
| `detector_schema_version` | int | no | `2` (`cctv_safety/schema.py` `DETECTOR_SCHEMA_VERSION`) |
| `class_names` | string[] | no | `["person","helmet","vest","fall","fire","smoke"]`; `class_id` is the index in this list |
| `media_type` | string | no | `"image"` \| `"video"` |
| `source` | object | no | Section 0.3 |
| `thresholds` | object | no | Per-class min confidence used (from `configs/thresholds.yaml`); keys exactly `class_names` |
| `ppe_min_confidence` | float | no | `min(thresholds.person, thresholds.helmet, thresholds.vest)`; passed to `assess_ppe` (same as `scripts/infer.py`) |
| `mode` | string | no | `"frames"` \| `"dense"` (the mode actually used; images are always `"frames"`) |
| `sample_fps` | float | `frames` mode: `null` | Dense mode: the `sample_fps` used (rounded to 4 decimals) |
| `frames` | Frame[] | no | Ordered by `index` ascending; never empty |

Frame selection, `mode = "frames"` (default; unchanged from v1):
- **Image:** exactly one frame: `index: 0`, `time_s: null`.
- **Video:** `n = min(max_frames, frame_count)`; indices = unique values of `round(linspace(0, frame_count-1, n))` (so the first and last frames are always included); `time_s = index / fps`.

Frame selection, `mode = "dense"` (video only):
- An image upload → `422 video_required`. A video that Stage 2 would split into more than 30 windows (section 3, roughly `D >= 61 s`) → `422 video_too_long`.
- Sample times `t_k = k / sample_fps` for `k = 0, 1, …` while `t_k < duration_s` (`duration_s = frame_count / fps`).
- Frame index per sample, exactly (Python, round-half-to-even): `min(int(round(k / sample_fps * fps)), frame_count - 1)`; duplicates are removed (first occurrence kept). So `sample_fps >= fps` yields every frame.
- `time_s = index / fps` (as in frames mode); `image_jpeg_b64` is `null` for every frame (the browser plays the original file and draws boxes over it).
- Example: 8.0 s at 30 fps with `sample_fps = 10` → 80 frames, indices `0, 3, 6, …, 237`, `time_s` `0.0, 0.1, …, 7.9`.

Frame:

| Field | Type | Units | Nullable | Notes |
|---|---|---|---|---|
| `index` | int | frame number | no | 0-based frame number in the source video (`0` for images) |
| `time_s` | float | s | image: `null`; video: no | |
| `image_jpeg_b64` | string | — | `frames` mode: no; `dense` mode: always `null` | Raw frame JPEG, base64, no `data:` prefix (section 0) |
| `detections` | Detection[] | — | no | Only boxes with `confidence >= thresholds[class_name]`; sorted by `confidence` descending; may be `[]` |
| `ppe` | PpeRow[] | — | no | Output of `cctv_safety.ppe.assess_ppe(detections, ppe_min_confidence)` unchanged; may be `[]` |

After confidence filtering, the pilot detector suppresses a `person` box only when
it spans at least 90% of frame height, at least 45% of frame width, touches both
top and bottom edges within 3%, and overlaps a `fall` box at IoU 0.20 or above.
This narrow geometry guard targets the oversized full-frame false positives seen
in the standing-to-fall clip; it is a heuristic and may suppress a real unusually
close person during a detected fall. Ordinary person boxes and all `fall` boxes
are preserved. It does not make the detector generally validated.

Detection:

| Field | Type | Notes |
|---|---|---|
| `class_id` | int | `0..5`, `CLASS_TO_ID[class_name]` |
| `class_name` | string | One of `class_names` |
| `confidence` | float | `0..1` |
| `xyxy` | float[4] | Source-frame pixels (section 0) |

PpeRow (exactly the keys produced by `assess_ppe`; these are **derived** events, not model classes):

| Field | Type | Notes |
|---|---|---|
| `person_index` | int | 0-based index among the frame's `person` detections with `confidence >= ppe_min_confidence`, in `detections` order (i.e. the n-th person in the list) |
| `person_confidence` | float | That person's confidence |
| `has_helmet` | bool | A helmet centre lies in the top 0–35 % of the person box |
| `has_vest` | bool | A vest centre lies in the 20–75 % band of the person box |
| `alerts` | string[] | Subset of `["no_helmet","no_vest"]` in that order; `[]` if compliant |
| `method` | string | `"ppe-centre-in-person-region"` |

Fixtures: `stage1_image.json`, `stage1_video.json` (requested with `max_frames=3`), `stage1_video_dense.json` (`mode=dense`, `sample_fps=10`, 1.0 s clip at 10 fps → 10 frames).

## 3. `POST /api/stage2/analyze` — X3D-S fight classifier (video only)

Form fields: `file` only (video). An image extension → `422 video_required`.

Windowing (`D = duration_s`, `W = 2.0`):
- Non-overlapping windows `[k·W, min((k+1)·W, D)]`, `k = 0, 1, …`.
- The final partial window is included only if its length is **>= 1.0 s**; otherwise those trailing frames are dropped.
- If `D < 2.0`, exactly one window `[0, D]` covering the whole clip (any length).
- More than **30** windows → `422 video_too_long` (i.e. roughly `D >= 61 s`).
- Per window: frames `round(start_s·fps) .. min(round(end_s·fps), frame_count) - 1`, of which 13 are taken with `round(linspace(first, last, 13))` (repeats allowed), then the plan's X3D-S preprocessing (letterbox 224, normalise).

Response `200`:

| Field | Type | Units | Nullable | Notes |
|---|---|---|---|---|
| envelope | — | — | — | `is_model_output: true`, `model: "x3d_s"` |
| `source` | object | — | no | Section 0.3 (video, so no nulls) |
| `class_names` | string[] | — | no | `["non_fight","fight"]` (logit index 0/1) |
| `frames_per_window` | int | frames | no | `13` |
| `window_s` | float | s | no | `2.0` (nominal window length) |
| `windows` | Window[] | — | no | Ordered by `start_s`; 1..30 entries |
| `summary` | object | — | no | See below |

Window:

| Field | Type | Units | Notes |
|---|---|---|---|
| `index` | int | — | 0-based window number |
| `start_s` | float | s | `index · 2.0` |
| `end_s` | float | s | `min(start_s + 2.0, duration_s)` |
| `probs` | object | — | `{non_fight: float, fight: float}` = `softmax(logits)`, each `0..1`, sum 1 (± rounding) |
| `label` | string | — | `class_names[argmax(logits)]`; tie → `"non_fight"` |

Summary:

| Field | Type | Notes |
|---|---|---|
| `max_fight_prob` | float | `max(windows[*].probs.fight)` |
| `fight_windows` | int | Count of windows with `label == "fight"` |
| `total_windows` | int | `len(windows)` |

Fixture: `stage2_video.json` (5.4 s clip → windows 0–2, 2–4, 4–5.4).

## 3.1 `POST /api/pipeline/analyze` — combined shadow-mode video evaluation

Form fields: `file` (video), `model` (`yolov8n` or `yolov8s`), and optional
`sample_fps` (1..30; default 10). The endpoint runs dense Stage 1 detections,
greedily associates person boxes across sampled frames using IoU and centre
distance, then calculates per-window proximity and centre-motion signals. A
candidate triggers when at least two detected people are within 0.16 frame
diagonals, or at least two people are present and one moves at 0.25 frame
diagonals/s or faster. Track association expires after 0.75 s. These are
exploratory defaults, not calibrated Fight thresholds.
The tracking implementation associates raw person detection boxes; it does not
confirm unique identities. Duplicate detections can create duplicate tracks and
can therefore influence the experimental trigger. `tracked_people` and
`max_concurrent_tracks` are track counts, not verified head counts.

This endpoint is intentionally **shadow mode**: it runs X3D on every window,
including windows without a candidate trigger. That keeps missed-trigger cases
visible while the trigger is evaluated. Its output must not be interpreted as
an optimized or production event pipeline.

Response shape:

```json
{
  "pipeline_mode": "tracking_trigger_shadow",
  "trigger": "candidate if person proximity or multi-person motion is observed",
  "trigger_parameters": {
    "proximity_max_distance_frame_diagonals": 0.16,
    "motion_min_speed_frame_diagonals_per_s": 0.25,
    "track_max_gap_s": 0.75
  },
  "x3d_policy": "evaluate_every_window_shadow_mode",
  "face_blur": {
    "complete": true,
    "model": "OpenCV YuNet (local)",
    "frame_count": 44,
    "faces_detected": 37,
    "detection_ms": 812.4,
    "scan_wall_ms": 1044.2,
    "faces_by_frame": [[[10, 20, 75, 95]], [], "... one list per source frame ..."]
  },
  "timings_ms": {
    "video_decode_ms": 1234.5,
    "face_detection_ms": 812.4,
    "face_scan_wall_ms": 1044.2,
    "yolo_ms": 52.1,
    "x3d_ms": 83.0,
    "preview_encode_ms": 4.2,
    "response_assembly_ms": 2.1,
    "total_ms": 2380.0
  },
  "preview_jpeg_b64": "<JPEG with faces blurred>",
  "stage1": { "...": "same response fields as Stage 1 dense mode" },
  "stage2": { "...": "same response fields as Stage 2" },
  "pipeline": {
    "source": { "...": "same source object" },
    "windows": [{
      "index": 0,
      "start_s": 0.0,
      "end_s": 2.0,
      "person_triggered": true,
      "person_frames": 5,
      "candidate_triggered": true,
      "trigger_reasons": ["people_in_close_proximity", "multi_person_motion"],
      "tracked_people": 2,
      "max_concurrent_tracks": 2,
      "proximity_frames": 4,
      "motion_frames": 2,
      "x3d_evaluated": true,
      "fight_probability": 0.82,
      "x3d_label": "fight",
      "fall_detected": true,
      "fall_frames": 2,
      "decision": "review_fall_fight_conflict",
      "decision_label": "ล้ม/Fight กำกวม · ตรวจสอบ"
    }],
    "summary": {
      "total_windows": 1,
      "person_triggered_windows": 1,
      "candidate_triggered_windows": 1,
      "fight_windows": 1,
      "fight_windows_without_candidate_trigger": 0,
      "review_fall_fight_conflict_windows": 1,
      "fight_candidate_windows": 0,
      "fall_detected_windows": 1
    }
  }
}
```

All frame selection, windowing, thresholds, and common error behavior match
sections 0–4. Person detections in `stage1.frames` also carry `track_id` and
`motion_diagonals_per_s`. There is no added temporal confidence threshold.
In the combined pipeline, an X3D `fight` label overlapping any sampled YOLO
`fall` detection is preserved as the raw model output but its pipeline decision
is `review_fall_fight_conflict`; the UI labels it ambiguous for human review.
Fight predictions without that conflict are `fight_candidate` (pilot output),
not a confirmed incident. `fight_windows` continues to count raw X3D predictions.

### Privacy display behavior

- YOLO/X3D use original decoded frames in local process memory. Stage 1 image/frame JPEGs are encoded only after YuNet face detection and blurring on a copy; model input arrays are not modified.
- `/api/pipeline/analyze` scans every decoded source frame and returns padded face boxes per frame and a blurred preview JPEG. The browser draws the hidden original video only into an opaque canvas and blurs each displayed frame. If metadata is incomplete or canvas drawing fails, the canvas is blacked out.
- YuNet reuses the configured input size while frame dimensions remain unchanged; it still runs face detection on every frame. This avoids repeatedly resetting an identical detector input shape without lowering scan frequency or changing the model input pixels.
- `timings_ms` separately records decoder reads (plus metadata/Stage 2 sampled decode), YuNet detector calls, total scan wall time, YOLO, X3D, first preview encoding, response assembly and total request time. It is diagnostic timing, not a latency guarantee; total can differ slightly from the sum because stages overlap or include orchestration.
- A missing/unloadable local YuNet model returns 503 `privacy_model_unavailable`. Processing errors do not trigger a raw-media display fallback. Uploaded temporary files are removed in the endpoint's `finally` block.
- YuNet may miss small, blurred, profile or occluded faces. This is a pilot privacy aid, not a guarantee of anonymization or PDPA compliance. Review representative footage manually before use.

Place `face_detection_yunet_2023mar.onnx` in the ignored `weights/` folder. It comes from [OpenCV Zoo face_detection_yunet](https://github.com/opencv/opencv_zoo/tree/main/models/face_detection_yunet), under MIT terms; see the upstream README for model-specific attribution. For a fresh checkout, download it from the upstream model asset:

```powershell
New-Item -ItemType Directory -Force weights | Out-Null
Invoke-WebRequest `
  -Uri https://media.githubusercontent.com/media/opencv/opencv_zoo/main/models/face_detection_yunet/face_detection_yunet_2023mar.onnx `
  -OutFile weights/face_detection_yunet_2023mar.onnx
```

`settings` echoes the applied privacy values. `detection_ms` sums YuNet call time across frames; `scan_wall_ms` measures the full decode/anonymization scan excluding interleaved YOLO batch calls. Both are separate from Stage 1/2 inference.

## 4. Errors

Every non-2xx response has exactly this body (no envelope):

```json
{"error": {"code": "<code>", "message": "<human-readable English text>"}}
```

`code` is from the fixed list below; clients branch on `code`, never on `message`. FastAPI's default validation errors are remapped to this format.

| HTTP | `code` | When |
|---|---|---|
| 400 | `missing_file` | No `file` part, or the file is empty (0 bytes) |
| 400 | `invalid_parameter` | `model` missing/not `yolov8n`/`yolov8s`; `max_frames` not an int in 1..60 (frames mode); `mode` not `frames`/`dense`; `sample_fps` not a number in 1..30 (dense mode) |
| 413 | `file_too_large` | Upload > 100 MB |
| 413 | `media_dimensions_too_large` | Decoded image/video frame exceeds the pixel limit in section 0.2 |
| 429 | `analysis_busy` | Another analysis is already running in this server process |
| 415 | `unsupported_media_type` | Extension not in section 0.2 |
| 422 | `decode_failed` | Allowed extension but cannot be decoded, 0 frames, or fps <= 0 |
| 422 | `video_required` | Image sent to Stage 2, or to Stage 1 with `mode=dense` |
| 422 | `video_too_long` | Stage 2 video, or Stage 1 `mode=dense` video, would need > 30 windows of 2 s |
| 503 | `weights_missing` | Weights file for the requested model is absent |
| 503 | `model_load_failed` | Weights present but loading or the runtime contract (class names, threshold keys, strict state_dict) failed |
| 503 | `privacy_model_unavailable` | Local YuNet model is absent or cannot be loaded; no unblurred preview is returned |
| 422 | `anonymization_incomplete` | Full-frame scan did not cover every advertised video frame; the video is not shown |
| 404 | `not_found` | Any path under `/api/` that is not an endpoint above |
| 405 | `method_not_allowed` | Known `/api/` path with the wrong HTTP method (`Allow` header lists the allowed ones) |
| 500 | `internal_error` | Unexpected server error. The body never contains a stack trace; the traceback is logged server-side |

Validation order: `missing_file` → `invalid_parameter` → `unsupported_media_type` → `file_too_large` → `video_required` → `weights_missing`/`model_load_failed` → `decode_failed` → `video_too_long`.

Fixtures: `error_stage2_image.json` (422), `error_weights_missing.json` (503).

Paths outside `/api/` are the static UI (`mockup/`); their 404s use the server's default body, not this format.

## 5. Run the web prototype

```bash
# from the repo root; weights in ./weights (or set CCTV_WEIGHTS_DIR)
.venv-cuda/Scripts/python -m uvicorn webapp.api:app --host 127.0.0.1 --port 8000
```

Open `http://127.0.0.1:8000/` — the UI (`mockup/`) and API share one origin. The prototype has no authentication; keep it bound to loopback and do not expose it to a LAN or the internet.
Numerical note: the server runs X3D-S (and YOLO) in **fp32**, while the Stage 2 notebook evaluated under fp16 autocast, so Stage 2 probabilities can differ slightly from the recorded test metrics in `artifacts/model_handoff/stage2/`. Preprocessing is identical to the notebook.

Playback note: the browser overlay assumes the video's `currentTime` equals `index / fps` as read by OpenCV. Variable-frame-rate files, or MP4s whose start time is not zero, can drift by about one frame. Dense mode on CPU (up to 1,800 YOLO runs for a 60 s clip at 30 samples/s) can be slow, and no progress is shown.

Models load lazily on the first analyze request (`GET /api/health` shows `available` → `loaded`); the GPU (`cuda:0`) is used when available, otherwise the CPU.

## 6. Live replay lifecycle (2026-10-14)

`POST /api/live/start-upload` accepts multipart `file`, `model` (default `yolov8n`),
and `device` (default `auto`). `POST /api/live/start` retains JSON file/RTSP input.
There is one inference slot per process: concurrent Live starts return 409,
and analysis while Live is active/draining returns 429. Replay slows down with
processing instead of dropping already-received frames; this is not an FPS SLA.

The start response, `GET /api/live/status`, and all Live WebSocket events contain
the same opaque `session_id`. Idle status has `session_id: null`. Connect to
`/api/live/events?session_id=<id>` to bind to the requested session. Omitting the
query still binds to the current session for compatibility. A different ID gets
a health event with `reason: session_mismatch` and close code 1008. Normal
completion sends terminal health and closes with code 1000. Events are a bounded
display feed, not durable logs; a late/reconnecting client can receive a terminal
status snapshot instead of the complete historical feed.

`POST /api/live/stop` requests capture stop and returns the current status;
already-received frames drain before `stopped`. Source/model/privacy errors
finish as `error`; stream overload can finish as `degraded`. Neither permits a
new inference job until capture and processing workers have exited and cleanup
has run. Uploaded replay files are deleted after their VideoCapture is released.
Application shutdown also requests stop and waits for cleanup (up to 180 seconds,
then logs an error without claiming cleanup succeeded).

The frontend resets output per session, ignores stale callbacks, and polls status
after a WebSocket disconnect without automatically starting another session.
YOLO/X3D use the requested supported device; YuNet stays on CPU. Display frames
pass through anonymization, while model inputs remain original frames. Face
detection can miss faces; this is not a guarantee of complete de-identification.

For videos the browser cannot play, Upload & Analyze calls Stage 1 and Stage 2
sequentially to respect the single inference slot. It labels the result as
separate analyses with frame previews, not a combined shadow-mode pipeline.

## 7. Local observation history (2026-10-14)

SQLite history defaults to `data/local/cctv_safety.sqlite3` (git-ignored).
`CCTV_EVENTS_DB_PATH` can select another local file. Schema version 1 is created
automatically; an unsupported version is rejected rather than rewritten. Run
one backend process per database; startup marks unfinished `running` sessions as
`interrupted`. This is a local pilot without user authentication.

Successful Stage 1/2 and combined analysis requests record a new run atomically
before returning success. A combined request records both stages under one run.
Separate fallback requests create separate runs. Live records observations while
processing, retains partial results on failure, and records its final run state.
A write failure returns 503 `storage_unavailable` for HTTP analysis, or ends Live
with `error`; inference locks and temporary uploads are still released.

History stores filenames (not client filesystem paths), opaque run/session IDs,
source type, model, UTC recording/update times, video start/end seconds, maximum
score, observation count, a representative box/rule/probability detail, and review
status. RTSP labels are always `RTSP stream`; URLs and credentials are not stored.
No images, videos or base64 previews are stored. Image timestamps are null.

There is one observation row per `(run_id, event_type, model)`. Count means boxes
for detector classes, person/rule observations for derived PPE, and evaluated
windows for X3D. Start/end span the first and last observations, not necessarily
continuous detection. Scores for derived PPE are person confidence, not a
calibrated probability of missing PPE. Raw X3D labels (including Non-fight) are
retained; combined Fall/Fight conflicts additionally have a review row. These
rows are model evidence, not confirmed incidents or notification events.

- `GET /api/logs`: query `page` (>=1), `page_size` (1..100; default 10), `q`
  (up to 200 characters), `run_id`, `event_type`, `status` (`new`, `ack`, `closed`),
  `period` (`all`, `today`, `yesterday`, `7d`). Periods use recording time in
  Asia/Bangkok, independent of video time. Returns `items`, `total`, `page`,
  `page_size`, `pages`, and unfiltered `pending_total`. Sort is stable by recording
  time and row ID descending; an excessive page is clamped to the last page.
- `GET /api/logs/sources`: latest 100 analysis runs, including runs with no
  observations. Older rows remain searchable through the history query.
- `GET /api/logs/{event_id}`: detail plus `status_history`; missing ID returns 404.
- `PATCH /api/logs/{event_id}` with `{"status":"ack"}` (or `new`/`closed`):
  saves review status and appends old/new status and UTC time. Repeating the same
  status is idempotent. Reopening is allowed. New observations in an active run
  update its summary without resetting the user's chosen review status.

Review status does not confirm a safety incident. No named assignee/account is
fabricated. Invalid parameters return the existing 400 error envelope. Storage
unavailability is explicit; clients must not replace missing history with mock
rows. History has no automatic deletion or retroactive import of the old 90
mock rows. Browser history refreshes on opening the Logs page or using Refresh.

## 8. Dashboard from persisted observations (2026-10-14)

`GET /api/dashboard?period=7d` accepts `today`, `7d` (default), or `all`.
`today` begins at midnight in Asia/Bangkok. Dashboard `7d` begins at midnight
six days before today, covering seven calendar dates including today. This is
different from the Logs `7d` rolling 168-hour window. Both end at the returned
`generated_at` UTC timestamp. `all` has no lower bound. Invalid periods return
400; storage failures return the existing 503 `storage_unavailable` envelope.

The response includes:

- `period`, `timezone` (`Asia/Bangkok`), `time_basis` (`recorded_at`),
  `generated_at`, `range_start` (UTC or null), and `range_end` (UTC).
- `total`, `by_type` (all known types, including zero counts), and `by_status`
  (`new`, `ack`, `closed`): count **summary rows**, one per run/type/model.
  They do not sum `observation_count` or represent unique people, confirmed
  incidents, alerts, or cameras. Non-fight and derived PPE rows are included.
- `pending_total`: unfiltered count of `new` rows, for the Logs navigation badge.
- `run_count` and `run_states`: count runs by `created_at` in the selected period,
  including runs with zero observations. Observation counts use first
  `recorded_at`, so runs and observations have independently stated time bases.
- `daily`: seven `{date: "YYYY-MM-DD", count: N}` entries in ascending Bangkok
  date order, covering today and the previous six days within the selected
  period. Dates outside `today` have zero counts when that period is selected.
  For `all`, the daily chart is a recent subset of the all-time total.
- `latest`: up to five observation rows in the same shape as Logs items, sorted
  by first recording time descending, then ID descending.

All history panels are queried in one SQLite read transaction. An active Live
summary keeps its original date and row count when more observations arrive;
review changes update status totals without increasing row counts.

The browser separately reads `GET /api/live/status` for the current process's
latest single-session status. It is independent of the history period and is
not a count of online cameras. After a restart, persisted run history remains
while the process starts with no active/recent in-memory Live session.

Dashboard refreshes on navigation, period selection, manual refresh, and every
10 seconds while visible. Period changes discard older responses. Automatic
refresh retains the visible snapshot until its replacement arrives; failures
clear the affected values and display an error, never a fabricated zero or
mock result. History and Live failures are displayed independently.
