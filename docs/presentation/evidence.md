# Project CCTV Safety — หลักฐานและสถานะสำหรับนำเสนอ

วันที่จัดเตรียม: 14 ตุลาคม 2026

เอกสารนี้ใช้ตรวจคำกล่าวใน [สไลด์](slides.md) และ [บทพูด](speaker-notes.md) เป็น snapshot สำหรับการนำเสนอ ไม่แทนที่สถานะโครงการหรือแก้ไขเอกสารต้นฉบับ ผลตรวจ Pipeline/Live ล่าสุดอยู่ใน [รายงานงาน 1](pipeline-live-verification.md)

## ระดับหลักฐานที่ใช้

- **ผลทดลองที่บันทึกไว้:** มีไฟล์ metrics/logs ของ run ไม่ได้หมายความว่าประเมินใหม่ในวันจัดทำเอกสาร
- **มี implementation:** พบเส้นทางโค้ดที่เรียกใช้งานจริง ไม่ได้หมายความว่าทุกเส้นทางผ่านการทดสอบแล้ว
- **ทดสอบเรียกโมเดลแล้ว:** การตรวจในแชตนี้ก่อนจัดทำเอกสารโหลดโมเดลและทำ inference บน CPU ด้วยภาพสังเคราะห์สำเร็จ ไม่ใช่การวัดความแม่นยำ
- **จำลอง/ยังไม่ยืนยัน:** ต้องระบุบนสไลด์และไม่ใช้เป็นหลักฐานว่าระบบพร้อมใช้งานจริง

## E01 — ภาพรวมและวัตถุประสงค์ | สไลด์ 01–03, 09, 11

- [README โครงการ](../../README.md): ที่มาและแนวทางโครงการ
- [บันทึกสถานะโครงการ](../project_status.md): สถานะ pilot และผลทดลองที่บันทึกไว้
- `[ต้องเติมข้อมูล: ข้อเสนอโครงการฉบับส่งอาจารย์และเกณฑ์คะแนน]`
- `[ต้องเติมข้อมูล: สมาชิกและหน้าที่ที่ทีมยืนยัน]`

วัตถุประสงค์ในสไลด์เป็นข้อความเรียบเรียงจากงานที่ตรวจพบ ยังต้องเทียบกับข้อเสนอต้นฉบับ ห้ามใช้การเรียบเรียงนี้เปลี่ยนเกณฑ์ความสำเร็จย้อนหลัง

## E02 — ข้อมูล Stage 1 | สไลด์ 05

- [Dataset manifest](../../data/processed/stage1_unified/dataset_manifest.json)
- [นิยามคลาส 6 คลาส](../data_schema_6classes.md)
- [บันทึกตรวจ Construction-PPE](../construction_ppe_sample_audit.md)
- [บันทึก QA D-Fire](../audit_artifacts/dfire/dfire_phase3_visual_qa_report.md)
- [บันทึก QA Fall](../audit_artifacts/fall/fall_campaign_qa_report.md)

ค่าจาก manifest:

- ภาพทั้งหมด 23,169; Train 18,530 / Validation 1,667 / Test 2,972
- Bounding boxes ทั้งหมด 32,639
- Person 2,612; Helmet 1,723; Vest 1,626; Fall 141; Fire 14,683; Smoke 11,854 boxes
- แหล่งข้อมูล: Construction-PPE, D-Fire และ Fall pilot
- ชุดข้อมูลระบุ `provisional: true` และมี flag สำหรับการควบคุม workflow

ขอบเขต: เป็นจำนวนตาม manifest ไม่ใช่การนับภาพใหม่ทั้งหมดในวันจัดทำเอกสาร Flag ใน manifest ไม่ใช่หลักฐานว่าไม่เคยฝึกโมเดล ต้องอ่านคู่กับผล run ที่ได้รับอนุญาตและบันทึกสถานะภายหลัง

## E03 — การฝึกและผล YOLO | สไลด์ 06–07

### YOLOv8n

- [Run status](../../artifacts/model_handoff/stage1/yolov8n/YOLOv8n_run_status.md)
- [Training arguments](../../artifacts/model_handoff/stage1/yolov8n/YOLOv8n_training_args.yaml)
- [Training results](../../artifacts/model_handoff/stage1/yolov8n/YOLOv8n_training_results.csv)
- [Held-out test metrics](../../artifacts/model_handoff/stage1/yolov8n/yolov8n_test_metrics.json)

