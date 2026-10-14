# Project status — 2026-10-01

This is the current status source of truth. Older audit reports, package READMEs,
and plans are retained as records of what was known or approved at their dates;
their historical statements are not the current project status.

## At a glance

- **Stage 1:** provisional Unified dataset and YOLOv8n/YOLOv8s pilot training and
  held-out test evaluations are complete. This is not production approval.
- **Stage 2:** the SCFD pilot was Human-QA signed off by the owner and trained
  with X3D-S. It is an evaluated pilot, not a robust or production-ready Fight
  classifier.
- **Combined system:** an initial web shadow-mode integration now runs dense
  YOLO and X3D on the same uploaded video and reports whether YOLO detected a
  person in each X3D window. Experimental IoU/centre-distance tracking and
  proximity/motion candidate signals are now included for comparison. X3D
  still evaluates every window so missed triggers remain visible. Production
  tracking, calibrated multi-signal triggers, incident-level clustering, and
  end-to-end evaluation remain open. The CLI `scripts/infer.py` remains
  YOLO-only.
- **Web prototype (2026-10-02):** a demo-only Upload & Analyze page. It runs
  YOLOv8n/s and X3D-S on uploaded media through a local FastAPI backend, with
  a combined shadow-mode endpoint for video; see the section below.
- **Project scope:** educational project; both stages remain pilot work.
- The recorded Stage 1 and Stage 2 pilot runs were owner-authorized. **This
  status update does not authorize a new run or continuation**; notebook gates
  remain `False` by default until the owner explicitly approves another run.

## Stage 1 — spatial detector

Canonical classes remain exactly `person`, `helmet`, `vest`, `fall`, `fire`,
`smoke`. Fight is not a Stage 1 class. The dataset remains provisional: the
validated bundle recorded 23,169 images and 32,639 boxes, with 284 known box
boundary warnings and perceptual near-duplicate candidates. The Fall 8-clip
pilot boxes were retained unchanged after the owner agreed that the evidence
was insufficient to redraw them. In the Construction-PPE audit, the owner accepted `image472.jpg`
after QA and excluded `image556.jpg` for low resolution; see
`construction_ppe_sample_audit.md` for the audit limitations.

| Experiment | Result | Interpretation |
|---|---|---|
| YOLOv8n | 81 of 100 requested epochs; best validation mAP50-95 0.45772 at epoch 51; held-out test precision 0.81932, recall 0.77343, mAP50 0.84176, mAP50-95 0.43772 | Pilot baseline; not a completed 100-epoch run. Weights, metrics, args, and training log are in [`artifacts/model_handoff/stage1/yolov8n/`](../artifacts/model_handoff/stage1/yolov8n/); the detailed run record is [`stage1_kaggle_training_status_2026-09-27.md`](stage1_kaggle_training_status_2026-09-27.md). |
| YOLOv8s | 86 of 100 requested epochs before early stopping; held-out test precision 0.858168, recall 0.785335, mAP50 0.869818, mAP50-95 0.457331 | Separate pilot initialized from YOLOv8s pretrained weights. Weights, metrics, args, and training log are in [`artifacts/model_handoff/stage1/yolov8s/`](../artifacts/model_handoff/stage1/yolov8s/). |

An older 47-epoch YOLOv8n package is a separate historical run, not the 81-epoch
run represented in the current handoff. Before choosing a winner, verify both
models used the same dataset manifest, split, and evaluation settings; aggregate
metrics alone do not establish operational superiority. The Fall, Fire, Smoke,
and background confusions require targeted visual error analysis.

## Stage 2 — Fight temporal classifier

- Dataset: SCFD pilot, 300 two-second clips (150 Fight / 150 Non-Fight), grouped
  and split into 210 train / 45 validation / 45 test clips. The owner reports
  Human QA and sign-off of all 295 clips in the accepted QA scope.
- Model: X3D-S, trained for 9 epochs and early-stopped; best validation
  checkpoint was epoch 3. It did not complete the planned 30 epochs.
- Held-out test: 45 clips; accuracy 0.800, macro-F1 0.798407, balanced accuracy
  0.802372. Confusion matrix (true rows, predicted columns):
  `[[20, 2], [7, 16]]`. Thus 7 of 23 Fight test clips were missed.
- Checkpoints, metrics, and training history are in
  [`artifacts/model_handoff/stage2/x3d_s/`](../artifacts/model_handoff/stage2/x3d_s/).
- This is an educational pilot result, not a production deployment result.

This sample is small, short, and not enough to claim generalization to target
CCTV. Do not describe this model as a production-ready Fight detector.

## Web prototype — Upload & Analyze (demo only)

- `webapp/` (FastAPI) serves `mockup/` and exposes `POST /api/stage1/analyze`
  (YOLOv8n/s, image or video, optional dense sampling for video playback) and
  `POST /api/stage2/analyze` (X3D-S, non-overlapping 2 s windows, video only)
  plus `POST /api/pipeline/analyze` (combined local shadow-mode video path).
  Contract: [`web_api_contract.md`](web_api_contract.md).
- X3D-S preprocessing reproduces the training notebook (13 uniformly sampled
  frames, aspect-preserving resize, centred 224×224 padding, Kinetics
  normalization). The server runs in fp32, while the notebook evaluated in fp16,
  so scores can differ slightly from the recorded test metrics.
- Weights are not in Git. Put `YOLOv8n_best.pt`, `YOLOv8s_best.pt` and
  `X3D-S_best.pt` in `weights/`, then run
  `python -m uvicorn webapp.api:app --port 8000`.
- Feature update (2026-10-14): Upload & Analyze and the Live replay pilot run real inference. Alert / Logs now reads persisted SQLite model observations and saves review status. Dashboard now aggregates real SQLite summaries and reads the current single-session Live API; only the separate demo camera monitors remain mock data. In-page suspected-event notifications now persist in schema 2 with a 30-second per-summary cooldown and links to real history; external delivery remains absent. Schema 3 adds versioned persisted YOLO/X3D/tracking defaults, applied once per request or Live session with explicit per-request overrides. See `presentation/settings-verification.md`; this does not establish incident accuracy or production readiness.
- Spot checks on two real images matched the displayed results to the raw API
  output. They also showed known model errors: smoke predicted indoors, and a
  person and vest predicted on a bus advertisement. This prototype is not
  evidence of accuracy or production readiness.
- A standards-oriented risk register and the currently available model/runtime
  provenance are recorded in [`upload_analyze_standards_gap_analysis.md`](upload_analyze_standards_gap_analysis.md)
  and [`model_evaluation_manifest.md`](model_evaluation_manifest.md).

## Remaining before the project can be called complete

1. Complete the reproducibility handoff by pairing the locally archived
   checkpoints, metrics, and run configs with the exact dataset/split manifest
   hashes used for each run (keep large weights/data out of Git unless
   explicitly approved).
2. Verify same-split comparability for YOLOv8n/v8s and review per-class errors;
   decide whether the 81-epoch YOLOv8n run needs continuation to 100 epochs.
3. Evaluate the combined pipeline's latency, event recall and false-alert rate
   on representative footage. Current experimental tracks/triggers are shadow
   signals only; they do not suppress X3D inference or constitute alert logic.
4. Complete project-level documentation and reproducibility checks. No training
   or inference is started by this status update.
