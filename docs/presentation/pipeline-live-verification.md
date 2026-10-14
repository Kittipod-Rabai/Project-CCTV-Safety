# ผลตรวจ Pipeline รวมและ Live replay — งาน 1

วันที่ตรวจ: 14 ตุลาคม 2026

**สถานะ: ผ่านการทำงานระดับต้นแบบบนเครื่องที่ทดสอบ ทั้ง CPU และ CUDA**

เส้นทางที่ตรวจ: ผู้ใช้เลือกวิดีโอบนเว็บ → API → YOLO/X3D/YuNet → ผลแสดงบนเว็บ และผู้ใช้เริ่ม replay → รับผล WebSocket → หยุด/จบคลิป → คืนทรัพยากร → เริ่มรอบใหม่

รายงานนี้ยืนยันการทำงานของระบบ ไม่ใช่การวัดความแม่นยำใหม่ ไม่รับรอง production, กล้อง RTSP จริง, หลายกล้อง หรือ SLA หากเปลี่ยนเครื่องนำเสนอให้ซ้อมใหม่

## การเปลี่ยนแปลง

- แยกการจับภาพ การประมวลผล และการจบ session ให้รอทั้งสอง worker ก่อนลบไฟล์ชั่วคราวและคืน inference slot
- เปลี่ยนการรอคิวเป็นการรอที่ตรวจสถานะ worker ได้ ป้องกันการค้างเมื่อ worker ล้มเหลว พร้อม release ตัวอ่านภาพแม้เปิดไฟล์ไม่สำเร็จ
- เก็บ terminal health ให้ส่งถึง client แม้คิวเต็ม และปิด WebSocket เมื่อจบงาน
- เพิ่ม session_id ใน status/events และ optional query ที่ WebSocket; frontend ไม่รับ callback ของ session เก่า และอ่านสถานะเมื่อการเชื่อมต่อหลุด
- รีเซ็ตภาพ/confidence/feed เมื่อเริ่มใหม่ และล็อกช่องเลือกแหล่งภาพระหว่าง session
- แก้ fallback ที่เคยเรียก Stage 1/2 พร้อมกันจนได้ 429 analysis_busy ให้เรียกตามลำดับ และติดป้ายว่าเป็นผลแยก ไม่ใช่ Pipeline รวม
- เพิ่มเวอร์ชัน URL สคริปต์เพื่อไม่ให้ browser ใช้ JavaScript รุ่นเก่าจาก cache
- แก้ start_s ของ Live X3D ตอนต้นคลิปให้ไม่ติดลบ โดยไม่เปลี่ยนเฟรมที่เลือกหรือ threshold

ก่อนแก้ มี regression tests ที่ล้มเหลวยืนยัน source ไม่ถูก release, terminal health หายเมื่อคิวเต็ม และเวลาช่วงวิดีโอติดลบ ส่วน fallback ทำซ้ำปัญหาได้จาก browser และ log ของ server ก่อนแก้

## ผลทดสอบอัตโนมัติ

- ชุดทดสอบทั้งหมด: **269 passed, 0 failed, 0 errors, 0 skipped**; เวลารอบสุดท้ายประมาณ 42.73 วินาที
- รวม Stage 1/2 เดิม และชุดใหม่สำหรับ shadow mode, Fight/Fall review, ไฟล์เสีย/ว่าง/เกินขนาด/ยาวเกินกำหนด, Privacy failure, CUDA ไม่พร้อม, busy, stop/drain, restart 3 รอบ, session mismatch, disconnect/reconnect, queue เต็ม และ cleanup
- Real-weight acceptance: Pipeline รวม 8 ครั้ง และ replay 24 รอบ ผ่านครบ CPU/CUDA × YOLOv8n/s โดยใช้ X3D-S และ YuNet จริง
- ต่อคู่ device/model: Pipeline กับ Fight และ Non-fight อย่างละหนึ่งคลิป; replay จบเอง 3 รอบและหยุดหลังได้รับ confidence 3 รอบ ใช้ session IDs ไม่ซ้ำ
- replay ที่จบปกติและที่ผู้ใช้หยุดมีจำนวน frames_received = frames_processed = frames_face_scanned; ไฟล์อัปโหลดถูกลบ และ inference slot กลับมาใช้ได้
- ตรวจ Python compilation, JavaScript syntax และ git diff --check ผ่าน
- pytest มี deprecation warnings จาก FastAPI/Starlette/PyTorch; ไม่มี test failure โดยไม่ได้อัปเกรด dependencies ในงานนี้

