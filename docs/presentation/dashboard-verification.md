# ผลตรวจงาน 3 — Dashboard จากข้อมูลจริง

วันที่ตรวจ: 14 ตุลาคม 2026

**สถานะ: ทำงานจริงระดับต้นแบบบนเครื่องทดสอบแล้ว**

เส้นทางที่ตรวจ: วิเคราะห์ไฟล์ด้วยโมเดลจริง บันทึก SQLite เปิด Dashboard เปรียบเทียบยอดกับ Logs เปลี่ยนสถานะตรวจสอบ และเปิด backend ใหม่

## สิ่งที่ทำแล้ว

- เพิ่ม GET /api/dashboard สรุปข้อมูลใน SQLite read transaction เดียว
- แสดงจำนวนแถวสรุปผลโมเดล รอตรวจสอบ รับทราบ/ปิดรายการ จำนวนรอบวิเคราะห์ ผลล่าสุด และกราฟแยกวัน/ประเภท
- เลือกวันนี้, 7 วันตามปฏิทินรวมวันนี้ หรือทั้งหมด โดยใช้ Asia/Bangkok
- อ่านสถานะเซสชันล่าสุดจาก GET /api/live/status แยกจากช่วงประวัติ ไม่ใช้จำนวนกล้องหรือ FPS สมมติ
- ลบกราฟและ KPI สุ่มของ Dashboard เดิม ส่วนข้อมูลจำลองคงใช้เฉพาะจอมอนิเตอร์ตัวอย่างในหน้า Live
- รีเฟรชเมื่อเข้าหน้า เปลี่ยนช่วงเวลา กดรีเฟรช และทุก 10 วินาทีขณะเปิด Dashboard โดยไม่ล้างหน้าระหว่างรอการอัปเดตอัตโนมัติ
- แสดงสถานะว่างเมื่อไม่มีข้อมูล และล้างยอด/กราฟเก่าพร้อมแสดง error เมื่ออ่านฐานข้อมูลไม่ได้ สถานะ Live ที่ยังอ่านได้แสดงแยกกัน

## หน่วยนับและเวลา

- หนึ่งรายการคือหนึ่งแถวต่อ run/type/model รวม Non-fight และ PPE จากกฎ จำนวน observations ที่เพิ่มในแถวเดิมไม่เพิ่ม KPI
- กราฟใช้เวลาบันทึกรายการครั้งแรก ไม่ใช่เวลาในวิดีโอหรือจำนวนเหตุจริง สถานะตรวจสอบยังไม่ใช่การยืนยันเหตุ
- กราฟรายวันแสดง 7 วันตามปฏิทินรวมวันนี้ ภายในช่วงที่เลือก หากเลือกทั้งหมด ยอดรวมและประเภทผลเป็นทั้งหมด แต่กราฟรายวันเป็นเฉพาะ 7 วันล่าสุด
- จำนวนรอบใช้เวลาเริ่มรอบ และรวมรอบที่ยังไม่มีผลตรวจจับ เวลานี้อาจต่างจากเวลาบันทึกรายการ
- Dashboard 7d เป็นวันตามปฏิทิน ส่วน Logs 7d เป็นย้อนหลัง 7 × 24 ชั่วโมง จึงต้องเลือกทั้งหมดหรือวันนี้เมื่อต้องการเทียบยอดด้วยช่วงเดียวกัน
- สถานะ Live เป็นของ backend process ปัจจุบัน หลัง restart ประวัติยังอยู่แต่ Live กลับเป็นยังไม่มีเซสชัน

## ผลทดสอบ

- ชุดทดสอบรวม **287 passed, 0 failed, 0 errors, 0 skipped** ใช้เวลาประมาณ 20.09 วินาที มี deprecation warnings เดิมจาก dependencies
- ทดสอบขอบเขตเที่ยงคืน Bangkok, จุดเริ่ม 7 วัน, จำนวนแถวเทียบกับจำนวน observations, สถานะตรวจสอบ, รอบที่ไม่มีผล, persistence และ storage failure
- ทดสอบผ่าน API ตั้งแต่วิเคราะห์ภาพ เปลี่ยนสถานะ เริ่ม/จบ replay แล้วเทียบ Dashboard กับ Logs รวมเปิด app ใหม่ด้วยฐานข้อมูลเดิม
- JavaScript syntax และ git diff --check ผ่าน

