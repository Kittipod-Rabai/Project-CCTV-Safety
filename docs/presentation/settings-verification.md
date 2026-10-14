# ผลตรวจงาน 5 — ค่าตั้งการวิเคราะห์ที่บันทึกได้

วันที่ตรวจ: 14 ตุลาคม 2026

**สถานะ: ทำงานจริงระดับต้นแบบบนเครื่องทดสอบแล้ว ครบแผนปรับปรุง 5 งาน**

เส้นทางที่ตรวจ: โหลดค่าจริง แก้/บันทึกในหน้าตั้งค่า อ่านค่าที่ backend ส่งถึงโมเดล วิเคราะห์ด้วยน้ำหนักจริง และเปิด backend ใหม่แล้วโหลดค่าเดิม

## สิ่งที่ทำแล้ว

- เพิ่มหน้าตั้งค่าระบบสำหรับ confidence ทั้ง 6 คลาส, NMS IoU, ขนาดภาพ YOLO, max detections, Fight threshold และ Tracking รวม 13 ค่า
- เพิ่ม GET/PUT /api/settings และตาราง app_settings ใน SQLite schema v3 พร้อม revision และเวลา ย้ายฐานเดิมโดยรักษาประวัติ/แจ้งเตือน/สถานะไว้
- ใช้ค่าเริ่มต้นโครงการเมื่อยังไม่มี record และบันทึกเฉพาะเมื่อผู้ใช้กดบันทึก การใส่ค่าเริ่มต้นในฟอร์มยังไม่เปลี่ยน backend
- ตรวจช่วง ชนิดข้อมูล และชื่อ field ก่อนบันทึก ไม่ยอมรับ boolean/string/NaN/infinity แทนตัวเลข หรือค่า integer ที่เป็นทศนิยม
- ป้องกันการเขียนทับเมื่อสองหน้าต่างแก้พร้อมกันด้วย revision และ 409 settings_conflict
- แต่ละ Stage 1, Stage 2, Pipeline และ Live session อ่าน snapshot ของค่าที่บันทึกเมื่อเริ่ม งานที่กำลังทำใช้ค่าเดิมจนจบ
- API ส่ง analysis_settings ที่ใช้จริงและ settings_revision ที่อ้างอิงกลับมา รวม Live status และรายละเอียดทางเทคนิคบนหน้า Analyze
- Upload & Analyze ใช้ค่าที่บันทึกเป็นค่าเริ่มต้น หากเลือกปรับเฉพาะรอบจะไม่บันทึกทับค่าระบบ
- แสดง loading/error และเก็บร่างเมื่อบันทึกไม่สำเร็จ ไม่มีการใช้ค่าจำลองแทนหรือรายงานสำเร็จล่วงหน้า

## ผลทดสอบอัตโนมัติ

- ชุดทดสอบรวม **316 passed, 0 failed, 0 errors, 0 skipped** ใช้เวลาประมาณ 28.13 วินาที มี deprecation warnings เดิมจาก dependencies
- ตรวจค่าที่ส่งถึง registry จริงในเส้นทาง API: thresholds/options ของ YOLO, ค่า Fight/Tracking และ response ตรงกับค่าที่บันทึก
- ตรวจ defaults/revision 0, persistence หลังเปิด app ใหม่, reset แบบบันทึก revision ใหม่ และ override บางค่าที่ไม่บันทึกทับ
- ตรวจสองผู้เขียนพร้อมกันได้ 200 หนึ่งครั้งและ 409 อีกครั้ง โดย document ของผู้ชนะยังอยู่
- ตรวจบันทึกระหว่าง inference ว่าคำขอเดิมยังใช้ revision 1 ส่วนคำขอถัดไปใช้ revision 2
- ตรวจ Live upload ที่กำลังทำยังถือ snapshot เดิม และ JSON Live start ใช้ revision ใหม่ ผ่าน capture fixture ที่ควบคุมไว้ ไม่ใช่การทดสอบ RTSP กล้องจริง
- ตรวจการย้าย schema v2 เป็น v3 ว่าประวัติ/แจ้งเตือน/audit ยังอยู่ และตรวจ JSON ค่าบันทึกเสีย/SQLite ใช้ไม่ได้ว่าไม่ fallback เงียบ
- หลังเพิ่ม assertion ของ valid PUT เมื่อ storage ใช้ไม่ได้ ตรวจชุด settings ซ้ำ **17 passed** ใช้เวลาประมาณ 2.09 วินาที
- อัปเดต response fixtures ให้มี settings_revision โดยยังตรวจ key/type ครบ ไม่ผ่อนเงื่อนไขทดสอบเดิม
- JavaScript syntax, Python compilation และ git diff --check ผ่าน

## ผลผ่านโมเดลจริงและ browser

