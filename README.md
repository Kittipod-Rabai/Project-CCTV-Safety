# Project CCTV Safety

> **Current project status (2026-09-28):** The provisional Stage 1 six-class
> dataset has completed YOLOv8n (81/100 epochs) and YOLOv8s (86/100 epochs)
> pilot runs and held-out evaluation. Stage 2 SCFD/X3D-S completed a small
> trained/evaluated pilot. Both are educational pilots, not production-ready.
> A local Upload & Analyze prototype now runs Stage 1 and Stage 2 together in
> shadow mode. Production tracking/event logic and target-CCTV evaluation remain
> future work. Dated readiness reports below are historical snapshots.

Public-dataset AI baseline สำหรับตรวจจับเหตุความปลอดภัยจากภาพ CCTV ด้วย YOLOv8

---

## 1. ภาพรวมโครงการ (Project Overview)

Project CCTV Safety พัฒนาขึ้นเพื่อช่วยตรวจจับและเฝ้าระวังเหตุการณ์เสี่ยงภัยหรือพฤติกรรมผิดปกติผ่านกล้องวงจรปิด (CCTV) แบบอัตโนมัติ โดยประมวลผลด้วยโมเดลคอมพิวเตอร์วิทัศน์ YOLOv8 เพื่อลดภาระการเฝ้าหน้าจอของเจ้าหน้าที่ และเพิ่มความรวดเร็วในการรับมือกับอุบัติเหตุหรือสถานการณ์ฉุกเฉิน

---

## 2. สถานการณ์ที่ตรวจจับ (Detection Scenarios)

Stage 1 ใช้โมเดลตรวจจับ 6 คลาสเชิงพื้นที่ และสร้างสถานะการไม่สวม PPE ด้วย post-processing:

| ID | Class | เป้าหมาย Bounding Box |
|---:|---|---|
| 0 | person | บุคคลทั้งตัว |
| 1 | helmet | หมวกนิรภัยที่สวมอยู่ |
| 2 | vest | เสื้อสะท้อนแสง/เสื้อนิรภัยที่สวมอยู่ |
| 3 | fall | ร่างกายของบุคคลที่ล้มหรือนอนผิดปกติ |
| 4 | fire | บริเวณเปลวไฟ |
| 5 | smoke | บริเวณกลุ่มควัน |

`no_helmet` และ `no_vest` ไม่ใช่คลาสของโมเดล แต่คำนวณจากความสัมพันธ์ระหว่าง
`person`, `helmet` และ `vest` ดูกติกาฉบับเต็มใน `docs/data_schema_6classes.md`

`fight` ถูกย้ายไป Stage 2 Temporal Event Classification; มี SCFD/X3D-S pilot
ที่ฝึกและประเมินแล้ว และหน้า Upload & Analyze เรียก Stage 1 + Stage 2 ร่วมกัน
ใน shadow mode สำหรับไฟล์วิดีโอ แต่ยังไม่ใช่ระบบ event alert ที่ผ่านการรับรอง
และไม่ใช่ YOLO bounding-box class ใน Stage 1

---

## 3. สถาปัตยกรรมและเทคโนโลยีที่ใช้ (Tech Stack & Architecture)

- AI Model: YOLOv8 (เริ่มต้นด้วย `yolov8n` สำหรับ Low-latency Inference และเปรียบเทียบกับ `yolov8s`)
- Frameworks & Libraries: PyTorch, Ultralytics YOLO, OpenCV, Roboflow
- Experiment: YOLOv8n เป็น baseline และ YOLOv8s เป็นตัวเปรียบเทียบภายใต้ config เดียวกัน
- Recorded pilot runtime: Kaggle GPU. Colab remains an optional reproducibility workflow.
- หน้า Upload & Analyze เป็นเว็บต้นแบบ FastAPI สำหรับเรียกโมเดลจริงในเครื่อง;
  Live replay เรียกโมเดลจริง, Alert / Logs บันทึกผลลง SQLite และ Dashboard สรุปประวัติจริงแล้ว พร้อมแจ้งเหตุสงสัยภายในเว็บและช่วงพักลดการแจ้งซ้ำ; จอมอนิเตอร์ตัวอย่างยังเป็นข้อมูลจำลอง

---

## 4. โครงสร้างไดเรกทอรี (Directory Structure)