## ผลผ่านโมเดลจริงและ browser

- ใช้ YOLOv8n/X3D-S/YuNet บน CPU กับ image472.jpg และคลิปทดสอบ scfd_fight_fi008.mp4 ที่มีในเครื่อง ไม่มีการฝึกหรือดาวน์โหลดข้อมูลใหม่
- หลังวิเคราะห์ภาพและ Pipeline ได้ 5 แถวสรุปจาก 2 runs ยอดรวม/ประเภท/กราฟรายวันตรงกับ Logs
- เปิด OBS-5 ผ่าน Logs และกดรับทราบจาก browser กลับ Dashboard แล้วยอดรอตรวจสอบลดจาก 5 เป็น 4 และแสดงรับทราบ 1
- สร้าง replay-loop.avi โดยวนเฟรมคลิปเดิม 10 รอบใน reports เพื่อมีเวลาตรวจสถานะกำลังทำงาน ใช้ยืนยันการเชื่อมสถานะ ไม่ใช้วัดความแม่นยำหรือความเร็ว
- Dashboard แสดง session_id จริง สถานะกำลังประมวลผล และจำนวนเฟรม จากนั้นแสดงจบแล้วเมื่อ replay สิ้นสุด
- เมื่อจบการตรวจได้ 8 แถวสรุปจาก 3 runs มี new 7 และ ack 1 ยอดทั้งหมดตรงกับ Logs
- ตั้ง backend ทดสอบให้เปิดฐานข้อมูลไม่ได้ ได้ 503 และ Dashboard ล้างยอด/กราฟ แสดง error โดย Live ที่อ่านได้ยังแสดงแยกกัน
- คืนฐานข้อมูลเดิมและเปิด backend ใหม่: total, ประเภท, สถานะ, จำนวนรอบ, กราฟ และรายการล่าสุดเท่ากับก่อน restart ส่วน Live กลับ idle ตามจริง
- browser ไม่พบ JavaScript warning/error ในรอบปกติ ข้อผิดพลาด API ในรอบทดสอบ 503 เป็นสิ่งที่ตั้งใจให้เกิด

## ไฟล์และหลักฐาน

- [Storage aggregation](../../webapp/event_store.py) และ [HTTP API](../../webapp/api.py)
- [Dashboard controller](../../mockup/dashboard.js) และ [โครงหน้า](../../mockup/index.html)
- [Integration tests](../../tests/test_dashboard.py) และ [API contract](../web_api_contract.md)
- [JUnit](../../reports/dashboard_verification/pytest.xml) และ [Source hashes](../../reports/dashboard_verification/baseline.json)
- [ผลโมเดลจริง/ยอดเทียบ Logs](../../reports/dashboard_verification/real-api.json)
- [Live running](../../reports/dashboard_verification/live-running.json) และ [Live stopped](../../reports/dashboard_verification/live-stopped.json)
- [ก่อน restart](../../reports/dashboard_verification/before-restart.json) และ [หลัง restart](../../reports/dashboard_verification/after-restart.json)
- [ภาพ Dashboard](../../reports/dashboard_verification/browser-dashboard.png), [ภาพ Live กำลังทำงาน](../../reports/dashboard_verification/browser-live.png) และ [ภาพกรณี error](../../reports/dashboard_verification/browser-error.png)

ใช้ฐานข้อมูลแยกที่ reports/dashboard_verification/history.sqlite3 หลักฐานและคลิปทดสอบอยู่ใน reports ซึ่ง Git ignore ไว้ ไม่เพิ่มฐานข้อมูลหรือสื่อทดสอบเข้า Git

งาน 1–3 ตรวจแล้วในขอบเขตต้นแบบบนเครื่องนี้ เหลืองาน 4 แจ้งเตือนภายในเว็บและงาน 5 หน้าตั้งค่าที่บันทึกได้ ยังไม่รับรองกล้อง RTSP จริง หลายกล้อง ความแม่นยำครบระบบ หรือ SLA และยังต้องซ้อมการนำเสนอ/เตรียมคลิปสำรอง