Run status ระบุ 81/100 epochs และ best validation mAP@50–95 ที่ epoch 51; arguments ระบุการ resume

ผล test: Precision 0.81932149; Recall 0.77342678; mAP@50 0.84176230; mAP@50–95 0.43771646

หมายเหตุ: metrics มี field `checkpoint_completed_epochs_before_resume: 47` ซึ่งไม่ใช่จำนวน epochs สุดท้ายของ run ห้ามใช้แทน 81 epochs จาก run status และ logs

### YOLOv8s

- [Training arguments](../../artifacts/model_handoff/stage1/yolov8s/YOLOv8s_training_args.yaml)
- [Training results](../../artifacts/model_handoff/stage1/yolov8s/YOLOv8s_training_results.csv)
- [Held-out test metrics](../../artifacts/model_handoff/stage1/yolov8s/YOLOv8s_heldout_test_metrics.json)

Metrics ระบุ 86 epochs; บันทึกสถานะโครงการระบุ early stopping

ผล test: Precision 0.85816807; Recall 0.78533459; mAP@50 0.86981801; mAP@50–95 0.45733074

### ขอบเขตการเปรียบเทียบ

ทั้งสอง arguments ระบุ `imgsz: 640`, `batch: 16`, `seed: 42` และเป้าหมาย 100 epochs แต่มีวิธีเริ่ม run และจำนวน epochs ต่างกัน ไฟล์ผลส่งออกไม่ได้ผูก dataset/split hashes ของแต่ละ remote run ครบ จึงกล่าวได้ว่าค่ารวม YOLOv8s สูงกว่าในบันทึกนี้ แต่ไม่รับรองว่าเป็นการเปรียบเทียบแบบควบคุมทุกเงื่อนไขหรือดีกว่าทางปฏิบัติทุกด้าน

## E04 — ข้อมูลและผล X3D-S | สไลด์ 04–07

- [สถานะ SCFD pilot](../stage2_scfd_pilot_readiness.md): อ่าน current-status note ก่อนเนื้อหาประวัติเดิม
- [Training history](../../artifacts/model_handoff/stage2/x3d_s/X3D-S_training_history.json)
- [Test metrics](../../artifacts/model_handoff/stage2/x3d_s/X3D-S_test_metrics.json)
- [โค้ดโหลดและเตรียมข้อมูล X3D-S](../../cctv_safety/stage2.py)

ข้อมูลที่บันทึกไว้: 300 คลิป แบ่ง 210 / 45 / 45; จบการฝึกที่ 9 epochs และเลือก checkpoint ที่ epoch 3 ตามบันทึกสถานะ ไม่ใช้ epoch ที่ Macro-F1 สูงสุดมาแทนเกณฑ์เลือก checkpoint โดยอัตโนมัติ

ผล test 45 คลิป:

- Accuracy 0.8000; Macro-F1 0.79840717; Balanced accuracy 0.80237154
- ลำดับคลาส `non_fight`, `fight`; แถวเป็นค่าจริงและคอลัมน์เป็นค่าทำนาย
- Non-fight จริง: ทำนาย Non-fight 20, ทำนาย Fight 2
- Fight จริง: ทำนาย Non-fight 7, ทำนาย Fight 16
- Fight recall = 16/23 ≈ 69.57%; จึงยังมีเหตุ Fight ที่พลาด

Inference เตรียม 13 เฟรมต่อช่วง ปรับขนาดแบบรักษาสัดส่วนและ padding เป็น 224 × 224 ผลจาก server อาจต่างจาก notebook เล็กน้อยตาม precision/runtime ไม่อ้างว่าเดโมจะได้คะแนนเท่าตัวเลข test ทุกครั้ง

## E05 — เว็บวิเคราะห์และ API | สไลด์ 04, 08–09

- [Backend API](../../webapp/api.py)
- [Model registry](../../webapp/models.py)
- [Frontend วิเคราะห์](../../mockup/analyze.js)
- [Runtime limits](../../webapp/config.py)
- [สัญญา API](../web_api_contract.md)