```text
Project-CCTV-Safety/
├── configs/
│   ├── classes.yaml               # Canonical schema และ derived PPE events
│   ├── data.yaml                  # Dataset config สำหรับ YOLOv8
│   ├── datasets.example.yaml      # Template inventory/license/provenance
│   ├── training.yaml              # Shared config สำหรับ YOLOv8n/yolov8s
│   └── thresholds.yaml            # Confidence threshold แยกรายคลาส
├── cctv_safety/                   # Dataset validation และ PPE association library
├── docs/
│   ├── data_schema_6classes.md    # Canonical detector schema v2
│   ├── data_schema_7classes.md    # Deprecated detector schema v1
│   ├── evaluation.md              # Metrics และ error-analysis protocol
│   └── workflow.md                # End-to-end reproducible workflow
├── mockup/
│   ├── index.html                 # Local pilot UI (Dashboard, Live Monitoring, Alert Logs)
│   └── README.md                  # คำอธิบาย Mockup และ Code Map
├── notebooks/
│   └── yolov8_baseline.ipynb      # Jupyter Notebook สำหรับ Pipeline การเทรนและประเมินผล
├── scripts/                        # Download, prepare, validate, train และ inference CLIs
├── tests/                          # Unit tests สำหรับ leakage/labels/PPE association
├── Project-Plan.jpg               # แผนการดำเนินงานโครงการ
├── SWOT.jpg                       # การวิเคราะห์ SWOT ของโครงการ
├── requirements.txt               # รายการ Dependencies สำหรับติดตั้งระบบ
└── README.md                      # เอกสารแนะนำโครงการ
```

---

## 5. การเริ่มต้นใช้งาน (Getting Started)

### ข้อกำหนดเบื้องต้น (Prerequisites)
- Python 3.10 หรือสูงกว่า (โค้ดใช้ type syntax แบบ `X | None`)
- แนะนำสภาพแวดล้อมที่มี GPU (CUDA) หรือใช้งานผ่าน Google Colab / Kaggle

### ขั้นตอนการติดตั้งและเตรียมการ

> คำสั่งดาวน์โหลด/เตรียมข้อมูล/ฝึกด้านล่างเป็น workflow ทั่วไปสำหรับทำซ้ำ
> ไม่ใช่งานที่ยังค้างหรือคำสั่งให้เริ่ม run ใหม่; การฝึกใหม่ต้องได้ owner approval.

1. Clone repository:
   ```bash
   git clone https://github.com/CarToon890/Project-CCTV-Safety.git
   cd Project-CCTV-Safety
   ```

2. ติดตั้ง Dependencies:
   ```bash
   pip install -r requirements.txt
   ```

### Local web runtime (Windows)

Install exactly one PyTorch runtime profile into `.venv-test`. On an NVIDIA machine:

```powershell
py -3.11 -m venv --upgrade .venv-test
.\.venv-test\Scripts\python.exe -m pip install -r requirements-cuda.txt
.\.venv-test\Scripts\python.exe -c "import torch; print(torch.__version__, torch.cuda.is_available())"
.\.venv-test\Scripts\python.exe -m uvicorn webapp.api:app --host 127.0.0.1 --port 8000
```

On a machine without NVIDIA CUDA, install the CPU profile instead:

```powershell
py -3.11 -m venv --upgrade .venv-test
.\.venv-test\Scripts\python.exe -m pip install -r requirements-cpu.txt
```

`Auto` then selects CPU; an explicit GPU selection is disabled in the Live page or returns a clear unavailable error from the API. The Live mixed mode runs YOLO/X3D on the selected device and YuNet face anonymization on CPU.

3. สร้าง source manifest จาก template และกรอกข้อมูลที่ตรวจสอบแล้ว:
   ```bash
   cp configs/datasets.example.yaml configs/datasets.local.yaml
   python scripts/download_datasets.py --manifest configs/datasets.local.yaml
   ```

4. หลังอนุมัติ license และทำ annotation ครบทุกคลาสแล้ว จึงเตรียมและตรวจ Dataset:
   ```bash
   python scripts/prepare_dataset.py --manifest configs/datasets.local.yaml
   python scripts/validate_dataset.py dataset --near-duplicates
   ```

5. เทรนและเปรียบเทียบโมเดลบน Colab GPU:
   ```bash
   python scripts/train_compare.py --config configs/training.yaml
   ```

6. รัน inference พร้อม PPE association:
   ```bash
   python scripts/infer.py reports/model_comparison/runs/yolov8n/weights/best.pt sample.mp4 --save
   ```

---

## 6. แผนการดำเนินงาน (Roadmap & Milestones)

- [x] ปรับเป็น Detector Schema v2 จำนวน 6 Spatial Classes และ PPE association baseline
- [x] จัดทำ reproducible data/training/evaluation pipeline
- [x] จัดทำ provisional Unified Stage 1 dataset และฝึก/ประเมิน YOLOv8n กับ YOLOv8s
- [x] ฝึก/ประเมิน SCFD Stage 2 X3D-S pilot
- [x] เชื่อม Stage 1 กับ Stage 2 ใน Upload & Analyze แบบ shadow mode
- [ ] ประเมิน end-to-end และยืนยันผลกับวิดีโอจากกล้องเป้าหมาย
- [ ] ทดสอบกับข้อมูลกล้อง CCTV เป้าหมายเมื่อมีข้อมูล
> ข้อจำกัด: ผลจาก public datasets ยังไม่ใช่หลักฐานว่าโมเดลพร้อมใช้งานกับกล้องจริง
> Fall ยังเป็นผลตรวจจับรายเฟรมที่อาจผิดพลาด; ต้องมีการยืนยันเชิงเวลาและ
> ประเมินกับข้อมูลกล้องเป้าหมายก่อนกล่าวอ้างความพร้อมใช้งานจริง
