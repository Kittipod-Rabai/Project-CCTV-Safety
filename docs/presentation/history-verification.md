# ผลตรวจงาน 2 — Alert / Logs จากผลจริง

วันที่ตรวจ: 14 ตุลาคม 2026

**สถานะ: ทำงานจริงระดับต้นแบบบนเครื่องที่ทดสอบ**

เส้นทาง: วิเคราะห์ภาพ/วิดีโอหรือ replay → บันทึกผลโมเดลลง SQLite → อ่านผ่าน API → ค้นหา/กรอง/แบ่งหน้า → ดูรายละเอียด → รับทราบ/ปิดรายการ → เปิด backend ใหม่แล้วข้อมูลยังอยู่

## สิ่งที่ทำแล้ว

- เพิ่มฐานข้อมูล SQLite schema version 1 แยก analysis_runs, observations และประวัติเปลี่ยนสถานะ รองรับการอ่าน/เขียนจาก worker ด้วย connection ต่อ operation และ WAL
- บันทึกผลสำเร็จจาก Stage 1, Stage 2 และ Pipeline รวม; Pipeline รวมบันทึกทั้งสอง Stage ใน run เดียวอย่าง atomic
- Live บันทึกตาม session_id ขณะทำงาน เก็บ partial observations หากล้มเหลว และระบุสถานะรอบ stopped/error/interrupted โดยยังคืน inference slot และลบไฟล์ชั่วคราว
- แทนที่ controller และตาราง Logs ที่ใช้ข้อมูลสุ่มด้วย logs.js ที่อ่าน API จริง มีข้อความ loading/empty/error และไม่ใช้ mock rows แทนเมื่อ API ล้มเหลว
- เพิ่มตัวกรองข้อความ ช่วงเวลาบันทึก Asia/Bangkok แหล่งไฟล์/เซสชัน ประเภทผล และสถานะ พร้อมแบ่งหน้าที่ backend
- เพิ่มรายละเอียดและบันทึกสถานะรอตรวจสอบ → รับทราบ → ปิดรายการ (เปิดกลับได้) พร้อม audit เวลา ไม่มีผู้รับผิดชอบสมมติ
- แก้ modal รายละเอียดให้เลื่อนภายในได้และปุ่มเปลี่ยนสถานะอยู่ใน viewport หลังพบปัญหาจาก browser; ปุ่มแบ่งหน้าใช้ลูกศรพร้อมชื่อสำหรับ accessibility

## หลักการบันทึกและข้อจำกัด

- เก็บชื่อไฟล์ ไม่เก็บ path ฝั่ง client; RTSP ใช้ชื่อ RTSP stream ไม่เก็บ URL หรือ credentials
- ไม่เก็บภาพ คลิป base64 หรือใบหน้าในฐานข้อมูล; details เก็บเฉพาะกรอบตัวอย่าง กฎ PPE หรือ probabilities
- หนึ่งรายการต่อ run/type/model รวมจำนวนกล่องสำหรับ detector, จำนวน person/rule observations สำหรับ PPE และจำนวน windows สำหรับ X3D
- เวลาเริ่ม/จบคือช่วง first/last observation ไม่รับรองว่าตรวจพบต่อเนื่องทุกจุดในช่วงนั้น; ภาพนิ่งมีเวลาในวิดีโอเป็น null
- คะแนนเป็นคะแนนสูงสุดในกลุ่ม; PPE ใช้ person confidence ประกอบกฎ ไม่ใช่ probability ว่าไม่สวม PPE
- เก็บ Non-fight เพื่อให้ตรวจสอบผลที่โมเดลพลาดได้ และเก็บ Fall/Fight review เพิ่มใน Pipeline ที่กำกวม
- สถานะตรวจสอบไม่ใช่การยืนยันเหตุจริง สถานะที่ผู้ใช้เลือกไม่รีเซ็ตเมื่อ Live มี observations เพิ่ม จึงต้องพิจารณา run_state และเวลาอัปเดตด้วย
- วิเคราะห์ซ้ำสร้าง run ใหม่; fallback ที่เรียก Stage 1/2 แยกกันสร้างสอง runs ไม่แอบรวมว่าเป็น Pipeline เดียว
- ยังไม่มี Dashboard จริง ระบบส่งแจ้งเตือน บัญชีผู้ใช้ การส่งออก CSV หรือการลบประวัติในงานนี้

## ผลทดสอบ

- ชุดทดสอบทั้งหมด **285 passed, 0 failed, 0 errors, 0 skipped** รอบตรวจงาน 2 ใช้เวลาประมาณ 20.93 วินาที
- ครอบคลุม persistence, aggregate counts, atomic rollback, concurrent writes, parameterized search, pagination, status audit/idempotency, invalid inputs, storage failure และการคืนทรัพยากรเมื่อ Live เขียนประวัติไม่ได้
- แยกฐานข้อมูลใน tests ด้วย tmp_path; real-weight verification harness ของงาน 1 เปลี่ยนให้ใช้ฐานข้อมูลใน reports แทนฐานข้อมูลเริ่มต้นของผู้ใช้
- หลังปรับ modal/pager ตรวจ static frontend ซ้ำ: 39 passed; JavaScript syntax, Python compilation และ git diff --check ผ่าน
- ตรวจซ้ำก่อนแยก commit: snapshot งาน 1 ผ่าน 269 tests ใน 20.12 วินาที และงาน 1–2 รวมผ่าน 285 tests ใน 19.34 วินาที ดู [JUnit งาน 1](../../reports/commit-split/work1-pytest.xml) และ [JUnit งาน 2](../../reports/commit-split/work2-pytest.xml) เป็นเวลาทดสอบ ไม่ใช่เวลา inference
- มี deprecation warnings เดิมจาก FastAPI/Starlette/PyTorch โดยไม่ได้เปลี่ยน dependencies