สาเหตุ pytest ที่ค้างครั้งก่อน: traceback อยู่ที่ socket.accept → socketpair ขณะ Windows สร้าง event loop ของ TestClient ใน sandbox ยังไม่ถึง model inference เมื่อรันทดสอบแบบอนุญาต local loopback แล้วทำงานได้ ไม่ได้แก้ด้วยการปิดการตรวจหรือข้าม tests

## ผลตรวจหน้าเว็บ

- Upload & Analyze: เลือกคลิป fi008.mp4 ผ่าน file chooser แล้วรัน Pipeline จริงบน CPU/YOLOv8n และ CUDA/YOLOv8s; แสดงผลทั้งสอง Stage พร้อม preview
- Live replay: เริ่มผ่าน file chooser บน CPU และ CUDA ได้ รับ preview, confidence, X3D และ terminal status; ปุ่มเริ่มกลับมาใช้งานได้หลังจบ
- ตรวจปุ่มหยุดผ่านหน้าเว็บ: แสดงกำลังหยุดระหว่าง drain แล้วเปลี่ยนเป็น stopped; ตรวจ restart เพิ่มจากหน้าเว็บ
- เปลี่ยนไฟล์ขณะคำขอเดิมยังประมวลผล: ผล Stage 1/2 เก่าถูกซ่อนและไม่กลับมาเขียนทับหลัง response เก่าถึง
- AVI/MJPG สังเคราะห์ที่ browser เล่นไม่ได้: ก่อนแก้ Stage 2 ได้ analysis_busy; หลังแก้ทั้งสอง Stage สำเร็จ และแสดงข้อความว่าเป็นการวิเคราะห์แยก
- ไม่พบ JavaScript error ในการตรวจรอบที่สำเร็จ; WebSocket disconnect/reconnect และการปฏิเสธ session เก่าทดสอบใน integration tests ไม่ได้ตัดเครือข่าย browser จริง
- สื่อหลักฐานเป็นภาพหน้าจอและผล JSON/JUnit ไม่ได้บันทึกคลิปหน้าจอต่อเนื่องสำหรับนำไปพรี

## Runtime และเวลาใช้งานที่สังเกต

- Python: 3.11.9; PyTorch 2.12.0+cu132; torchvision 0.27.0+cu132
- GPU: NVIDIA GeForce RTX 4050 Laptop GPU; YOLO/X3D ใช้ cuda:0 ในกรณี CUDA และ YuNet ใช้ CPU เสมอ
- จำกัด PyTorch CPU threads เป็น 2 ใน harness; dependencies และ hash น้ำหนัก/source อยู่ใน baseline.json ของรอบนี้
- เวลาเป็นการสังเกตรอบเดียวต่อคลิป รวม cold model load ในคลิปแรก ไม่ใช่ benchmark แบบควบคุมโหลดเครื่องหรือ SLA และไม่ใช่เวลารอเครื่องมือ browser

### CPU / yolov8n

- Pipeline fi008.mp4: 8.510 วินาที; คลิป 2.200 วินาที, 640 × 360
- Pipeline nofi003.mp4: 4.604 วินาที; คลิป 2.400 วินาที, 480 × 360
- replay จบเอง 3 รอบ: 5.632, 7.251, 7.180 วินาที

### CPU / yolov8s

- Pipeline fi008.mp4: 11.728 วินาที; คลิป 2.200 วินาที, 640 × 360
- Pipeline nofi003.mp4: 10.828 วินาที; คลิป 2.400 วินาที, 480 × 360
- replay จบเอง 3 รอบ: 8.262, 9.651, 7.597 วินาที

### CUDA / yolov8n

- Pipeline fi008.mp4: 7.642 วินาที; คลิป 2.200 วินาที, 640 × 360
- Pipeline nofi003.mp4: 1.910 วินาที; คลิป 2.400 วินาที, 480 × 360
- replay จบเอง 3 รอบ: 2.825, 2.864, 2.867 วินาที

### CUDA / yolov8s

