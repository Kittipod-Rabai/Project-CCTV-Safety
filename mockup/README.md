# CCTV Safety — Draft Mockup (Handoff Package)


> **สถานะ (2026-10-14):** Educational pilot — Dashboard และจอมอนิเตอร์ตัวอย่างยังใช้ข้อมูลจำลอง
> ส่วน Upload & Analyze และ Live replay เรียกโมเดลจริง และ Alert / Logs อ่านประวัติผลโมเดลจาก SQLite ผ่าน backend แล้ว
> มีการบันทึกรับทราบ/ปิดรายการ แต่ไม่ใช่การยืนยันเหตุ ไม่ได้ส่งแจ้งเตือนภายนอก และยังไม่มีระบบบัญชีผู้ใช้
> ดู [หลักฐานงาน 2](../docs/presentation/history-verification.md)
>
> **หมายเหตุ Schema:** หน้า mock ใช้ประเภทเหตุการณ์จำลอง 4 กลุ่มเพื่อสาธิต UI
> เท่านั้น ไม่ใช่ class list ของโมเดล ปัจจุบัน Stage 1 ใช้ detector schema v2
> จำนวน 6 spatial classes ใน `../docs/data_schema_6classes.md` และคำนวณ
> `no_helmet`/`no_vest` ด้วย post-processing ส่วน `fight` เป็น Stage 2 temporal
> event (X3D-S pilot) ซึ่งหน้า Upload & Analyze รันร่วมกับ Stage 1 ใน shadow
> mode สำหรับวิดีโอ แต่ยังไม่ใช่ระบบแจ้งเตือนที่ผ่านการประเมิน ดู `../docs/project_status.md`.

---

## โครงสร้าง Handoff Package

```text
mockup/
├── index.html      # UI ทั้งหมด (หน้า mock 3 หน้า + โครง HTML/CSS ของหน้า Upload & Analyze)
├── analyze.js      # logic ของหน้า Upload & Analyze: เรียก API จริง, วาด box บน canvas
└── README.md
```

---

## วิธีรัน

### หน้า Upload & Analyze (ต้องรันผ่าน backend)

หน้า `index.html` ถูก serve โดย FastAPI ที่ `/` และเรียก API แบบ same-origin
(`/api/health`, `/api/stage1/analyze`, `/api/stage2/analyze`, `/api/pipeline/analyze`) — ดู section 5 ของ
`../docs/web_api_contract.md`

```powershell
# จาก root ของ repo; ไฟล์ .pt อยู่ใน ./weights (หรือกำหนด CCTV_WEIGHTS_DIR)
.\.venv-test\Scripts\python.exe -m uvicorn webapp.api:app --host 127.0.0.1 --port 8000
```

แล้วเปิด `http://127.0.0.1:8000/` → เมนู **Upload & Analyze** (ไม่มีระบบ login; ใช้เฉพาะในเครื่อง)

ถ้าเปิด `index.html` ตรงๆ จากไฟล์ (`file://`) หน้า mock ยังใช้ได้ แต่หน้า Upload & Analyze
จะแสดง "เชื่อมต่อ API ไม่ได้ — รัน backend ก่อน"

### หน้า mock อื่นๆ

เฉพาะ Dashboard และจอมอนิเตอร์ตัวอย่างเปิดจากไฟล์ได้; Upload & Analyze, Live pilot และ Logs ต้องใช้ backend หากอ่าน API ไม่ได้ Logs จะแสดง error โดยไม่ใช้ข้อมูลสุ่มแทน

---

##  หน้าจอที่มีใน Mockup

- **Dashboard:** KPI/กราฟ/สถานะกล้องยังเป็นข้อมูลจำลอง
- **Live CCTV Monitoring:** แผง Live replay เรียกโมเดลจริง; จอมอนิเตอร์ตัวอย่างด้านล่างเป็น mock ส่วน RTSP ยังไม่ยืนยันกับกล้องจริง
- **Alert / Logs:** ประวัติผลตรวจจับจริงจาก SQLite พร้อมค้นหา ช่วงเวลาบันทึก แหล่งไฟล์ ประเภทผล สถานะตรวจสอบ แบ่งหน้า และ audit การเปลี่ยนสถานะ ไม่เก็บภาพ/คลิป
- **Upload & Analyze:** วิเคราะห์ภาพ/วิดีโอด้วย YOLO/X3D ผ่าน API