### ผลโมเดลจริง

- ใช้ภาพ image472.jpg ที่มีอยู่ในชุดข้อมูล และคลิป SCFD fi008.mp4 ไม่ดาวน์โหลดหรือฝึกโมเดลใหม่
- วิเคราะห์ภาพด้วย YOLOv8n และ YOLOv8s ทั้ง CPU/CUDA รวมการอัปโหลดผ่าน browser บน CPU
- ตรวจ Pipeline รวมบน CUDA, Stage 2 แยกบน CPU และ Live replay บน CUDA แล้วพบข้อมูลที่บันทึกจริง
- ได้ **17 observation summaries จาก 7 runs** ในฐานข้อมูลตรวจสอบ ไม่ใช่ 17 เหตุจริง
- คลิป fi008 เป็น Fight แต่ X3D ทำนาย Non-fight และมี smoke false positive ในบางเฟรม: ประวัติบันทึกผลตามจริง ไม่ได้แก้ความแม่นยำหรือซ่อนข้อผิดพลาดของโมเดล

### ผลผ่าน browser และ restart

- ฐานข้อมูลเริ่มว่าง: แสดง 0 รายการ ไม่ปรากฏ 90 แถวสุ่มเดิม
- ตรวจหน้าแรก 10 แถวและหน้าที่สอง 7 แถว รวม 17 รายการ
- ตรวจ type/date/source filters และค้นหาข้อความที่ไม่พบจนได้ 0 รายการ
- เปิด OBS-16 จาก replay ผ่านหน้าเว็บ เปลี่ยน new → ack → closed สำเร็จ และกรองสถานะ closed พบรายการนั้น
- ปิดและเปิด server process ใหม่ด้วย SQLite ไฟล์เดิม: JSON ก่อนและหลังเท่ากัน รวมทั้ง 17 รายการ สถานะ closed และ audit 2 การเปลี่ยนสถานะ
- รีเฟรช browser หลัง restart แล้วยังอ่านรายละเอียดและสถานะเดิมได้ ไม่พบ JavaScript error ในรอบที่สำเร็จ

## ไฟล์และ API

- [Storage implementation](../../webapp/event_store.py)
- [HTTP และ Live integration](../../webapp/api.py) · [Live observations](../../webapp/live.py)
- [Frontend ประวัติ](../../mockup/logs.js)
- [API contract](../web_api_contract.md) อธิบาย GET /api/logs, GET /api/logs/sources, GET/PATCH /api/logs/{event_id}
- [Storage tests](../../tests/test_event_store.py) · [API tests](../../tests/test_logs_api.py)

ฐานข้อมูลเริ่มต้นคือ data/local/cctv_safety.sqlite3 ซึ่ง Git ignore ไว้ เปลี่ยนตำแหน่งได้ด้วย CCTV_EVENTS_DB_PATH ใช้หนึ่ง backend process ต่อฐานข้อมูล หาก SQLite ใช้ไม่ได้จะคืน storage_unavailable ไม่รายงานว่าบันทึกสำเร็จ

## หลักฐานในเครื่อง

- [JUnit](../../reports/history_verification/pytest.xml) · [Runtime/source hashes](../../reports/history_verification/baseline.json)
- [ผลเรียกโมเดลจริง](../../reports/history_verification/real-api.json)
- [ก่อน restart](../../reports/history_verification/before-restart.json) · [หลัง restart](../../reports/history_verification/after-restart.json)
- [ภาพหน้าประวัติ](../../reports/history_verification/browser-history.png) · [ภาพสถานะปิด](../../reports/history_verification/browser-closed.png) · [รายละเอียดหลัง restart](../../reports/history_verification/browser-persisted-review.png)

การตรวจนี้ใช้ฐานข้อมูลแยกที่ reports/history_verification/history.sqlite3 ไม่ได้ใส่ข้อมูลทดสอบลงฐานข้อมูลเริ่มต้นของผู้ใช้ ไฟล์ reports และ SQLite ไม่ถูกเพิ่มเข้า Git ภาพหลักฐานแสดงผลโมเดล/metadata เท่านั้น ไม่เก็บสื่อดิบลงประวัติ

## วิธีใช้งาน

1. รัน backend ตาม README และเปิดเว็บผ่าน backend
2. วิเคราะห์ภาพ/วิดีโอหรือเริ่ม replay ตามปกติ
3. เปิด Alert / Logs หรือกดรีเฟรชประวัติ เลือกตัวกรองและดูรายละเอียด
4. กดรับทราบ/ปิดรายการ แล้วตรวจสถานะที่บันทึกไว้ได้หลังเปิด backend ใหม่

รายงานงาน 1 เป็น snapshot ก่อนเพิ่ม SQLite; รายงานนี้และชุดทดสอบรวมเป็นหลักฐานล่าสุดของส่วนที่เปลี่ยนในงาน 2 งาน 3–5 ยังไม่เริ่ม และยังต้องซ้อมการนำเสนอให้ครบภายใน 15 นาที