- Pipeline fi008.mp4: 8.540 วินาที; คลิป 2.200 วินาที, 640 × 360
- Pipeline nofi003.mp4: 1.947 วินาที; คลิป 2.400 วินาที, 480 × 360
- replay จบเอง 3 รอบ: 2.851, 2.898, 2.862 วินาที

## ขอบเขตผลโมเดล

- ใช้คลิปแรกของแต่ละ label ใน SCFD test manifest: fi008.mp4 และ nofi003.mp4 ตรวจ SHA-256 ตรงกับ manifest และแต่ละคลิปสั้นกว่า 5 วินาที
- Pipeline ในคลิป Fight fi008.mp4 ทำนาย Non-fight และไม่พบ person ในตัวอย่างที่ตรวจ: นี่เป็นข้อจำกัดของโมเดลที่ยังอยู่ แม้การรับไฟล์/ประมวลผล/แสดงผลผ่าน
- ไม่มีการปรับน้ำหนัก threshold หรือเลือกคลิปใหม่เพื่อซ่อนผลผิด ไม่มีการฝึกหรือประเมิน test set ทั้งชุดใหม่
- ข้อมูลเดิมมีจำนวน fall boxes น้อย และ YuNet อาจตรวจหน้าไม่ครบ งานนี้ไม่รับรองการตรวจจับเหตุหรือปกปิดใบหน้าครบทุกกรณี

## หลักฐานและการรันซ้ำ

- [ชุด regression ใหม่](../../tests/test_pipeline_live.py)
- [Real-weight harness](../../scripts/verify_pipeline_live.py)
- [API contract และ session lifecycle](../web_api_contract.md)
- [JUnit ของชุดทดสอบทั้งหมด](../../reports/pipeline_live_verification/pytest.xml)
- [Runtime/source/weight hashes](../../reports/pipeline_live_verification/baseline.json)
- [CPU/YOLOv8n](../../reports/pipeline_live_verification/cpu_yolov8n.json) · [CPU/YOLOv8s](../../reports/pipeline_live_verification/cpu_yolov8s.json)
- [CUDA/YOLOv8n](../../reports/pipeline_live_verification/cuda_yolov8n.json) · [CUDA/YOLOv8s](../../reports/pipeline_live_verification/cuda_yolov8s.json)
- [ภาพ Pipeline](../../reports/pipeline_live_verification/browser-pipeline.png) · [ภาพ Live replay](../../reports/pipeline_live_verification/browser-live.png) · [ภาพ fallback](../../reports/pipeline_live_verification/browser-fallback.png)

ไฟล์ใน reports/ เป็นหลักฐานในเครื่องที่ Git ignore อยู่ ไม่เพิ่ม raw video, weights หรือภาพผู้ใช้เข้า Git การย้ายโครงการไปเครื่องใหม่ต้องจัดเตรียมน้ำหนัก/ข้อมูลและสร้างหลักฐานใหม่

รันจาก root ของโครงการใน terminal ที่อนุญาต local loopback:

```powershell
$env:PYTEST_DISABLE_PLUGIN_AUTOLOAD = '1'
.\.venv-test\Scripts\python.exe -u -c "import faulthandler; faulthandler.dump_traceback_later(120,exit=True); import torch; torch.set_num_threads(2); import pytest; raise SystemExit(pytest.main(['-q','tests','--junitxml=reports/pipeline_live_verification/pytest.xml']))"
.\.venv-test\Scripts\python.exe -u scripts/verify_pipeline_live.py
```

Harness แยกแต่ละ device/model เป็น process ที่มี deadline 180 วินาที หาก CUDA ไม่พร้อมหรือหมดเวลา จะบันทึก failed และคืน exit code ที่ไม่ใช่ศูนย์ ไม่รายงานเป็นผ่านโดยข้าม GPU

## ผลต่อแผนงาน

งาน 1 ปิดได้ในขอบเขตการทำงานของต้นแบบบนเครื่องนี้ งาน 2–5 ยังไม่เริ่ม: Logs จริง, Dashboard จริง, แจ้งเตือนภายในเว็บ และหน้าตั้งค่าที่บันทึกได้ การซ้อมพรีให้จบใน 15 นาทีและคลิปบันทึกหน้าจอสำรองยังต้องเตรียมแยกจากการตรวจทางเทคนิคนี้