หน้า **จัดการกล้อง** และ **ตั้งค่าระบบ** มีเมนูไว้แล้วแต่ยังไม่ได้ออกแบบ (ปุ่มกดได้แต่ไม่ทำอะไร)

### หน้า Upload & Analyze (`#v-analyze` + `analyze.js`) — plan sections 9.2–9.4

- **อินพุต:** เลือกไฟล์ (`.jpg .jpeg .png .bmp .webp .mp4 .avi .mov .mkv`, ≤ 100 MB) และโมเดล Stage 1
  (`yolov8n` / `yolov8s`) แล้วกด Analyze — preview ย่อเป็น thumbnail หลังวิเคราะห์ (object URL ถูก revoke เมื่อเปลี่ยนไฟล์)
- **ทุกอย่างมาจาก response ของการวิเคราะห์ครั้งปัจจุบันเท่านั้น:** เลือกไฟล์ใหม่หรือกด Analyze ใหม่จะล้างผลเดิมทั้งหมด
  (สรุป, chip, ตาราง PPE, canvas, ไทม์ไลน์, รายละเอียดทางเทคนิค) และ response ของรอบเก่าที่มาช้าจะถูกทิ้ง;
  ถ้า Stage ใด error จะไม่มีผลเก่าค้าง ตัวกรองการแสดงผลกลับเป็นค่าเริ่มต้นทุกครั้ง
- **วิดีโอ — ตรวจว่าเบราว์เซอร์เล่นได้ไหม (probe):** `<video>` preview ต้องเกิด `loadeddata` และมี `videoWidth > 0` ภายใน 6 วินาที
  - เล่นได้ → pipeline เรียก Stage 1 `mode=dense` (`sample_fps` 1–30, ค่าเริ่มต้น 10) และ Stage 2 ในคำขอเดียว
    องค์ประกอบวิดีโอต้นฉบับถูกซ่อนและวาดลง canvas แบบ opaque; ทุกเฟรมที่แสดงต้องผ่าน face mask จาก YuNet แล้วจึงวาดกล่อง
    ถ้าขั้นตอน anonymization หรือการวาดล้มเหลว canvas จะไม่แสดงภาพต้นฉบับ
    วาดกล่องของตัวอย่าง dense ที่ใกล้ `currentTime` ที่สุด (เฉพาะถ้าห่างไม่เกิน `1/sample_fps`), คำนวณกรอบภาพจริงตาม
    `object-fit: contain` และวาดใหม่เมื่อ resize / seek / ระหว่างเล่น; มุมขวาบนแสดง "Stage 2: ทะเลาะ / ปกติ" (ไม่มีเวลา)
  - เล่นไม่ได้ (เช่น mp4 `mp4v` จาก OpenCV) → Stage 1 `mode=frames` (`max_frames` 1–60, ค่าเริ่มต้น 16) แสดงภาพทีละเฟรม
    และบอกเหตุผล; ถ้า dense ตอบ `video_too_long` จะลองใหม่แบบ `frames` อัตโนมัติ
- **ไทม์ไลน์เส้นเดียว (9.4.1):** ใต้ภาพมีแถบแบบ slider "▶ ‹ ก่อนหน้า ─●─ ถัดไป ›" — วิดีโอที่เล่นได้ แถบนี้ **คือแถบเลื่อนเวลา**
  ของวิดีโอ (ลาก/คลิกเพื่อ seek, หัวเลื่อนตามการเล่น, ปุ่มก่อนหน้า/ถัดไป = ±1 ตัวอย่าง); โหมด frames แถบนี้คือ slider เลือกเฟรม;
  ช่วงที่ Stage 2 ให้ label `fight` แสดงเป็น **แถบแดง** บนเส้น (`<input type="range">` จึงใช้คีย์บอร์ดได้)