- ใช้ YOLOv8n บน CPU กับ D-Fire test WEB11091.jpg ที่มีในเครื่อง ค่าตั้งเดิม revision 0 พบ Smoke 0.8779 และ Fire 0.3589
- บันทึกผ่านหน้าเว็บให้ Smoke/Fire threshold เป็น 0.95 และ Fight threshold เป็น 0.9 ได้ revision 1
- วิเคราะห์ภาพเดิมผ่าน Upload & Analyze โดยใช้ค่าที่บันทึก ไม่พบกล่อง Smoke/Fire ตามเกณฑ์ที่เลือก การตรวจนี้ยืนยันว่าค่ามีผลต่อ inference ไม่ใช่การปรับเทียบหรือพิสูจน์ว่าความแม่นยำดีขึ้น
- เรียก Stage 1, Stage 2, Pipeline และ Live upload ด้วยน้ำหนักจริงบน CPU ได้ analysis_settings ตรงกับค่าที่บันทึกและ revision 1
- ยกเลิกใช้ค่าที่บันทึกบนหน้า Analyze แล้วปรับ Smoke/Fire เป็น 0.2 เฉพาะรอบ พบกล่องทั้งสองประเภทอีกครั้ง และ GET /api/settings ยังเป็นค่าที่บันทึกเดิม
- ใส่ Smoke 1.2 ในหน้าตั้งค่า browser ปฏิเสธการ submit โดย revision ไม่เปลี่ยน
- ให้ API อีก client บันทึก revision 2 แล้ว submit ร่าง revision 1 จาก browser ได้ข้อความ conflict ร่าง Fight 0.85 ยังอยู่และไม่ถูกบันทึกทับ จากนั้นโหลดค่าปัจจุบันและบันทึกถูกต้องเป็น revision 3
- จำลองฐานข้อมูลใช้ไม่ได้ขณะบันทึก Smoke 0.94: ได้ error และคงร่างในฟอร์ม ไม่รายงานว่าบันทึกสำเร็จ
- เปิด backend ใหม่ด้วยฐานเดิม: document/revision/เวลาเท่าก่อน restart ค่า Smoke ยังเป็น 0.95 การบันทึกที่ล้มเหลวไม่เปลี่ยนข้อมูล และ YOLO จริงรอบใหม่ใช้ revision 3
- Reload browser แล้วหน้าตั้งค่าอ่าน revision 3 กับค่าที่บันทึกได้ ไม่พบ JavaScript warning/error ในรอบปกติ

## ขอบเขตการใช้ค่า

- มีโปรไฟล์ค่าตั้งหนึ่งชุดในเครื่อง ใช้ร่วมกันกับ YOLOv8n/s ไม่มีบัญชีผู้ใช้หรือประวัติการแก้ค่าทุก revision
- settings_revision อ้างอิงค่าตั้งต้นที่อ่าน หากมี override ต้องดู analysis_settings ใน response เพื่อทราบค่าที่ใช้จริง
- fallback ที่แยก Stage 1/2 เป็นคนละคำขอ หากบันทึกค่าระหว่างสองคำขอ อาจใช้คนละ revision ตามขอบเขตงานเดิม
- ไม่บันทึกค่า privacy, device, sampling, เกณฑ์แจ้งเหตุสงสัย หรือการจัดการกล้องผ่านหน้านี้ การเพิ่ม threshold อาจทำให้พลาดผลที่ควรตรวจพบ
- ไม่ฝึกโมเดลใหม่ ไม่เปลี่ยน YAML thresholds ต้นฉบับ และไม่ใช้การทดลองตั้งค่านี้อ้างว่าผล held-out test ดีขึ้น

## ไฟล์และหลักฐาน

- [Settings persistence](../../webapp/event_store.py), [API และการใช้ค่าจริง](../../webapp/api.py), [Live snapshot](../../webapp/live.py)
- [Settings controller](../../mockup/settings.js), [Analyze integration](../../mockup/analyze.js) และ [โครงหน้า](../../mockup/index.html)
- [Tests](../../tests/test_settings.py), [Response fixtures](../../tests/fixtures/api/stage1_image.json) และ [API contract](../web_api_contract.md)
- [JUnit](../../reports/settings_verification/pytest.xml) และ [Source hashes](../../reports/settings_verification/baseline.json)
- [ผลค่าเริ่มต้น](../../reports/settings_verification/real-defaults.json), [ผลค่าที่บันทึก](../../reports/settings_verification/real-saved.json), [Live จบงาน](../../reports/settings_verification/live-stopped.json)
- [ก่อน restart](../../reports/settings_verification/before-restart.json), [หลัง restart และ inference](../../reports/settings_verification/after-restart.json)
- [ภาพบันทึกสำเร็จ](../../reports/settings_verification/browser-saved.png), [ค่าผิดช่วง](../../reports/settings_verification/browser-invalid.png), [Conflict](../../reports/settings_verification/browser-conflict.png), [บันทึกล้มเหลว](../../reports/settings_verification/browser-save-error.png), [ค่าหลัง restart](../../reports/settings_verification/browser-persisted.png)

ใช้ฐานข้อมูลแยกที่ reports/settings_verification/history.sqlite3 ซึ่ง Git ignore ไว้ ไม่ใส่ค่าทดสอบหรือข้อมูลจำลองลงฐานข้อมูลเริ่มต้นของผู้ใช้ ไฟล์รายงานใน reports และสื่อไม่เพิ่มเข้า Git

งานปรับปรุง 1–5 ผ่านการตรวจในขอบเขตต้นแบบบนเครื่องนี้แล้ว ยังต้องเติมข้อมูลทีม เทียบวัตถุประสงค์กับข้อเสนอโครงการ ซ้อมเดโม 15 นาที และเตรียมคลิปสำรองก่อนนำเสนอ ส่วนกล้อง RTSP จริง หลายกล้อง ความแม่นยำระบบครบวงจรและ SLA ยังไม่ได้รับรอง