พบ implementation ของ `POST /api/stage1/analyze`, `POST /api/stage2/analyze` และ `POST /api/pipeline/analyze` และ frontend เรียก endpoint จริงแบบ same-origin

มีข้อจำกัดขนาดไฟล์และจำนวนช่วงวิดีโอ; เดโมควรใช้วิดีโอสั้นที่ซ้อมไว้ ไม่ถือว่าไฟล์ทุกชนิดที่ backend รับจะเล่นใน browser ได้เหมือนกัน

Pipeline รวมระบุ `tracking_trigger_shadow` และ `evaluate_every_window_shadow_mode` จึงยังประเมิน X3D ทุกช่วงเพื่อเทียบกับ candidate ไม่ได้ลดการเรียกโมเดลตาม trigger อย่างเดียว

## E06 — PPE, Privacy และ Tracking | สไลด์ 04, 08, 10–11

- [PPE association](../../cctv_safety/ppe.py): ใช้ตำแหน่งอุปกรณ์เทียบกับบริเวณคน; `no_helmet` / `no_vest` เป็นผลหลังตรวจจับ
- [Privacy](../../cctv_safety/privacy.py): YuNet ตรวจใบหน้าและเบลอภาพแสดงผล ไม่ใช่ระบบระบุตัวบุคคล และไม่รับรองว่าพบทุกใบหน้า
- [Tracking](../../cctv_safety/tracking.py): จับคู่ด้วย IoU/ระยะห่างของจุดกึ่งกลาง และคำนวณ proximity/motion เป็นสัญญาณ candidate ระดับทดลอง ไม่ใช่ ByteTrack

ขอบเขต: พบโค้ดใช้งาน ไม่ได้มีหลักฐานประเมิน end-to-end ว่าสัญญาณเหล่านี้ลด false alerts ได้เท่าใด

## E07 — Live pilot และส่วนจำลอง | สไลด์ 08–11

- [Live worker](../../webapp/live.py): อ่าน stream/replay เรียก YOLO/X3D และส่ง preview ที่ผ่านส่วนเบลอหน้า
- [Live frontend](../../mockup/live.js): เรียก API เริ่ม/หยุดและรับ WebSocket events
- [Live flow frontend](../../mockup/live-flow.js)
- [หน้าเว็บและตัวสร้างข้อมูลจำลอง](../../mockup/index.html)
- [คำอธิบายหน้าเว็บ](../../mockup/README.md)

สถานะ:

- Live pilot: มี implementation จริงสำหรับหนึ่ง stream พร้อมเส้นทาง replay และ RTSP; การตรวจครั้งนี้ยังไม่ยืนยัน RTSP กล้องจริงหรือ benchmark SLA
- จอมอนิเตอร์ตัวอย่างในหน้า Live: mock แยกจากแผง Live pilot
- Dashboard: KPI/กราฟ/สถานะกล้องจำลอง
- Alert Logs: ปัจจุบันอ่านผลโมเดลจาก SQLite ผ่าน API มีตัวกรอง แบ่งหน้า และเปลี่ยนสถานะตรวจสอบ; ไม่ใช้ 90 รายการสุ่มเดิมแล้ว ดู [รายงานงาน 2](history-verification.md)
- จัดการกล้อง/ตั้งค่าระบบ: มีเมนู placeholder
- มีฐานข้อมูลประวัติผลตรวจจับ SQLite แล้ว แต่ยังไม่มีบัญชีผู้ใช้และการแจ้งเตือนภายนอก; ไม่ระบุผู้รับผิดชอบสมมติ

ห้ามอ้างว่าเป็นระบบหลายกล้องพร้อมใช้งานจริงจากจำนวนกล้องบน Dashboard

## E08 — ขอบเขตการทดสอบที่ทำในแชตนี้

ในการตรวจที่เกิดขึ้นก่อนเขียนเอกสารชุดนี้:

- พบไฟล์น้ำหนัก YOLOv8n, YOLOv8s, X3D-S และ YuNet ใน `weights/`
- import `torch` และ `webapp.api` สำเร็จ
- เรียก ModelRegistry ด้วยภาพสังเคราะห์ขนาด 160 × 120 บน CPU สำเร็จทั้ง YOLOv8n และ YOLOv8s; ทั้งคู่คืน detections ว่างสำหรับภาพสังเคราะห์นั้น
- X3D-S คืน Non-fight ประมาณ 0.5526 และ Fight ประมาณ 0.4474 จากเฟรมสังเคราะห์ 13 เฟรม
- รัน pytest เลือก real-weights smoke tests แล้วไม่เสร็จและถูกหยุด รวมถึงรอบที่ปิด plugin autoload; ไม่มีผล pass/fail สมบูรณ์ จึงไม่บันทึกว่า API tests ผ่าน
- ไม่ได้ทดสอบ UI ผ่าน browser, pipeline รวมผ่าน API, Live replay หรือกล้อง RTSP จริงในการตรวจครั้งนี้
- ไม่มีการฝึกโมเดลใหม่หรือประเมิน test dataset ใหม่

ค่าจากภาพสังเคราะห์ยืนยันเพียงว่าการโหลดและเรียกโมเดลทำงานได้ ไม่ใช่ผลประเมินความแม่นยำ ไม่มี log ถาวรของคำสั่งในเอกสารโครงการ จึงให้ถือเป็นบันทึกการตรวจในแชต ไม่ใช่รายงานทดสอบอิสระ

## E09 — เอกสารที่อาจให้สถานะต่างกัน

อัปเดตหลังดำเนินงาน 1: ชุดทดสอบ API/Live และการเรียกน้ำหนักจริงผ่านบน CPU/CUDA แล้ว รวมการตรวจผ่าน browser, fallback และการเปลี่ยนไฟล์ รายการใน E08 เป็นประวัติการตรวจครั้งก่อน ไม่ใช่ข้อจำกัดสถานะล่าสุด อ่านขอบเขตและหลักฐานจาก [รายงานล่าสุด](pipeline-live-verification.md) งานนี้ยืนยันการทำงาน ไม่ได้เพิ่มผลประเมินความแม่นยำของโมเดล

- [Project status](../project_status.md) และ README บางช่วงยังกล่าวว่า Live เป็น mock แต่โค้ดและ README ของ mockup มี Live pilot เพิ่มแล้ว ให้แยกสถานะส่วน Live ตาม E07
- [Live runtime profiles](../live_runtime_profiles.md) บางช่วงบรรยาย YuNet บน CUDA และ Auto ที่ต้องพร้อมทั้ง pipeline แต่ `webapp/models.py` และ `webapp/live.py` ปัจจุบันให้ YOLO/X3D ใช้ device ที่เลือก และ YuNet ใช้ CPU ไม่อ้างว่า inference ทุกส่วนอยู่บน GPU
- [Final report เก่า](../../final_report.md) มีข้อความ BLOCKED/ยังไม่ฝึกในเนื้อหาประวัติ แต่มีหมายเหตุ superseded จึงไม่ใช้ข้อความเก่าแทนผล run ปัจจุบัน
- เอกสารนี้บันทึกความต่างเพื่อการนำเสนอ ไม่ได้แก้เอกสารเดิมหรือรับรองความถูกต้องทุกข้อความของเอกสารต้นทาง

## E10 — งานที่ทีมต้องเติมก่อนนำเสนอ

- [ ] ข้อเสนอโครงการ วัตถุประสงค์ฉบับจริง และเกณฑ์คะแนน
- [ ] สมาชิก หน้าที่ รายวิชา และชื่ออาจารย์
- [ ] ภาพผลตรวจจับถูก/ผิดที่คนตรวจสอบแล้ว พร้อมคำอธิบาย
- [ ] กราฟจาก training logs และ confusion matrix พร้อมชื่อ metric/ชุดทดสอบ
- [ ] ไฟล์เดโม คลิปสำรอง และสิทธิ์ในการนำเสนอสื่อ
- [ ] ผลซ้อมครบเส้นทางจาก browser → API → โมเดล → ผลบนเว็บ บนเครื่องพรีจริง
- [ ] เวลาประมวลผลที่วัดจริงและ runtime/device หากต้องกล่าวถึงความเร็ว

การเติมข้อมูลให้แก้เฉพาะเอกสารในโฟลเดอร์นี้ งานเปลี่ยนโค้ด ฝึกโมเดล หรือปรับข้อมูลอยู่นอกขอบเขตการจัดทำเอกสารนำเสนอ