- **Stage 2:** แสดงเพียง "⚠ พบการทะเลาะ" หรือ "✓ ไม่พบการทะเลาะ" (จาก `summary.fight_windows`);
  เวลาแต่ละช่วง, label, ความน่าจะเป็นดิบ, `max_fight_prob` และ `fight_windows / total_windows` อยู่ใน "รายละเอียดทางเทคนิค"
- **Stage 1 สรุปสั้น:** แสดงจำนวนเป็น "กล่อง person สูงสุด N กล่อง/เฟรม" ไม่อ้างเป็นจำนวนบุคคลจริง เพราะไม่มี tracking ที่ยืนยันอัตลักษณ์และกล่องซ้ำอาจทำให้จำนวนเกินจริง; PPE เป็นผลที่คำนวณจากกล่องเหล่านี้ ส่วน Fall/Fire/Smoke เป็นสัญญาณจากโมเดลที่ต้องตรวจทาน
- **มุมมอง (9.4.8):** ตัวเลือก "แสดงผล: มุมมอง PPE | เลือก class" — ถ้า response มีคน เปิดที่ **มุมมอง PPE** เป็นค่าเริ่มต้น
  (กล่องคนสีเขียว = ไม่มี alert / แดง = มี alert, หมายเลข #i ตรงกับตาราง PPE, สีมาจาก `ppe` rows ของ API เท่านั้น);
  **เลือก class** = เลือก class ที่จะวาดด้วย chip (ชื่ออย่างเดียว เช่น "คน (person)") — chip ใช้เฉพาะในมุมมองนี้;
  ไฟ/ควัน/คนล้มถูกวาดในทั้งสองมุมมอง; ถ้าไม่พบคนหรือปิด "ตรวจ PPE" จะใช้มุมมอง class
- **"ตรวจ PPE" (9.4.7, ค่าเริ่มต้นเปิด):** ปิดแล้วซ่อน alert PPE จากสรุป ตาราง และสีกล่อง (เช่น ฉากที่ไม่ใช่งานก่อสร้าง) — การแสดงผลเท่านั้น
- **slider "แสดงเฉพาะคะแนน ≥ X"** (ค่าต่ำสุด = threshold ต่ำสุดของ API) — กรองการแสดงผลเท่านั้น ไม่ส่งไป API
  ไม่เปลี่ยน threshold และไม่เปลี่ยนผล PPE
- **กล่องอ่านง่าย (9.3):** label ขนาดคงที่ ~11.5 CSS px ไม่ขึ้นกับความละเอียดภาพ, เส้นบาง, label อยู่ในกรอบภาพ,
  label ของ person วางเหนือ/ใต้กล่องก่อนเพื่อไม่บังหน้า; วิดีโอและภาพใช้โค้ดวาดเดียวกัน (`drawScene()`)
- **แผงขวา "ผลตรวจ…"** (ภาพนิ่งและวิดีโอ): จำนวนวัตถุในเฟรม/ภาพนี้ + ตาราง PPE แบบย่อ (แถวที่มี alert ขึ้นก่อน,
  hover/focus แถวจะไฮไลต์กล่องของคนนั้น)
- **รายละเอียดทางเทคนิค** (`<details>` ปิดไว้ก่อน): model, mode, sample_fps, fps, schema_version, threshold ต่อ class,
  ppe_min_confidence, กฎสรุปวิดีโอ, สถานะ API (device / โมเดล / ปุ่มรีเฟรช) และผลรายช่วงของ Stage 2
  รวมถึงเวลาวัด decoder, YuNet, YOLO, X3D และเวลารวมจาก API (ตัวเลขขึ้นกับฮาร์ดแวร์/codec)
  Track IDs ถูกสร้างจากกล่อง person ที่ตรวจพบ จึงอาจซ้ำตามกล่องซ้ำและไม่ใช่การยืนยันอัตลักษณ์บุคคล
- **ป้าย "ผลจากโมเดลจริง — pilot"** แสดงเฉพาะเมื่อ response มี `is_model_output === true` พร้อม `disclaimer` จาก API
  (chip บน topbar "หน้าเรียก API จริง · pilot" เป็นแค่ป้ายบอกหน้า)
- **Error:** `{error:{code,message}}` → ข้อความภาษาไทยตาม `code` (+ ข้อความต้นฉบับ); เชื่อมต่อไม่ได้ →
  "เชื่อมต่อ API ไม่ได้ — รัน backend ก่อน"
- **ความปลอดภัย:** ข้อความจาก API เขียนด้วย `textContent` / `fillText` เท่านั้น (ไม่ใช้ `innerHTML`);
  `analyze.js` ไม่ใช้ `Math.random` และไม่อ่าน mock data ของ `index.html`

**ไฟล์วิดีโอทดสอบที่เบราว์เซอร์เล่นได้:** OpenCV `VideoWriter` ด้วย fourcc `'avc1'` ใน `.mp4` ได้ H.264 ที่ Chrome
เล่นได้ (ในเครื่องนี้ OpenCV เตือนว่าโหลด OpenH264 DLL ไม่ได้ แต่ไฟล์ที่ได้เป็น h264 และเล่นได้);
`'mp4v'` เล่นใน Chrome ไม่ได้ (ใช้ทดสอบ fallback ได้)

---

##  แผนที่โค้ด (Code Map)

`index.html` แบ่งเป็น 3 ส่วนใหญ่ — แก้ตรงไหนดูจากตารางนี้ (เลขบรรทัดโดยประมาณ)

| บรรทัด | ส่วน | หมายเหตุ |
|---:|:---|:---|
| 7–521 | `<style>` ทั้งหมด | |
| **8–18** | `:root` design tokens | **แก้สี/ธีมทั้งระบบที่นี่จุดเดียว** |
| 344–354 | `.mock-banner`, `.sys-mock` | แถบ/ป้าย "ข้อมูลจำลอง" ของหน้า mock; กล่องสถานะ sidebar ซ่อนในหน้า analyze |
| 356–500 | สไตล์ `az-*` ของหน้า Upload & Analyze | |
| 526–574 | Sidebar + navigation (รวมเมนู `data-go="analyze"`) | |
| 578–588 | TopBar (ชื่อหน้า, chip MOCKUP / "หน้าเรียก API จริง", นาฬิกา, avatar) | chip สลับตามหน้า ผ่าน `body[data-page]` |
| 591–658 | HTML หน้า Dashboard | |
| 661–699 | HTML หน้า Live Monitoring | |
| 702–770 | HTML หน้า Alert / Logs | |
| 773–913 | HTML หน้า Upload & Analyze (`#v-analyze`) | logic อยู่ใน `analyze.js` |
| 917–935 | Modal รายละเอียดเหตุการณ์ | |
| 937–1370 | `<script>` (mock) ทั้งหมด | |
| **938–991** | **Mock data ทั้งหมด** | `CLS`, `CAMS`, `LOGS` |
| 939 | `CLS` — นิยาม 4 classes | สี + ชื่อไทย + ระดับความรุนแรง |
| 946 | `CAMS` — กล้อง 14 ตัว | id, โซน, สถานะ, fps |
| 970–989 | สร้าง `LOGS` 90 รายการแบบสุ่ม | **ลบทิ้งทั้งบล็อกตอนต่อ API** |
| 1008 | `go(page)` — สลับหน้า | router แบบง่ายๆ (ตั้ง `body[data-page]` ด้วย) |
| 1024–1099 | กราฟ Dashboard (SVG เขียนเอง) | `spark()`, `bars()`, `donut()` |
| 1102–1161 | `SCENES` — ฉากกล้องจำลอง | **ลบทิ้งเมื่อมี video stream จริง** |
| 1163 | `camHTML()` — สร้าง tile กล้อง + bounding box | |
| 1237 | `pushFeed()` — live event stream | เปลี่ยนเป็น WebSocket handler |
| 1270 | `filtered()` — ตัวกรองตาราง | ย้ายไป query string ฝั่ง server |
| 1290 | `render()` — วาดตาราง + pagination | |
| 1333 | `openModal()` — modal รายละเอียด | |
| 1372 | `<script src="analyze.js">` | โหลดหลัง script mock |

`analyze.js` (IIFE เดียว): ค่าคงที่จากสัญญา API → `callApi()` (แปลง error เป็นข้อความไทย) → `loadHealth()` →
`resetResults()` (ล้างผลทั้งหมด + ยกเลิก response รอบเก่า) → `onFileChange()` + `probeVideo()` →
`drawScene()` / `drawLabel()` (ใช้ร่วมกันทั้งภาพและวิดีโอ) → `renderNow()` (แผงขวา + ตาราง PPE) →
โหมด frames: `drawFrame()` / โหมด player: `nearestSample()`, `contentRect()`, `drawOverlay()` →
ไทม์ไลน์: `setupTrack()`, `trackFrac()`, `renderSeekMarks()` → ตัวกรอง: `applyViewControls()`, `setupFilters()` →
`stage1Summary()` / `renderStage1()` → `renderStage2()` → `analyze()`

---

## Mock → Real: ต้องเปลี่ยนอะไรบ้าง (หน้า mock)

| ตอนนี้ (mock) | ต้องเปลี่ยนเป็น ||
|:---|:---|:---|
| `LOGS` สุ่มในเบราว์เซอร์ | `GET /api/v1/events` | 
| `CAMS` hardcode 14 ตัว | `GET /api/v1/cameras` | 
| ตัวเลข KPI hardcode ใน HTML | `GET /api/v1/stats/summary` | 
| กราฟสุ่มใน `bars()` / `donut()` | `GET /api/v1/stats/hourly`, `/by-class` | 
| `SCENES` ฉาก CSS | `<video>` + HLS / WebRTC | 
| bounding box ตำแหน่งคงที่ | WebSocket `detection` frame | 
| `pushFeed()` สุ่มทุก 4.2 วิ | WebSocket `alert` event | 
| `filtered()` กรองใน JS | query params → server | 
| ปุ่ม "รับทราบเหตุการณ์" ไม่ทำอะไร | `PATCH /api/v1/events/{id}` | 

Endpoint ในตารางนี้เป็นแนวคิดสำหรับอนาคต **ยังไม่มีอยู่จริง** — API ที่มีจริงตอนนี้มีเฉพาะ
`/api/health`, `/api/stage1/analyze`, `/api/stage2/analyze` (ใช้ในหน้า Upload & Analyze)

---

## ประวัติผลตรวจจับจริง

ฐานข้อมูลเริ่มต้นคือ `data/local/cctv_safety.sqlite3` ซึ่ง Git ignore ไว้ สร้างเมื่อ backend ใช้งานประวัติครั้งแรก เปลี่ยนตำแหน่งได้ด้วย `CCTV_EVENTS_DB_PATH` และใช้หนึ่ง backend process ต่อฐานข้อมูล

เปิดเมนู Alert / Logs หลังวิเคราะห์ไฟล์ หรือกดรีเฟรชประวัติ ข้อมูลไม่มีการสร้างย้อนหลังจาก mock เดิม การวิเคราะห์ซ้ำสร้าง run ใหม่ ส่วนผลชนิดเดียวกันภายใน run เดียวรวมจำนวน observations และคะแนนสูงสุด แสดงเวลาในวิดีโอแยกจากเวลาบันทึก Asia/Bangkok

สถานะรอตรวจสอบ/รับทราบ/ปิดรายการไม่ยืนยันเหตุจริง ไม่มีผู้รับผิดชอบสมมติ และไม่มีระบบแจ้งเตือนในงานนี้ ดู API และข้อจำกัดที่ [สัญญา API](../docs/web_api_contract.md) และ [รายงานตรวจ](../docs/presentation/history-verification.md) Code Map แบบเลขบรรทัดในส่วนก่อนหน้าเป็นข้อมูลเก่า ให้ค้นหาด้วย view IDs และชื่อไฟล์ปัจจุบันแทน
