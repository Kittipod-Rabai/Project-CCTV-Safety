/* =====================================================================
 * Upload & Analyze — real inference via the local FastAPI backend.
 *
 * HTTP contract: docs/web_api_contract.md (schema_version "1.0", round 2),
 * example responses: tests/fixtures/api/*.json.
 *
 * Rules for this file:
 *  - Only real API output is rendered here. No generated / placeholder
 *    numbers and no access to the mock data in index.html.
 *  - Everything shown is derived from the responses of the CURRENT
 *    upload only; a new file or a new Analyze clears all previous output.
 *  - API strings are written with textContent / canvas fillText only.
 *  - Display filters (class toggles, PPE view, "ตรวจ PPE", score slider)
 *    only change what is drawn/listed; they never change API thresholds
 *    or the API's PPE rows.
 *
 * Video flow: the browser first probes whether it can play the file
 * (<video> loadeddata / error). Playable → Stage 1 mode=dense, the
 * original file is hidden behind an opaque, face-blurred canvas synced to currentTime and
 * the timeline track is the seek bar. Not playable → Stage 1 mode=frames
 * (JPEG frames) and the same track is the frame slider. Stage 2 "fight"
 * windows are highlighted red on that track.
 * Both views draw through the same drawScene() in CSS pixels, so labels
 * keep a fixed on-screen size whatever the source resolution.
 * ===================================================================== */
(function () {
  'use strict';

  /* ---------------- constants (from the contract) ---------------- */
  const API = {
    health: '/api/health',
    stage1: '/api/stage1/analyze',
    stage2: '/api/stage2/analyze',
    pipeline: '/api/pipeline/analyze'
  };
  const IMAGE_EXT = ['.jpg', '.jpeg', '.png', '.bmp', '.webp'];
  const VIDEO_EXT = ['.mp4', '.avi', '.mov', '.mkv'];
  const MAX_BYTES = 104857600; // 100 MB
  const MAX_FRAMES = { min: 1, max: 60, def: 16 };
  const SAMPLE_FPS = { min: 1, max: 30, def: 10 };
  const HEALTH_MODELS = ['yolov8n', 'yolov8s', 'x3d_s'];
  const PROBE_TIMEOUT_MS = 6000;

  const MSG_NETWORK = 'เชื่อมต่อ API ไม่ได้ — รัน backend ก่อน';
  const ERROR_TH = {
    missing_file: 'ไม่พบไฟล์ หรือไฟล์ว่าง (0 ไบต์)',
    invalid_parameter: 'พารามิเตอร์ไม่ถูกต้อง (model ต้องเป็น yolov8n / yolov8s, จำนวนเฟรม 1–60, ความถี่ตรวจ 1–30 ครั้ง/วินาที)',
    file_too_large: 'ไฟล์ใหญ่เกิน 100 MB',
    media_dimensions_too_large: 'ความละเอียดของภาพหรือเฟรมวิดีโอเกินขีดจำกัดที่ระบบรองรับ',
    analysis_busy: 'มีงานวิเคราะห์อื่นกำลังทำงานอยู่ กรุณารอให้เสร็จก่อนแล้วลองอีกครั้ง',
    unsupported_media_type: 'ชนิดไฟล์ไม่รองรับ — ใช้ได้เฉพาะ .jpg .jpeg .png .bmp .webp .mp4 .avi .mov .mkv',
    decode_failed: 'อ่านไฟล์ไม่ได้ — ถอดรหัสภาพ/วิดีโอไม่สำเร็จ (ไฟล์เสีย หรือ codec ไม่รองรับ)',
    video_required: 'ต้องใช้ไฟล์วิดีโอ (mp4, avi, mov, mkv)',
    video_too_long: 'วิดีโอยาวเกินไป (เกิน 30 ช่วง × 2 วินาที หรือประมาณ 60 วินาที)',
    weights_missing: 'ไม่พบไฟล์น้ำหนักโมเดล (.pt) — คัดลอกไฟล์ไปไว้ในโฟลเดอร์ weights ก่อน',
    model_load_failed: 'โหลดโมเดลไม่สำเร็จ (ไฟล์น้ำหนักหรือ runtime contract ไม่ถูกต้อง)',
    device_unavailable: 'อุปกรณ์ที่เลือกใช้งานไม่ได้ใน runtime นี้ — เลือก Auto/CPU หรือเตรียม CUDA runtime ให้ครบ',
    privacy_model_unavailable: 'ไม่พบหรือโหลด YuNet ไม่ได้ — ซ่อนไฟล์ต้นฉบับไว้เพื่อความเป็นส่วนตัว',
    anonymization_incomplete: 'ตรวจใบหน้าไม่ครบทุกเฟรม — ซ่อนไฟล์ต้นฉบับไว้เพื่อความเป็นส่วนตัว',
    internal_error: 'เกิดข้อผิดพลาดภายใน backend ระหว่างประมวลผล — ลองใหม่ หรือตรวจ log ของ server',
    not_found: 'ไม่พบ endpoint ของ API — ตรวจว่ารัน backend เวอร์ชันที่ถูกต้อง',
    method_not_allowed: 'เรียก API ด้วย HTTP method ที่ไม่ถูกต้อง'
  };
  const HEALTH_TH = { loaded: 'โหลดแล้ว', available: 'พร้อมโหลด', missing: 'ไม่พบไฟล์' };
  const S1_IDLE = 'เลือกไฟล์แล้วกด Analyze เพื่อเริ่มวิเคราะห์';
  const S2_IDLE = 'Stage 2 ต้องใช้ไฟล์วิดีโอ — จะเรียกเฉพาะเมื่ออัปโหลดวิดีโอ';

  // Plain-Thai names for the schema v2 classes (English name is shown too).
  const CLASS_TH = { person: 'คน', helmet: 'หมวกนิรภัย', vest: 'เสื้อสะท้อนแสง', fall: 'คนล้ม', fire: 'ไฟ', smoke: 'ควัน' };
  const HAZARD = ['fall', 'fire', 'smoke'];
  const HAZARD_SENTENCE = { fire: 'พบสัญญาณไฟ', smoke: 'พบสัญญาณควัน', fall: 'พบสัญญาณ Fall · ตรวจสอบ' };
  const S2_TH = { fight: 'ทะเลาะ', non_fight: 'ปกติ' };

  const CLASS_COLOR = {
    person: '#38bdf8', helmet: '#22c55e', vest: '#facc15',
    fall: '#f59e0b', fire: '#ef4444', smoke: '#a3b1c2'
  };
  const FALLBACK_COLOR = ['#38bdf8', '#22c55e', '#facc15', '#f59e0b', '#ef4444', '#a3b1c2', '#e879f9'];
  const PPE_OK = '#22c55e', PPE_BAD = '#ef4444', HL_COLOR = '#ffffff';
  // On-screen drawing sizes in CSS px (independent of the source resolution).
  const LABEL_PX = 11.5, LINE_PX = 1.5, PPE_LINE_PX = 2.5;
  const FRAME_MAX_H = () => Math.round(window.innerHeight * 0.62);

  /* ---------------- helpers ---------------- */
  const $ = id => document.getElementById(id);
  const has = (o, k) => Object.prototype.hasOwnProperty.call(o, k);

  // Create an element; `text` is always assigned through textContent.
  function el(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined && text !== null) e.textContent = String(text);
    return e;
  }
  function clear(node) { while (node.firstChild) node.removeChild(node.firstChild); }
  const isNum = v => typeof v === 'number' && isFinite(v);
  function num(v, d) { return isNum(v) ? v.toFixed(d) : '—'; }
  function sec(v) { return isNum(v) ? v.toFixed(1) : '—'; }
  function colorFor(name, id) {
    if (has(CLASS_COLOR, name)) return CLASS_COLOR[name];
    const i = (typeof id === 'number' && id >= 0) ? id : 0;
    return FALLBACK_COLOR[i % FALLBACK_COLOR.length];
  }
  function clsTh(name) { return has(CLASS_TH, name) ? CLASS_TH[name] : name; }
  function extOf(name) {
    const i = name.lastIndexOf('.');
    return i < 0 ? '' : name.slice(i).toLowerCase();
  }
  function mediaKind(file) {
    const e = extOf(file.name);
    if (IMAGE_EXT.indexOf(e) >= 0) return 'image';
    if (VIDEO_EXT.indexOf(e) >= 0) return 'video';
    return null;
  }
  function clampInt(v, r) {
    const n = parseInt(v, 10);
    return isFinite(n) ? Math.max(r.min, Math.min(r.max, n)) : r.def;
  }
  function clampFloat(v, r) {
    const n = parseFloat(v);
    return isFinite(n) ? Math.max(r.min, Math.min(r.max, n)) : r.def;
  }
  function setPressed(btn, on) {
    btn.setAttribute('aria-pressed', String(on));
    btn.classList.toggle('on', on);
  }

  /* ---------------- elements ---------------- */
  const ui = {
    file: $('azFile'), model: $('azModel'), device: $('azDevice'), run: $('azRun'), status: $('azStatus'),
    fileInfo: $('azFileInfo'), preview: $('azPreview'), probe: $('azProbe'),
    maxFrames: $('azMaxFrames'), maxFramesWrap: $('azMaxFramesWrap'),
    sampleFps: $('azSampleFps'), sampleFpsWrap: $('azSampleFpsWrap'),
    faceConfidence: $('azFaceConfidence'), faceConfidenceValue: $('azFaceConfidenceValue'),
    facePadding: $('azFacePadding'), facePaddingValue: $('azFacePaddingValue'),
    faceBlur: $('azFaceBlur'), faceBlurValue: $('azFaceBlurValue'),
    modelSettings: {
      person: $('azThPerson'), helmet: $('azThHelmet'), vest: $('azThVest'), fall: $('azThFall'), fire: $('azThFire'), smoke: $('azThSmoke'),
      iou: $('azYoloIou'), imgsz: $('azYoloImg'), maxDet: $('azYoloMaxDet'),
      fight: $('azX3dThreshold'), proximity: $('azTrackProximity'), motion: $('azTrackMotion'), gap: $('azTrackGap')
    },
    apiDot: $('azApiDot'), apiText: $('azApiText'),
    healthDevice: $('azHealthDevice'), healthModels: $('azHealthModels'), healthMsg: $('azHealthMsg'),
    healthRefresh: $('azHealthRefresh'),
    s1Badge: $('azS1Badge'), s1State: $('azS1State'), s1Body: $('azS1Body'),
    s1Sentence: $('azS1Sentence'), s1Chips: $('azS1Chips'), s1Notice: $('azS1Notice'),
    ppeCheck: $('azPpeCheck'), viewPpe: $('azViewPpe'), viewCls: $('azViewCls'), viewGroup: $('azViewGroup'),
    conf: $('azConf'), confVal: $('azConfVal'),
    player: $('azPlayer'), video: $('azVideo'), overlay: $('azOverlay'), corner: $('azCorner'),
    frameView: $('azFrameView'), s1Canvas: $('azS1Canvas'),
    seek: $('azSeek'), play: $('azPlay'), prev: $('azPrev'), next: $('azNext'),
    seekRange: $('azSeekRange'), seekMarks: $('azSeekMarks'), seekTime: $('azSeekTime'), seekLegend: $('azSeekLegend'),
    nowTitle: $('azNowTitle'), nowDets: $('azNowDets'), s1Ppe: $('azS1Ppe'),
    s1Meta: $('azS1Meta'), s1Rule: $('azS1Rule'), s1Counts: $('azS1Counts'), s1Disclaimer: $('azS1Disclaimer'),
    s2Badge: $('azS2Badge'), s2State: $('azS2State'), s2Body: $('azS2Body'), s2Sentence: $('azS2Sentence'),
    s2Meta: $('azS2Meta'), s2Raw: $('azS2Raw'), s2Disclaimer: $('azS2Disclaimer')
  };
  if (!ui.file || !ui.run) return; // view not present

  /* ---------------- state ---------------- */
  const st = {
    file: null, kind: null, url: null,   // selected file + its object URL (preview + player)
    probe: null,                          // Promise<{ok:boolean, reason:string}> for videos
    s1: null, s2: null,                   // responses of the CURRENT analysis only
    view: null,                           // 'player' | 'frames'
    cur: 0,                               // frames view: position in s1.frames
    images: [],                           // frames view: decoded JPEG per frame (current response only)
    faceBlur: null,                       // face boxes for every dense-video frame
    lastSample: -2,                       // player view: last drawn sample (-1 = none)
    seeking: false,                       // user is dragging the seek track
    // display-only filters (reset to defaults for every new analysis)
    hidden: {}, ppeCheck: true, viewMode: 'cls', minConf: 0, hl: null   // viewMode: 'ppe' | 'cls'
  };
  let runToken = 0, drawToken = 0, rafId = 0;
  const faceMosaicCanvas = document.createElement('canvas');

  /* ---------------- API ---------------- */
  // Resolves to {ok:true, data} or {ok:false, message, code?, detail?}.
  async function callApi(url, options) {
    let res;
    try {
      res = await window.CCTVMode.fetch(url, options);
    } catch (e) {
      return { ok: false, message: MSG_NETWORK };
    }
    let body = null;
    try { body = await res.json(); } catch (e) { body = null; }
    if (res.ok) {
      if (body && typeof body === 'object') return { ok: true, data: body };
      return { ok: false, message: 'API ตอบกลับในรูปแบบที่ไม่รู้จัก (HTTP ' + res.status + ')' };
    }
    const err = body && body.error;
    if (err && typeof err.code === 'string') {
      const th = ERROR_TH[err.code] || ('เกิดข้อผิดพลาดจาก API (HTTP ' + res.status + ')');
      return { ok: false, code: err.code, message: th, detail: typeof err.message === 'string' ? err.message : '' };
    }
    if (res.status === 404) return { ok: false, message: MSG_NETWORK + ' (ไม่พบ endpoint — HTTP 404)' };
    return { ok: false, message: 'เกิดข้อผิดพลาดจาก API (HTTP ' + res.status + ')' };
  }

  function setState(node, kind, text, detail) {
    clear(node);
    node.className = 'az-state az-state-' + kind;
    if (kind === 'loading') node.appendChild(el('span', 'az-spin'));
    node.appendChild(el('span', null, text));
    if (detail) node.appendChild(el('div', 'az-detail', detail));
    node.hidden = false;
  }
  function errorText(r) { return r.code ? r.message + ' [' + r.code + ']' : r.message; }

  /* ---------------- health (small dot + text; details collapsed) ---------------- */
  let healthToken=0;
  async function loadHealth() {
    const token=++healthToken;
    ui.healthMsg.hidden = true;
    const r = await callApi(API.health, { cache: 'no-store' });
    if(token!==healthToken)return;
    clear(ui.healthModels);
    if (!r.ok) {
      ui.apiDot.className = 'dot az-dot-bad';
      ui.apiText.textContent = r.message;
      ui.healthDevice.textContent = '—';
      ui.healthMsg.textContent = r.message;
      ui.healthMsg.hidden = false;
      return;
    }
    const h = r.data;
    if (window.CCTVMode.active) { ui.apiDot.className='dot ok'; ui.apiText.textContent='โหมดสาธิต · ใช้ผลบันทึก/สมมติในเครื่อง · ไม่ inference ใหม่'; ui.healthDevice.textContent='ไม่ได้รันโมเดล'; return; }
    const device = typeof h.device === 'string' ? h.device : '—';
    ui.healthDevice.textContent = device;
    const runtime = h.runtime || {};
    const models = (h.models && typeof h.models === 'object') ? h.models : {};
    const missing = [];
    HEALTH_MODELS.forEach(name => {
      const s = typeof models[name] === 'string' ? models[name] : 'unknown';
      if (s === 'missing') missing.push(name);
      const row = el('div', 'az-hrow');
      row.appendChild(el('span', 'mono', name));
      row.appendChild(el('span', 'az-hst az-hst-' + (HEALTH_TH[s] ? s : 'unknown'), (HEALTH_TH[s] || s) + ' · ' + s));
      ui.healthModels.appendChild(row);
    });
    ui.apiDot.className = 'dot ' + (missing.length ? 'warn' : 'ok');
    const gpuText = runtime.gpu && runtime.gpu.name ? ' · GPU ' + runtime.gpu.name :
      (runtime.cuda_available ? ' · CUDA พร้อม' : ' · CPU only');
    const faceText = runtime.face_backend === 'opencv-yunet-cpu' ? ' · YuNet ใช้ CPU' : ' · YuNet ใช้ CUDA';
    const modeText = runtime.cuda_execution_mode === 'cuda_models_cpu_yunet'
      ? ' · โหมดผสม: YOLO/X3D ใช้ GPU, YuNet ใช้ CPU'
      : '';
    ui.apiText.textContent = 'API พร้อม · Auto=' + device + gpuText + faceText +
      modeText + (missing.length ? ' · ไม่พบไฟล์น้ำหนัก: ' + missing.join(', ') : '');
    Array.prototype.forEach.call(ui.model.options, opt => {
      const s = models[opt.value];
      opt.textContent = opt.dataset.label + (s === 'missing' ? ' — ไม่พบไฟล์น้ำหนัก' : '');
    });
  }

  /* ---------------- clearing (no output survives a new file / new analysis) ---------------- */
  function clearCanvas(cv) {
    const ctx = cv.getContext('2d');
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, cv.width, cv.height);
  }

  function resetResults() {
    runToken++;                // in-flight responses of an older run are ignored
    drawToken++;
    stopPlayer();
    st.s1 = null; st.s2 = null; st.view = null; st.cur = 0; st.images = []; st.faceBlur = null; st.lastSample = -2;
    st.hidden = {}; st.ppeCheck = true; st.viewMode = 'cls'; st.minConf = 0; st.hl = null; st.seeking = false;
    ui.video.removeAttribute('src');
    ui.video.load();
    clearCanvas(ui.overlay);
    clearCanvas(ui.s1Canvas);
    [ui.s1Sentence, ui.s1Chips, ui.s1Notice, ui.nowTitle, ui.nowDets, ui.s1Ppe, ui.s1Meta, ui.s1Counts,
      ui.s1Disclaimer, ui.seekMarks, ui.seekTime, ui.corner, ui.s2Sentence, ui.s2Meta, ui.s2Raw, ui.s2Disclaimer]
      .forEach(clear);
    ui.s1Body.hidden = true; ui.s2Body.hidden = true;
    ui.s1Badge.hidden = true; ui.s2Badge.hidden = true;
    ui.s1Disclaimer.hidden = true; ui.s2Disclaimer.hidden = true;
    ui.s1Notice.hidden = true; ui.s1Rule.hidden = true;
    ui.corner.hidden = true; ui.seek.hidden = true; ui.seekLegend.hidden = true;
    ui.player.hidden = true; ui.frameView.hidden = true;
    setPressed(ui.ppeCheck, true);
    applyViewControls();
    setState(ui.s1State, 'info', S1_IDLE);
    setState(ui.s2State, 'info', S2_IDLE);
  }

  /* ---------------- file selection, preview, playback probe ---------------- */
  function probeVideo(videoEl) {
    return new Promise(resolve => {
      let done = false;
      const finish = (ok, reason) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        videoEl.removeEventListener('loadeddata', onData);
        videoEl.removeEventListener('error', onErr);
        resolve({ ok: ok, reason: reason });
      };
      const onData = () => {
        if (videoEl.videoWidth > 0 && videoEl.videoHeight > 0) finish(true, '');
        else finish(false, 'เบราว์เซอร์อ่านไฟล์ได้แต่ไม่มีภาพวิดีโอที่ถอดรหัสได้');
      };
      const onErr = () => finish(false, 'เบราว์เซอร์ไม่รองรับ codec/รูปแบบของไฟล์นี้');
      const timer = setTimeout(() => finish(false, 'เบราว์เซอร์โหลดวิดีโอไม่ทันเวลา'), PROBE_TIMEOUT_MS);
      videoEl.addEventListener('loadeddata', onData);
      videoEl.addEventListener('error', onErr);
      if (videoEl.readyState >= 2) onData();
    });
  }

  function onFileChange() {
    const f = ui.file.files && ui.file.files[0];
    resetResults();
    ui.status.hidden = true;
    if (st.url) { URL.revokeObjectURL(st.url); st.url = null; }
    clear(ui.preview);
    ui.preview.classList.remove('thumb');
    st.file = f || null; st.kind = f ? mediaKind(f) : null; st.probe = null;
    $('v-analyze').classList.toggle('has-file', Boolean(f));
    ui.preview.hidden = !f || !st.kind;
    ui.run.disabled = !f || !st.kind;
    ui.probe.hidden = true;
    ui.maxFramesWrap.hidden = true; ui.sampleFpsWrap.hidden = true;
    if (!f) { ui.fileInfo.textContent = 'ยังไม่ได้เลือกไฟล์'; return; }
    ui.fileInfo.textContent = f.name + ' · ' + (f.size / 1048576).toFixed(2) + ' MB · ' +
      (st.kind === 'image' ? 'ภาพนิ่ง' : st.kind === 'video' ? 'วิดีโอ' : 'ชนิดไฟล์ไม่รองรับ');
    if (!st.kind) return;
    st.url = URL.createObjectURL(f);
    clear(ui.preview);
    ui.preview.appendChild(el('div', 'az-empty', 'ซ่อนไฟล์ต้นฉบับระหว่างรอวิเคราะห์ — จะแสดงเฉพาะภาพที่เบลอแล้ว'));
    if (st.kind === 'image') {
      return;
    }
    const v = el('video');
    v.controls = false; v.muted = true; v.preload = 'auto'; v.playsInline = true; v.hidden = true;
    ui.preview.appendChild(v);
    st.probe = probeVideo(v);
    v.src = st.url;
    const myFile = f;
    st.probe.then(p => {
      if (st.file !== myFile) return;
      if (p.ok) {
        ui.sampleFpsWrap.hidden = false;
      } else {
        // The user needs to know why the result will be shown frame by frame.
        setState(ui.probe, 'warn', 'เบราว์เซอร์เล่นวิดีโอนี้ไม่ได้ (' + p.reason + ') → จะแสดงผลเป็นภาพทีละเฟรมแทน');
        ui.maxFramesWrap.hidden = false;
        clear(ui.preview);
        ui.preview.appendChild(el('div', 'az-empty', 'แสดงตัวอย่างวิดีโอนี้ในเบราว์เซอร์ไม่ได้ (ยังส่งไปวิเคราะห์ได้)'));
      }
    });
  }

  /* ---------------- shared drawing (CSS px) ---------------- */
  function personsForPpe(frame) {
    return frame.detections.filter(d => d.class_name === 'person' && d.confidence >= st.s1.ppe_min_confidence);
  }
  const overlaps = (a, b) => a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;

  // Place a label for box b = {x1,y1,x2,y2} (canvas CSS px) inside the
  // W×H canvas. Person labels are tried above/below the box first so they
  // do not cover the face; `placed` avoids label-on-label overlap.
  function drawLabel(ctx, text, b, color, W, H, placed, isPerson) {
    ctx.font = '600 ' + LABEL_PX + 'px ui-monospace, Consolas, monospace';
    const padX = 4, h = Math.round(LABEL_PX * 1.45);
    const w = Math.min(W, ctx.measureText(text).width + padX * 2);
    const x = Math.max(0, Math.min(W - w, b.x1));
    const ys = isPerson
      ? [b.y1 - h, b.y2, b.y2 - h, b.y1]
      : [b.y1 - h, b.y1, b.y2, b.y2 - h];
    const inside = y => y >= 0 && y + h <= H;
    let y = ys.find(c => inside(c) && !placed.some(p => overlaps({ x: x, y: c, w: w, h: h }, p)));
    if (y === undefined) y = ys.find(inside);
    if (y === undefined) y = Math.max(0, Math.min(H - h, b.y1));
    placed.push({ x: x, y: y, w: w, h: h });
    ctx.fillStyle = color;
    ctx.fillRect(x, y, w, h);
    ctx.fillStyle = '#08111a';
    ctx.textBaseline = 'middle';
    ctx.fillText(text, x + padX, y + h / 2 + 0.5, w - padX * 2);
  }

  function visibleDet(d) {
    return !st.hidden[d.class_name] && d.confidence >= st.minConf - 1e-9;
  }
  const ppeViewActive = () => st.ppeCheck && st.viewMode === 'ppe';

  // Draw one frame's boxes with the current display filters.
  // map(x, y) → canvas CSS px; W×H = canvas CSS size.
  function drawScene(ctx, frame, map, W, H) {
    const placed = [];
    const box = d => {
      const a = map(d.xyxy[0], d.xyxy[1]), c = map(d.xyxy[2], d.xyxy[3]);
      return { x1: a[0], y1: a[1], x2: c[0], y2: c[1] };
    };
    const stroke = (b, color, lw, dash) => {
      ctx.setLineDash(dash || []);
      ctx.lineWidth = lw;
      ctx.strokeStyle = color;
      ctx.strokeRect(b.x1, b.y1, b.x2 - b.x1, b.y2 - b.y1);
      ctx.setLineDash([]);
    };
    const persons = personsForPpe(frame);
    const hlBox = (st.ppeCheck && st.hl !== null && persons[st.hl]) ? box(persons[st.hl]) : null;

    let dets;
    if (ppeViewActive()) {
      // PPE view: person boxes coloured from the API PPE rows; hazards (fall/fire/smoke) stay drawn;
      // helmet/vest boxes are not drawn. Class chips do not apply here.
      frame.ppe.forEach(row => {
        const p = persons[row.person_index];
        if (!p || p.confidence < st.minConf - 1e-9) return;
        const b = box(p);
        const bad = row.alerts.length > 0;
        const c = bad ? PPE_BAD : PPE_OK;
        stroke(b, c, PPE_LINE_PX);
        drawLabel(ctx, '#' + (row.person_index + 1) + (bad ? ' ✗' : ' ✓'), b, c, W, H, placed, true);
      });
      dets = frame.detections.filter(d => HAZARD.indexOf(d.class_name) >= 0 && d.confidence >= st.minConf - 1e-9);
    } else {
      dets = frame.detections.filter(visibleDet);
    }
    dets.forEach(d => stroke(box(d), colorFor(d.class_name, d.class_id), LINE_PX));
    dets.forEach(d => drawLabel(ctx, d.class_name + (d.track_id ? ' #' + d.track_id : '') + ' ' + num(d.confidence, 2), box(d),
      colorFor(d.class_name, d.class_id), W, H, placed, d.class_name === 'person'));
    if (hlBox) stroke({ x1: hlBox.x1 - 3, y1: hlBox.y1 - 3, x2: hlBox.x2 + 3, y2: hlBox.y2 + 3 }, HL_COLOR, 2, [5, 3]);
  }

  /* ---------------- side panel: current frame + PPE table ---------------- */
  function renderNow(frame, title) {
    ui.nowTitle.textContent = title;
    clear(ui.nowDets);
    clear(ui.s1Ppe);
    if (!frame) {
      ui.nowDets.textContent = 'ไม่มีผลตรวจ Stage 1 ที่ตรงกับเวลานี้';
      return;
    }
    const counts = {};
    frame.detections.forEach(d => { counts[d.class_name] = (counts[d.class_name] || 0) + 1; });
    const keys = Object.keys(counts);
    ui.nowDets.textContent = keys.length
      ? keys.map(c => clsTh(c) + ' ' + counts[c]).join(' · ')
      : 'ไม่พบวัตถุ';

    if (!st.ppeCheck) return;
    if (!frame.ppe.length) {
      ui.s1Ppe.appendChild(el('div', 'az-empty-sm', 'ไม่มีแถว PPE (ไม่พบคนที่คะแนน ≥ ' + num(st.s1.ppe_min_confidence, 2) + ')'));
      return;
    }
    const tab = el('table', 'az-ppetab');
    tab.appendChild(el('caption', null, 'PPE — คำนวณภายหลัง (ไม่ใช่ class โมเดล) · method: ' + frame.ppe[0].method));
    const thead = el('thead'), hr = el('tr');
    ['คน', 'คะแนน', 'หมวก', 'เสื้อ', 'ผล (derived)'].forEach(t => hr.appendChild(el('th', null, t)));
    thead.appendChild(hr);
    tab.appendChild(thead);
    const tbody = el('tbody');
    frame.ppe.slice()
      .sort((a, b) => (b.alerts.length > 0) - (a.alerts.length > 0) || a.person_index - b.person_index)
      .forEach(row => {
        const tr = el('tr', row.alerts.length ? 'bad' : 'ok');
        tr.tabIndex = 0;
        tr.dataset.pi = String(row.person_index);
        tr.appendChild(el('td', 'mono', '#' + (row.person_index + 1)));
        tr.appendChild(el('td', 'mono', num(row.person_confidence, 2)));
        tr.appendChild(el('td', row.has_helmet ? 'yes' : 'no', row.has_helmet ? '✓' : '✗'));
        tr.appendChild(el('td', row.has_vest ? 'yes' : 'no', row.has_vest ? '✓' : '✗'));
        const td = el('td');
        if (!row.alerts.length) td.appendChild(el('span', 'az-derived ok', 'ครบ'));
        row.alerts.forEach(a => td.appendChild(el('span', 'az-derived', a)));
        tr.appendChild(td);
        const on = () => setHighlight(row.person_index);
        const off = () => setHighlight(null);
        tr.addEventListener('mouseenter', on);
        tr.addEventListener('focus', on);
        tr.addEventListener('mouseleave', off);
        tr.addEventListener('blur', off);
        tbody.appendChild(tr);
      });
    tab.appendChild(tbody);
    ui.s1Ppe.appendChild(tab);
  }

  function setHighlight(pi) {
    if (st.hl === pi) return;
    st.hl = pi;
    redraw(false);
  }

  // Redraw the active view; rebuildSide also re-renders the side panel.
  function redraw(rebuildSide) {
    if (st.view === 'player') drawOverlay(true, rebuildSide);
    else if (st.view === 'frames') drawFrame(rebuildSide);
  }

  /* ---------------- frames view (images, or video fallback) ---------------- */
  function frameImage(i) {
    if (st.images[i]) return st.images[i];
    const p = new Promise((resolve, reject) => {
      const b64 = st.s1.frames[i].image_jpeg_b64;
      if (typeof b64 !== 'string' || !b64) { reject(new Error('no image')); return; }
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error('decode'));
      img.src = 'data:image/jpeg;base64,' + b64;
    });
    st.images[i] = p;
    return p;
  }

  // Side panel + track for the current frame (synchronous, so a concurrent
  // canvas redraw can never skip it).
  function renderFrameSide() {
    const frame = st.s1.frames[st.cur];
    const isVideo = st.s1.media_type === 'video';
    if (isVideo) {
      const n = st.s1.frames.length;
      ui.seekRange.value = String(st.cur);
      ui.prev.disabled = st.cur <= 0;
      ui.next.disabled = st.cur >= n - 1;
      ui.seekTime.textContent = 'เฟรม ' + (st.cur + 1) + '/' + n + ' · ' + num(frame.time_s, 2) + ' s';
      updateCorner(frame.time_s);
    }
    renderNow(frame, isVideo ? 'ผลตรวจในเฟรมนี้ (t = ' + num(frame.time_s, 2) + ' s)' : 'ผลตรวจในภาพนี้');
  }

  async function drawFrame(rebuildSide) {
    if (!st.s1 || st.view !== 'frames') return;
    if (rebuildSide !== false) renderFrameSide();
    const token = ++drawToken;
    const frame = st.s1.frames[st.cur];
    const src = st.s1.source;
    const cv = ui.s1Canvas, ctx = cv.getContext('2d');
    let img = null;
    try { img = await frameImage(st.cur); } catch (e) { img = null; }
    if (token !== drawToken || !st.s1 || st.view !== 'frames') return;

    // Size the canvas to its on-screen size (CSS px × devicePixelRatio).
    const boxW = ui.frameView.clientWidth;
    if (boxW <= 0) return;
    const aspect = src.width / src.height;
    let w = boxW, h = boxW / aspect;
    const maxH = FRAME_MAX_H();
    if (h > maxH) { h = maxH; w = h * aspect; }
    w = Math.round(w); h = Math.round(h);
    const dpr = window.devicePixelRatio || 1;
    if (cv.width !== Math.round(w * dpr) || cv.height !== Math.round(h * dpr)) {
      cv.width = Math.round(w * dpr); cv.height = Math.round(h * dpr);
    }
    cv.style.width = w + 'px';
    cv.style.height = h + 'px';
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = '#05080c';
    ctx.fillRect(0, 0, w, h);
    if (img) ctx.drawImage(img, 0, 0, w, h);
    else {
      ctx.fillStyle = '#ef4444';
      ctx.font = '600 ' + LABEL_PX + 'px ui-monospace, Consolas, monospace';
      ctx.textBaseline = 'top';
      ctx.fillText('ถอดรหัสภาพเฟรมนี้ไม่ได้', 8, 8);
    }
    const sx = w / src.width, sy = h / src.height;
    drawScene(ctx, frame, (x, y) => [x * sx, y * sy], w, h);
  }

  function gotoFrame(i) {
    if (!st.s1 || st.view !== 'frames') return;
    st.cur = Math.max(0, Math.min(st.s1.frames.length - 1, i));
    st.hl = null;
    drawFrame(true);
  }

  /* ---------------- player view (dense mode) ---------------- */
  // Index of the dense sample nearest to t, or -1 if none within 1/sample_fps.
  function nearestSample(t) {
    const fr = st.s1.frames;
    let lo = 0, hi = fr.length - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (fr[mid].time_s < t) lo = mid + 1; else hi = mid;
    }
    let best = lo;
    if (lo > 0 && Math.abs(fr[lo - 1].time_s - t) <= Math.abs(fr[lo].time_s - t)) best = lo - 1;
    const tol = isNum(st.s1.sample_fps) && st.s1.sample_fps > 0 ? 1 / st.s1.sample_fps : 0;
    return Math.abs(fr[best].time_s - t) <= tol + 1e-6 ? best : -1;
  }

  // Rectangle (CSS px, relative to the <video> box) where the picture is
  // actually shown — <video> letterboxes with object-fit: contain.
  function contentRect() {
    const v = ui.video;
    const cw = v.clientWidth, ch = v.clientHeight;
    const vw = v.videoWidth || st.s1.source.width, vh = v.videoHeight || st.s1.source.height;
    const s = Math.min(cw / vw, ch / vh);
    const w = vw * s, h = vh * s;
    return { x: (cw - w) / 2, y: (ch - h) / 2, w: w, h: h, cw: cw, ch: ch };
  }

  function playerDuration() {
    const d = ui.video.duration;
    if (isNum(d) && d > 0) return d;
    return st.s1 && isNum(st.s1.source.duration_s) ? st.s1.source.duration_s : 0;
  }

  function syncPlayerTrack(t) {
    const D = playerDuration();
    if (ui.seekRange.max !== String(D)) { ui.seekRange.max = String(D); renderSeekMarks(); }
    if (!st.seeking) ui.seekRange.value = String(t);
    ui.seekTime.textContent = num(t, 1) + ' / ' + num(D, 1) + ' s';
    ui.play.textContent = ui.video.paused ? '▶' : '❚❚';
    ui.play.setAttribute('aria-label', ui.video.paused ? 'เล่นวิดีโอ' : 'หยุดวิดีโอ');
  }

  function drawOverlay(force, rebuildSide) {
    if (!st.s1 || st.view !== 'player') return;
    const v = ui.video, cv = ui.overlay;
    const t = v.currentTime;
    const i = nearestSample(t);
    syncPlayerTrack(t);
    updateCorner(t);
    const r = contentRect();
    const dpr = window.devicePixelRatio || 1;
    const bw = Math.max(1, Math.round(r.cw * dpr)), bh = Math.max(1, Math.round(r.ch * dpr));
    let resized = false;
    if (cv.width !== bw || cv.height !== bh) { cv.width = bw; cv.height = bh; resized = true; }
    cv.style.left = v.offsetLeft + 'px';
    cv.style.top = v.offsetTop + 'px';
    cv.style.width = r.cw + 'px';
    cv.style.height = r.ch + 'px';
    // Stage 2 badge in the top-right corner of the visible picture.
    ui.corner.style.right = (v.offsetParent ? v.offsetParent.clientWidth - (v.offsetLeft + r.x + r.w) + 8 : 8) + 'px';
    ui.corner.style.top = (v.offsetTop + r.y + 8) + 'px';
    const sampleChanged = i !== st.lastSample;
    st.lastSample = i;
    if (sampleChanged) st.hl = null;

    const ctx = cv.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    // Opaque canvas covers the original video at all times. Fail closed to a
    // blank slate if face metadata or canvas drawing is unavailable.
    ctx.fillStyle = '#000'; ctx.fillRect(0, 0, r.cw, r.ch);
    try {
      const src = st.s1.source;
      // Browser currentTime often sits between decoded-frame timestamps; choose
      // the nearest analysis frame to reduce mask lag during fast movement.
      const frameIndex = Math.min(src.frame_count - 1, Math.max(0, Math.round(t * src.fps)));
      const faceBoxes = st.faceBlur && st.faceBlur.faces_by_frame[frameIndex];
      if (!Array.isArray(faceBoxes)) throw new Error('missing face frame');
      if (r.w > 0 && r.h > 0 && ui.video.readyState >= 2) {
        ctx.drawImage(v, r.x, r.y, r.w, r.h);
        faceBoxes.forEach(box => {
          const x = r.x + box[0] * r.w / src.width;
          const y = r.y + box[1] * r.h / src.height;
          const w = (box[2] - box[0]) * r.w / src.width;
          const h = (box[3] - box[1]) * r.h / src.height;
          // Strong pixelation is more resistant to motion than a mild Gaussian blur.
          // Build a tiny source patch, then enlarge it with smoothing disabled.
          const strength = st.faceBlur.settings && isNum(st.faceBlur.settings.blur_strength)
            ? st.faceBlur.settings.blur_strength : 0.8;
          const pixel = Math.max(6, Math.min(20, 10 * strength / 0.8));
          const mw = Math.max(2, Math.ceil(w / pixel));
          const mh = Math.max(2, Math.ceil(h / pixel));
          faceMosaicCanvas.width = mw; faceMosaicCanvas.height = mh;
          const mosaicCtx = faceMosaicCanvas.getContext('2d');
          if (!mosaicCtx) throw new Error('face mosaic unavailable');
          mosaicCtx.clearRect(0, 0, mw, mh);
          mosaicCtx.drawImage(v, box[0], box[1], box[2] - box[0], box[3] - box[1], 0, 0, mw, mh);
          ctx.save(); ctx.imageSmoothingEnabled = false; ctx.filter = 'none';
          ctx.drawImage(faceMosaicCanvas, 0, 0, mw, mh, x, y, w, h);
          ctx.restore();
        });
      }
    } catch (e) {
      ctx.fillStyle = '#111827'; ctx.fillRect(0, 0, r.cw, r.ch);
      ctx.fillStyle = '#fecaca'; ctx.font = '600 14px sans-serif';
      ctx.fillText('เบลอใบหน้าไม่สำเร็จ — ซ่อนภาพไว้', 12, 24);
    }
    const frame = i >= 0 ? st.s1.frames[i] : null;
    if (frame && r.cw > 0) {
      const src = st.s1.source;
      const sx = r.w / src.width, sy = r.h / src.height;
      drawScene(ctx, frame, (x, y) => [r.x + x * sx, r.y + y * sy], r.cw, r.ch);
    }
    if (sampleChanged || rebuildSide) {
      renderNow(frame, 'ผลตรวจ ณ เวลา ' + num(t, 1) + ' s' + (frame ? ' (ตัวอย่าง t = ' + num(frame.time_s, 2) + ' s)' : ''));
    }
  }

  function loop() {
    drawOverlay(false, false);
    rafId = ui.video.paused || ui.video.ended ? 0 : requestAnimationFrame(loop);
  }
  function stopPlayer() {
    if (rafId) cancelAnimationFrame(rafId);
    rafId = 0;
    try { ui.video.pause(); } catch (e) { /* ignore */ }
  }
  ui.video.addEventListener('play', () => { if (!rafId) rafId = requestAnimationFrame(loop); drawOverlay(false, false); });
  ['seeked', 'seeking', 'pause', 'loadeddata', 'timeupdate', 'ended'].forEach(ev => ui.video.addEventListener(ev, () => drawOverlay(false, false)));
  ui.video.addEventListener('loadedmetadata', () => drawOverlay(true, false));
  ui.video.addEventListener('click', () => { if (st.view === 'player') togglePlay(); });
  if (typeof ResizeObserver === 'function') {
    new ResizeObserver(() => drawOverlay(true, false)).observe(ui.video);
    new ResizeObserver(() => drawFrame(false)).observe(ui.frameView);
    new ResizeObserver(() => renderSeekMarks()).observe(ui.seekMarks);
  } else {
    window.addEventListener('resize', () => { redraw(false); renderSeekMarks(); });
  }

  function togglePlay() {
    if (ui.video.paused || ui.video.ended) ui.video.play().catch(() => {});
    else ui.video.pause();
  }

  /* ---------------- timeline track (seek bar / frame slider + Stage 2 marks) ---------------- */
  // Fraction (0..1) along the track for time t in the current view.
  function trackFrac(t) {
    if (st.view === 'player') {
      const D = parseFloat(ui.seekRange.max) || playerDuration();
      return D > 0 ? Math.max(0, Math.min(1, t / D)) : 0;
    }
    // frames view: the track is the frame index; interpolate times between frames.
    const fr = st.s1.frames, n = fr.length;
    if (n < 2) return 0;
    if (t <= fr[0].time_s) return 0;
    if (t >= fr[n - 1].time_s) return 1;
    for (let i = 0; i < n - 1; i++) {
      const a = fr[i].time_s, b = fr[i + 1].time_s;
      if (t >= a && t <= b) return (i + (b > a ? (t - a) / (b - a) : 0)) / (n - 1);
    }
    return 1;
  }

  // Red highlights for Stage 2 windows labelled "fight" (from the current response only).
  function renderSeekMarks() {
    clear(ui.seekMarks);
    const show = !!(st.s1 && st.s2 && st.s1.media_type === 'video');
    ui.seekLegend.hidden = !show;
    if (!show) return;
    st.s2.windows.forEach(w => {
      if (w.label !== 'fight') return;
      const a = trackFrac(w.start_s), b = trackFrac(w.end_s);
      const pw = dataWindowDecision(w.index);
      const m = el('i', 'az-mark' + (pw && pw.decision === 'review_fall_fight_conflict' ? ' review' : ''));
      m.style.left = (a * 100).toFixed(3) + '%';
      m.style.width = (Math.max(b - a, 0.004) * 100).toFixed(3) + '%';
      ui.seekMarks.appendChild(m);
    });
  }

  function setupTrack() {
    const isVideo = st.s1.media_type === 'video';
    ui.seek.hidden = !isVideo;
    if (!isVideo) return;
    if (st.view === 'player') {
      ui.play.hidden = false;
      ui.seekRange.min = '0';
      ui.seekRange.max = String(playerDuration());
      ui.seekRange.step = 'any';
      ui.seekRange.value = '0';
      ui.seekRange.setAttribute('aria-label', 'เลื่อนเวลาในวิดีโอ');
      ui.prev.disabled = false; ui.next.disabled = false;
    } else {
      ui.play.hidden = true;
      ui.seekRange.min = '0';
      ui.seekRange.max = String(st.s1.frames.length - 1);
      ui.seekRange.step = '1';
      ui.seekRange.value = '0';
      ui.seekRange.setAttribute('aria-label', 'เลือกเฟรม');
    }
    renderSeekMarks();
  }

  ui.seekRange.addEventListener('input', () => {
    const v = parseFloat(ui.seekRange.value) || 0;
    if (st.view === 'player') {
      st.seeking = true;
      ui.video.currentTime = v;
      drawOverlay(true, false);
    } else if (st.view === 'frames') {
      gotoFrame(Math.round(v));
    }
  });
  ui.seekRange.addEventListener('change', () => { st.seeking = false; drawOverlay(true, false); });
  ui.play.addEventListener('click', togglePlay);
  function step(dir) {
    if (st.view === 'player') {
      ui.video.pause();
      const dt = isNum(st.s1.sample_fps) && st.s1.sample_fps > 0 ? 1 / st.s1.sample_fps : 0.1;
      ui.video.currentTime = Math.max(0, Math.min(playerDuration(), ui.video.currentTime + dir * dt));
      drawOverlay(true, false);
    } else if (st.view === 'frames') {
      gotoFrame(st.cur + dir);
    }
  }
  ui.prev.addEventListener('click', () => step(-1));
  ui.next.addEventListener('click', () => step(1));

  /* ---------------- display filters (ตรวจ PPE, view selector, class chips, score slider) ---------------- */
  function hasPpeRows() { return !!st.s1 && st.s1.frames.some(f => f.ppe.length > 0); }
  function hasPersons() {
    return !!st.s1 && st.s1.frames.some(f => f.detections.some(d => d.class_name === 'person'));
  }
  // PPE view is only offered when "ตรวจ PPE" is on and the response has people with PPE rows.
  const ppeViewAvailable = () => st.ppeCheck && hasPersons() && hasPpeRows();

  function applyViewControls() {
    if (!ppeViewAvailable()) st.viewMode = 'cls';
    ui.viewPpe.disabled = !ppeViewAvailable();
    ui.viewPpe.title = ppeViewAvailable() ? '' : (st.ppeCheck ? 'ไม่พบคนในผลตรวจนี้' : 'ปิด "ตรวจ PPE" อยู่');
    setPressed(ui.viewPpe, st.viewMode === 'ppe');
    setPressed(ui.viewCls, st.viewMode === 'cls');
    ui.s1Chips.hidden = st.viewMode !== 'cls';   // class chips only apply in class view
  }
  function setView(mode) {
    if (mode === 'ppe' && !ppeViewAvailable()) return;
    st.viewMode = mode;
    st.hl = null;
    applyViewControls();
    redraw(false);
  }
  ui.viewPpe.addEventListener('click', () => setView('ppe'));
  ui.viewCls.addEventListener('click', () => setView('cls'));
  ui.ppeCheck.addEventListener('click', () => {
    st.ppeCheck = !st.ppeCheck;
    setPressed(ui.ppeCheck, st.ppeCheck);
    applyViewControls();
    if (st.s1) renderStage1Summary(st.s1);
    redraw(true);
  });
  ui.conf.addEventListener('input', () => {
    st.minConf = parseFloat(ui.conf.value) || 0;
    ui.confVal.textContent = st.minConf.toFixed(2);
    redraw(false);
  });

  function setupFilters(data) {
    st.hidden = {}; st.hl = null; st.ppeCheck = true;
    setPressed(ui.ppeCheck, true);

    // Slider minimum = lowest API threshold (display-only, never sent to the API).
    const th = data.class_names.map(c => data.thresholds[c]).filter(isNum);
    const lo = th.length ? Math.min.apply(null, th) : 0;
    ui.conf.min = lo.toFixed(2);
    ui.conf.max = '1';
    ui.conf.step = '0.01';
    ui.conf.value = lo.toFixed(2);
    st.minConf = lo;
    ui.confVal.textContent = lo.toFixed(2);

    // Toggle chips (label only) for classes present in this response.
    clear(ui.s1Chips);
    const present = [];
    data.frames.forEach(f => f.detections.forEach(d => { if (present.indexOf(d.class_name) < 0) present.push(d.class_name); }));
    present.sort((a, b) => data.class_names.indexOf(a) - data.class_names.indexOf(b));
    present.forEach(c => {
      const b = el('button', 'az-chip' + (HAZARD.indexOf(c) >= 0 ? ' hot' : ''));
      b.type = 'button';
      b.dataset.cls = c;
      b.setAttribute('aria-pressed', 'true');
      b.title = 'แสดง/ซ่อนกล่อง ' + c + ' (การแสดงผลเท่านั้น)';
      const sw = el('i'); sw.style.background = colorFor(c, data.class_names.indexOf(c));
      b.appendChild(sw);
      b.appendChild(el('span', null, clsTh(c) + ' (' + c + ')'));
      b.addEventListener('click', () => {
        st.hidden[c] = !st.hidden[c];
        b.setAttribute('aria-pressed', String(!st.hidden[c]));
        b.classList.toggle('off', !!st.hidden[c]);
        redraw(false);
      });
      ui.s1Chips.appendChild(b);
    });

    // Default view: PPE view when the response has any person, otherwise class view.
    st.viewMode = ppeViewAvailable() ? 'ppe' : 'cls';
    applyViewControls();
  }

  /* ---------------- Stage 1 rendering ---------------- */
  function metaItem(parent, k, v) {
    const d = el('div');
    d.appendChild(el('div', 'k', k));
    d.appendChild(el('div', 'v mono', v));
    parent.appendChild(d);
  }
  function setBadge(badge, data) { badge.hidden = window.CCTVMode.active || !(data && data.is_model_output === true); }
  function setDisclaimer(node, data) {
    node.textContent = typeof data.disclaimer === 'string' ? data.disclaimer : '';
    node.hidden = !node.textContent;
  }

  // Summary numbers from the response. These are detector boxes, not unique
  // tracked people. Image: counts in the single frame. Video: max boxes/frame.
  // Video (no tracking): persons = max person boxes in any sampled frame; each
  // alert = max count of that alert in any sampled frame; hazards = present
  // in any sampled frame.
  function stage1Summary(data) {
    let persons = 0, noHelmet = 0, noVest = 0, ppeRows = 0;
    const hazards = {};
    data.frames.forEach(f => {
      let p = 0, h = 0, v = 0;
      f.detections.forEach(d => {
        if (d.class_name === 'person') p++;
        if (HAZARD.indexOf(d.class_name) >= 0) hazards[d.class_name] = true;
      });
      f.ppe.forEach(row => {
        if (row.alerts.indexOf('no_helmet') >= 0) h++;
        if (row.alerts.indexOf('no_vest') >= 0) v++;
      });
      ppeRows += f.ppe.length;
      persons = Math.max(persons, p);
      noHelmet = Math.max(noHelmet, h);
      noVest = Math.max(noVest, v);
    });
    return { persons: persons, noHelmet: noHelmet, noVest: noVest, ppeRows: ppeRows,
      hazards: HAZARD.filter(c => hazards[c]) };
  }

  function renderStage1Summary(data) {
    const s = stage1Summary(data);
    const parts = [s.persons ? 'พบกล่อง person สูงสุด ' + s.persons + ' กล่อง/เฟรม' : 'ไม่พบกล่อง person'];
    let warn = s.hazards.length > 0;
    if (st.ppeCheck && s.ppeRows) {
      if (s.noHelmet || s.noVest) {
        if (s.noHelmet) parts.push('ไม่สวมหมวก ' + s.noHelmet);
        if (s.noVest) parts.push('ไม่สวมเสื้อ ' + s.noVest);
        warn = true;
      } else {
        parts.push('สวม PPE ครบ');
      }
    }
    s.hazards.forEach(c => parts.push(c === 'fall' ? 'พบสัญญาณ Fall · ตรวจสอบ' : HAZARD_SENTENCE[c]));
    if (s.persons > 1) parts.push('จำนวนกล่องอาจซ้ำ ไม่ใช่จำนวนคนที่ยืนยันแล้ว');
    ui.s1Sentence.textContent = parts.join(' · ');
    ui.s1Sentence.className = 'az-sentence' + (warn ? ' warn' : ' ok');
  }

  function renderStage1Tech(data) {
    clear(ui.s1Meta);
    const src = data.source;
    if (data.context?.recorded_settings) metaItem(ui.s1Meta,'ค่าที่ใช้ตอนรันหลักฐานเดิม',JSON.stringify(data.context.recorded_settings));
    if (data.context) { metaItem(ui.s1Meta,'ที่มาของผล',window.CCTVMode.origin(data.context)); metaItem(ui.s1Meta,'เวลาหลักฐานเดิม',data.context.captured_at || 'ไม่ได้บันทึก / สมมติ'); metaItem(ui.s1Meta,'ประสิทธิภาพ','ไม่ได้วัดในรอบสาธิต'); }
    metaItem(ui.s1Meta, 'model', data.model);
    if (data.device_used) metaItem(ui.s1Meta, data.context ? 'อุปกรณ์จากรอบที่บันทึก' : 'อุปกรณ์ที่ใช้จริง', data.device_used);
    metaItem(ui.s1Meta, 'media', data.media_type);
    metaItem(ui.s1Meta, 'mode', data.mode);
    if (data.mode === 'dense') metaItem(ui.s1Meta, 'sample_fps', num(data.sample_fps, 2));
    metaItem(ui.s1Meta, 'ขนาดภาพ', src.width + ' × ' + src.height + ' px');
    if (data.media_type === 'video') {
      metaItem(ui.s1Meta, 'fps', num(src.fps, 2));
      metaItem(ui.s1Meta, 'frame_count', src.frame_count);
      metaItem(ui.s1Meta, 'duration_s', num(src.duration_s, 2));
      metaItem(ui.s1Meta, 'เฟรมที่ตรวจ', data.frames.length);
    }
    if (Number.isInteger(data.settings_revision)) metaItem(ui.s1Meta, 'ค่าตั้งอ้างอิง revision', data.settings_revision);
    metaItem(ui.s1Meta, 'detector schema', 'v' + data.detector_schema_version);
    if (data.analysis_settings && data.analysis_settings.yolo) {
      const ys = data.analysis_settings.yolo;
      metaItem(ui.s1Meta, 'YOLO imgsz / NMS IoU / max_det', ys.imgsz + ' / ' + num(ys.iou, 2) + ' / ' + ys.max_det);
    }
    if (data.privacy) {
      const faceCount = isNum(data.privacy.faces_detected) ? ' · พบ ' + data.privacy.faces_detected + ' ใบหน้า' : '';
      metaItem(ui.s1Meta, 'face anonymization', data.privacy.model + faceCount);
      if (isNum(data.privacy.detection_ms)) metaItem(ui.s1Meta, 'YuNet รวมทุกเฟรม', num(data.privacy.detection_ms, 2) + ' ms');
      if (isNum(data.privacy.scan_wall_ms)) metaItem(ui.s1Meta, 'เวลา scan ทั้งหมด', num(data.privacy.scan_wall_ms, 2) + ' ms');
      if (data.privacy.settings) {
        const p = data.privacy.settings;
        metaItem(ui.s1Meta, 'YuNet confidence / padding / blur',
          num(p.face_confidence, 2) + ' / ' + Math.round(p.padding_fraction * 100) + '% / ' + num(p.blur_strength, 2));
      }
    }
    if (data.timings_ms) {
      const t = data.timings_ms;
      metaItem(ui.s1Meta, 'เวลา pipeline · decode / YuNet / YOLO / X3D',
        [t.video_decode_ms, t.face_detection_ms, t.yolo_ms, t.x3d_ms].map(v => num(v, 0) + ' ms').join(' / '));
      metaItem(ui.s1Meta, 'เวลา preview / รวม', num(t.preview_encode_ms, 0) + ' / ' + num(t.total_ms, 0) + ' ms');
    }
    metaItem(ui.s1Meta, 'ppe_min_confidence', num(data.ppe_min_confidence, 2));
    metaItem(ui.s1Meta, 'schema_version', data.schema_version);
    ui.s1Rule.hidden = data.media_type !== 'video';

    const isVideo = data.media_type === 'video';
    const n = data.frames.length;
    const stats = {};
    data.class_names.forEach(c => { stats[c] = { boxes: 0, frames: 0, maxConf: 0 }; });
    data.frames.forEach(f => {
      const seen = {};
      f.detections.forEach(d => {
        if (!stats[d.class_name]) stats[d.class_name] = { boxes: 0, frames: 0, maxConf: 0 };
        const s = stats[d.class_name];
        s.boxes++;
        s.maxConf = Math.max(s.maxConf, d.confidence);
        if (!seen[d.class_name]) { seen[d.class_name] = true; s.frames++; }
      });
    });
    clear(ui.s1Counts);
    const head = el('div', 'az-crow az-chead');
    ['class', 'threshold (API)', 'กล่องทั้งหมด', isVideo ? 'เฟรมที่พบ' : 'คะแนนสูงสุด'].forEach(t => head.appendChild(el('span', null, t)));
    ui.s1Counts.appendChild(head);
    Object.keys(stats).forEach((c, idx) => {
      const s = stats[c];
      const row = el('div', 'az-crow');
      const tag = el('span', 'az-cls');
      const sw = el('i'); sw.style.background = colorFor(c, data.class_names.indexOf(c) >= 0 ? data.class_names.indexOf(c) : idx);
      tag.appendChild(sw); tag.appendChild(el('span', null, c));
      row.appendChild(tag);
      row.appendChild(el('span', 'mono', num(data.thresholds[c], 2)));
      row.appendChild(el('span', 'mono' + (s.boxes ? ' az-hit' : ''), s.boxes));
      row.appendChild(el('span', 'mono', isVideo ? s.frames + '/' + n : (s.boxes ? num(s.maxConf, 2) : '—')));
      ui.s1Counts.appendChild(row);
    });
  }

  function renderStage1(data, notice) {
    st.s1 = data; st.cur = 0; st.images = []; st.lastSample = -2;
    setBadge(ui.s1Badge, data);
    setDisclaimer(ui.s1Disclaimer, data);
    setupFilters(data);
    renderStage1Summary(data);
    renderStage1Tech(data);
    ui.s1Notice.textContent = notice || '';
    ui.s1Notice.hidden = !notice;

    const dense = data.mode === 'dense' && data.media_type === 'video';
    st.view = dense ? 'player' : 'frames';
    ui.player.hidden = !dense;
    ui.frameView.hidden = dense;
    ui.s1Body.hidden = false;
    ui.s1State.hidden = true;
    if (dense) {
      if (!st.faceBlur || st.faceBlur.complete !== true || st.faceBlur.faces_by_frame.length !== data.source.frame_count) {
        setState(ui.s1State, 'error', 'ไม่สามารถยืนยันการเบลอใบหน้าทุกเฟรมได้ — วิดีโอถูกซ่อนไว้');
        ui.s1Body.hidden = true;
        return;
      }
      ui.video.src = st.url;
      ui.video.load();
    }
    setupTrack();
    redraw(true);
  }

  /* ---------------- Stage 2 rendering ---------------- */
  function windowAt(t) {
    if (!st.s2 || !isNum(t)) return null;
    const ws = st.s2.windows;
    for (let i = 0; i < ws.length; i++) {
      const last = i === ws.length - 1;
      if (t >= ws[i].start_s && (t < ws[i].end_s || (last && t <= ws[i].end_s))) return ws[i];
    }
    return null;
  }

  // Badge on the video (label only, no times).
  function updateCorner(t) {
    const show = st.view === 'player' && !!st.s2;
    ui.corner.hidden = !show;
    if (!show) return;
    const w = windowAt(t);
    const pw = w && dataWindowDecision(w.index);
    const label = pw ? pw.decision_label : (w ? (S2_TH[w.label] || w.label) : 'ไม่มีผลช่วงนี้');
    ui.corner.textContent = 'Stage 2: ' + label;
    ui.corner.className = 'az-corner' + (pw && pw.decision === 'review_fall_fight_conflict'
      ? ' review' : (w && w.label === 'fight' ? ' fight' : ''));
  }

  function dataWindowDecision(index) {
    const windows = st.s2 && st.s2.pipeline && st.s2.pipeline.windows;
    return Array.isArray(windows) ? windows[index] || null : null;
  }

  function renderStage2(data) {
    st.s2 = data;
    setBadge(ui.s2Badge, data);
    setDisclaimer(ui.s2Disclaimer, data);
    const sm = data.summary;
    const reviewCount = data.pipeline ? data.pipeline.review_fall_fight_conflict_windows : 0;
    const candidateCount = data.pipeline ? data.pipeline.fight_candidate_windows : 0;
    const fallCount = data.pipeline ? data.pipeline.fall_detected_windows : 0;
    if (reviewCount > 0) {
      ui.s2Sentence.textContent = '⚠ X3D ทาย Fight แต่พบสัญญาณคนล้ม ' + reviewCount +
        ' ช่วง — ผลกำกวม ต้องตรวจสอบ (ผลดิบ X3D: ' + sm.fight_windows + ' ช่วง)';
      ui.s2Sentence.className = 'az-sentence warn';
    } else if (candidateCount > 0) {
      ui.s2Sentence.textContent = '⚠ X3D สงสัย Fight ' + candidateCount +
        ' ช่วง — เป็นผลคัดกรอง pilot ยังไม่ใช่การยืนยัน';
      ui.s2Sentence.className = 'az-sentence warn';
    } else if (data.pipeline && fallCount > 0) {
      ui.s2Sentence.textContent = '⚠ พบสัญญาณ Fall ' + fallCount +
        ' ช่วง · X3D ไม่ได้ทาย Fight ในช่วงที่พบการล้ม';
      ui.s2Sentence.className = 'az-sentence ok';
    } else {
      const found = sm.fight_windows > 0;
      ui.s2Sentence.textContent = data.pipeline
        ? '✓ X3D ไม่ได้ทาย Fight (ผลคัดกรอง pilot; ไม่ใช่การยืนยันว่าไม่มีเหตุการณ์)'
        : (found ? '⚠ X3D ทาย Fight' : '✓ X3D ทาย non-fight');
      ui.s2Sentence.className = 'az-sentence' + (found && !data.pipeline ? ' warn' : ' ok');
    }

    // Technical details: summary numbers, window times and raw probabilities.
    clear(ui.s2Meta);
    if (data.context) metaItem(ui.s2Meta,'ที่มาของผล',window.CCTVMode.origin(data.context));
    metaItem(ui.s2Meta, 'model', data.model);
    if (Number.isInteger(data.settings_revision)) metaItem(ui.s2Meta, 'ค่าตั้งอ้างอิง revision', data.settings_revision);
    if (data.device_used) metaItem(ui.s2Meta, 'อุปกรณ์ที่ใช้จริง', data.device_used);
    metaItem(ui.s2Meta, 'class_names', data.class_names.join(', '));
    metaItem(ui.s2Meta, data.pipeline ? 'X3D ดิบ: Fight windows / total' : 'X3D Fight windows / total', sm.fight_windows + ' / ' + sm.total_windows);
    metaItem(ui.s2Meta, 'max_fight_prob', num(sm.max_fight_prob, 4));
    if (isNum(data.fight_threshold)) metaItem(ui.s2Meta, 'เกณฑ์ Fight', num(data.fight_threshold, 2));
    metaItem(ui.s2Meta, 'duration_s', num(data.source.duration_s, 2));
    metaItem(ui.s2Meta, 'fps', num(data.source.fps, 2));
    metaItem(ui.s2Meta, 'window_s', num(data.window_s, 1));
    metaItem(ui.s2Meta, 'frames_per_window', data.frames_per_window);
    if (data.pipeline) {
      metaItem(ui.s2Meta, 'pipeline_mode', data.pipeline.mode);
      metaItem(ui.s2Meta, 'ช่วงที่พบกล่อง person จาก YOLO', data.pipeline.person_triggered_windows + ' / ' + data.pipeline.total_windows);
      metaItem(ui.s2Meta, 'tracking trigger windows', data.pipeline.candidate_triggered_windows + ' / ' + data.pipeline.total_windows);
      metaItem(ui.s2Meta, 'Fight ที่ไม่มี tracking trigger', data.pipeline.fight_without_candidate_trigger);
      metaItem(ui.s2Meta, 'ล้ม/Fight กำกวม · ตรวจสอบ', reviewCount);
      metaItem(ui.s2Meta, 'Fight candidate · pilot', candidateCount);
      metaItem(ui.s2Meta, 'Tracking', 'สร้าง track จากกล่อง person; กล่องซ้ำอาจนับเป็นหลาย track');
      metaItem(ui.s2Meta, 'Proximity trigger', 'ระยะ ≤ ' + num(data.pipeline.proximity_diagonals, 2) + ' เท่าของเส้นทแยงมุมภาพ');
      metaItem(ui.s2Meta, 'Motion trigger', 'ความเร็ว ≥ ' + num(data.pipeline.motion_diagonals_per_s, 2) + ' เส้นทแยงมุมภาพ/วินาที');
      metaItem(ui.s2Meta, 'X3D policy', 'ประเมินทุกช่วง (shadow mode)');
    }
    metaItem(ui.s2Meta, 'schema_version', data.schema_version);
    clear(ui.s2Raw);
    const head = el('div', 'az-rrow az-chead' + (data.pipeline ? ' pipeline' : ''));
    ['#', 'เวลา', 'X3D', 'non_fight', 'fight'].concat(data.pipeline ? ['YOLO พบกล่อง', 'tracks*', 'trigger/evidence'] : []).forEach(t => head.appendChild(el('span', null, t)));
    ui.s2Raw.appendChild(head);
    data.windows.forEach(w => {
      const pw = data.pipeline && data.pipeline.windows[w.index];
      const decision = pw && pw.decision;
      const rowClass = decision === 'review_fall_fight_conflict' ? ' review'
        : (decision === 'fight_candidate' || (!pw && w.label === 'fight') ? ' fight' : '');
      const r = el('div', 'az-rrow' + (data.pipeline ? ' pipeline' : '') + rowClass);
      r.appendChild(el('span', 'mono', w.index));
      r.appendChild(el('span', 'mono', num(w.start_s, 2) + ' – ' + num(w.end_s, 2)));
      r.appendChild(el('span', 'mono', w.label));
      data.class_names.forEach(c => r.appendChild(el('span', 'mono', num(w.probs[c], 4))));
      if (pw) {
        r.appendChild(el('span', 'mono', pw.person_triggered ? 'พบ' : 'ไม่พบ'));
        r.appendChild(el('span', 'mono', pw.max_concurrent_tracks));
        const reasonText = pw.trigger_reasons.map(x => ({
          people_in_close_proximity: 'ใกล้กัน', multi_person_motion: 'เคลื่อนไหว'
        }[x] || x)).join(' + ');
        r.appendChild(el('span', 'mono', pw.decision_label + ' · ' +
          (pw.candidate_triggered ? 'TRIGGER: ' : '— ') + (reasonText || 'ไม่มี') +
          ' (P' + pw.proximity_frames + '/M' + pw.motion_frames + ')'));
      }
      ui.s2Raw.appendChild(r);
    });

    ui.s2Body.hidden = false;
    ui.s2State.hidden = true;
    renderSeekMarks();
    if (st.view === 'player') updateCorner(ui.video.currentTime);
  }

  /* ---------------- analyze flow ---------------- */
  function stage1Form(file, mode, privacy, analysis) {
    const fd = new FormData();
    fd.append('file', file, file.name);
    fd.append('model', ui.model.value);
    fd.append('device', ui.device ? ui.device.value : 'auto');
    appendPrivacySettings(fd, privacy);
    const values = analysis === undefined ? analysisSettings() : analysis;
    if (values) fd.append('analysis_settings', JSON.stringify(values));
    if (mode === 'dense') {
      fd.append('mode', 'dense');
      fd.append('sample_fps', String(clampFloat(ui.sampleFps.value, SAMPLE_FPS)));
    } else {
      fd.append('mode', 'frames');
      if (mediaKind(file) === 'video') fd.append('max_frames', String(clampInt(ui.maxFrames.value, MAX_FRAMES)));
    }
    return fd;
  }

  function privacySettings() {
    return {
      face_confidence: clampFloat(ui.faceConfidence.value, { min: 0.20, max: 0.90, def: 0.35 }),
      face_padding: clampFloat(ui.facePadding.value, { min: 0, max: 0.50, def: 0.25 }),
      face_blur_strength: clampFloat(ui.faceBlur.value, { min: 0.40, max: 1.50, def: 0.80 })
    };
  }

  function analysisSettings() {
    if ($('azUseSavedSettings').checked) return null;
    const c = ui.modelSettings;
    const value = (input, range, fallback) => clampFloat(input.value, { min: range[0], max: range[1], def: fallback });
    return {
      yolo: {
        thresholds: Object.fromEntries(['person','helmet','vest','fall','fire','smoke'].map(name =>
          [name, value(c[name], [0.01, 0.99], name === 'person' ? 0.25 : 0.20)])),
        iou: value(c.iou, [0.1, 0.95], 0.70),
        imgsz: [320,480,640,800,960,1280].includes(Number(c.imgsz.value)) ? Number(c.imgsz.value) : 640,
        max_det: clampInt(c.maxDet.value, { min: 1, max: 1000, def: 300 })
      },
      x3d: { fight_threshold: value(c.fight, [0.05, 0.95], 0.50) },
      tracking: {
        proximity_diagonals: value(c.proximity, [0.01, 0.50], 0.16),
        motion_diagonals_per_s: value(c.motion, [0.01, 2], 0.25),
        max_track_gap_s: value(c.gap, [0.1, 3], 0.75)
      }
    };
  }

  function appendPrivacySettings(form, settings) {
    const p = settings || privacySettings();
    Object.keys(p).forEach(key => form.append(key, String(p[key])));
  }

  function updatePrivacySettingLabels() {
    const p = privacySettings();
    ui.faceConfidenceValue.textContent = p.face_confidence.toFixed(2);
    ui.facePaddingValue.textContent = Math.round(p.face_padding * 100) + '%';
    ui.faceBlurValue.textContent = p.face_blur_strength.toFixed(2);
  }

  async function runStage1(file, mode, notice, token) {
    const usedPrivacy = privacySettings();
    const usedAnalysis = analysisSettings();
    setState(ui.s1State, 'loading', mode === 'dense'
      ? 'กำลังตรวจจับด้วย YOLOv8 ตลอดทั้งวิดีโอ …'
      : 'กำลังวิเคราะห์ด้วย YOLOv8 …');
    let r = await callApi(API.stage1, { method: 'POST', body: stage1Form(file, mode, usedPrivacy, usedAnalysis) });
    if (token !== runToken) return null;
    if (!r.ok && mode === 'dense' && r.code === 'video_too_long') {
      notice = 'วิดีโอยาวเกินกว่าจะตรวจต่อเนื่องได้ → แสดงผลเป็นภาพทีละเฟรมแทน';
      setState(ui.s1State, 'loading', 'วิดีโอยาวเกินสำหรับโหมดต่อเนื่อง — กำลังลองแบบเลือกเฟรม …');
      r = await callApi(API.stage1, { method: 'POST', body: stage1Form(file, 'frames', usedPrivacy, usedAnalysis) });
      if (token !== runToken) return null;
    }
    if (!r.ok) { setState(ui.s1State, 'error', errorText(r), r.detail); return r; }
    const d = r.data;
    if (!Array.isArray(d.frames) || !d.frames.length || !d.source || !Array.isArray(d.class_names)) {
      setState(ui.s1State, 'error', 'API ตอบกลับในรูปแบบที่ไม่รู้จัก (Stage 1)');
      return { ok: false };
    }
    d.privacy = { model: 'OpenCV YuNet (local)', settings: {
      face_confidence: usedPrivacy.face_confidence,
      padding_fraction: usedPrivacy.face_padding,
      blur_strength: usedPrivacy.face_blur_strength
    } };
    renderStage1(d, notice);
    if (d.frames[0] && d.frames[0].image_jpeg_b64) setSafePreview(d.frames[0].image_jpeg_b64);
    return r;
  }

  async function runStage2(file, token) {
    setState(ui.s2State, 'loading', 'กำลังจัดประเภท ทะเลาะ / ปกติ ด้วย X3D-S …');
    const fd = new FormData();
    fd.append('file', file, file.name);
    fd.append('device', ui.device ? ui.device.value : 'auto');
    const values = analysisSettings();
    if (values) fd.append('analysis_settings', JSON.stringify(values));
    const r = await callApi(API.stage2, { method: 'POST', body: fd });
    if (token !== runToken) return null;
    if (!r.ok) { setState(ui.s2State, 'error', errorText(r), r.detail); return r; }
    const d = r.data;
    if (!Array.isArray(d.windows) || !d.summary || !Array.isArray(d.class_names) || !d.source) {
      setState(ui.s2State, 'error', 'API ตอบกลับในรูปแบบที่ไม่รู้จัก (Stage 2)');
      return { ok: false };
    }
    renderStage2(d);
    return r;
  }

  async function runPipeline(file, token) {
    const usedPrivacy = privacySettings();
    const usedAnalysis = analysisSettings();
    setState(ui.s1State, 'loading', 'กำลังตรวจใบหน้าทุกเฟรมและรัน YOLO; X3D ประเมินทุกช่วง …');
    setState(ui.s2State, 'loading', 'กำลังรัน X3D พร้อมบันทึก person-trigger แบบ shadow …');
    const fd = new FormData();
    fd.append('file', file, file.name);
    fd.append('model', ui.model.value);
    fd.append('device', ui.device ? ui.device.value : 'auto');
    fd.append('sample_fps', String(clampFloat(ui.sampleFps.value, SAMPLE_FPS)));
    appendPrivacySettings(fd, usedPrivacy);
    if (usedAnalysis) fd.append('analysis_settings', JSON.stringify(usedAnalysis));
    const r = await callApi(API.pipeline, { method: 'POST', body: fd });
    if (token !== runToken) return null;
    if (!r.ok) {
      const msg = errorText(r);
      setState(ui.s1State, 'error', msg, r.detail);
      setState(ui.s2State, 'error', msg, r.detail);
      return r;
    }
    const d = r.data;
    if (!d.stage1 || !d.stage2 || !d.pipeline || !d.face_blur || d.face_blur.complete !== true ||
        !Array.isArray(d.face_blur.faces_by_frame) || !d.stage1.source ||
        d.face_blur.faces_by_frame.length !== d.stage1.source.frame_count ||
        !Array.isArray(d.stage1.frames) ||
        !Array.isArray(d.stage2.windows) || !Array.isArray(d.pipeline.windows)) {
      setState(ui.s1State, 'error', 'API ตอบกลับในรูปแบบ pipeline ที่ไม่รู้จัก');
      setState(ui.s2State, 'error', 'API ตอบกลับในรูปแบบ pipeline ที่ไม่รู้จัก');
      return { ok: false };
    }
    applyFallFightReview(d);
    d.stage1.device_used = d.device_used;
    d.stage2.device_used = d.device_used;
    d.stage1.timings_ms = d.timings_ms;
    st.faceBlur = d.face_blur;
    d.stage1.privacy = {
      model: d.face_blur.model,
      faces_detected: d.face_blur.faces_detected,
      detection_ms: d.face_blur.detection_ms,
      scan_wall_ms: d.face_blur.scan_wall_ms,
      settings: d.face_blur.settings
    };
    renderStage1(d.stage1, '');
    const p = d.pipeline.summary;
    d.stage2.pipeline = {
      mode: d.pipeline_mode,
      total_windows: p.total_windows,
      person_triggered_windows: p.person_triggered_windows,
      candidate_triggered_windows: p.candidate_triggered_windows,
      fight_without_candidate_trigger: p.fight_windows_without_candidate_trigger,
      review_fall_fight_conflict_windows: p.review_fall_fight_conflict_windows,
      fight_candidate_windows: p.fight_candidate_windows,
      fall_detected_windows: p.fall_detected_windows,
      proximity_diagonals: d.trigger_parameters.proximity_max_distance_frame_diagonals,
      motion_diagonals_per_s: d.trigger_parameters.motion_min_speed_frame_diagonals_per_s,
      windows: d.pipeline.windows
    };
    renderStage2(d.stage2);
    setSafePreview(d.preview_jpeg_b64);
    return r;
  }

  // Derive the same review state client-side when an already-running API worker
  // has not reloaded yet; the raw X3D class and probabilities remain untouched.
  function applyFallFightReview(data) {
    const frames = data.stage1.frames || [];
    data.pipeline.windows.forEach(pw => {
      const x3d = data.stage2.windows[pw.index];
      if (!x3d) return;
      const fallFrames = frames.filter(frame => frame.time_s >= pw.start_s && frame.time_s < pw.end_s &&
        frame.detections.some(detection => detection.class_name === 'fall'));
      pw.fall_detected = fallFrames.length > 0;
      pw.fall_frames = fallFrames.length;
      if (x3d.label === 'fight' && pw.fall_detected) {
        pw.decision = 'review_fall_fight_conflict';
        pw.decision_label = 'ล้ม/Fight กำกวม · ตรวจสอบ';
      } else if (x3d.label === 'fight') {
        pw.decision = 'fight_candidate';
        pw.decision_label = 'สงสัย Fight · pilot';
      } else if (pw.fall_detected) {
        pw.decision = 'fall_detected';
        pw.decision_label = 'พบสัญญาณ Fall · ตรวจสอบ';
      } else {
        pw.decision = 'no_fight_candidate';
        pw.decision_label = 'ไม่พบ Fight candidate';
      }
    });
    const summary = data.pipeline.summary;
    summary.review_fall_fight_conflict_windows = data.pipeline.windows.filter(
      window => window.decision === 'review_fall_fight_conflict').length;
    summary.fight_candidate_windows = data.pipeline.windows.filter(
      window => window.decision === 'fight_candidate').length;
    summary.fall_detected_windows = data.pipeline.windows.filter(window => window.fall_detected).length;
  }

  function setSafePreview(base64) {
    if (typeof base64 !== 'string' || !base64) return;
    clear(ui.preview);
    const img = el('img'); img.alt = window.CCTVMode.active
      ? 'ภาพวาดหรือ preview ที่ตรวจแล้วสำหรับโหมดสาธิต · ไม่ได้ยืนยันการสแกนหรือเบลอใบหน้า'
      : 'ภาพตัวอย่างหลังเบลอใบหน้า';
    img.src = 'data:image/jpeg;base64,' + base64;
    ui.preview.appendChild(img);
  }

  async function analyzeRun() {
    if (window.CCTVMode.active) {
      resetResults(); const token=runToken; ui.run.disabled=true;
      setState(ui.status,'loading','กำลังอ่านผลสาธิต · ไม่ inference ใหม่');
      try {
        const data=await window.CCTVMode.analyze(analysisSettings());
        if(token!==runToken)return;
        $('v-analyze').classList.add('has-file'); ui.preview.hidden=false; ui.preview.classList.add('thumb');
        renderStage1(data.stage1,window.CCTVMode.origin(data.context));
        setSafePreview(data.stage1.frames[0].image_jpeg_b64);
        if(data.stage2)renderStage2(data.stage2);
        else setState(ui.s2State,'info','ภาพนิ่ง · ไม่ใช้ Stage 2 ในสถานการณ์นี้');
        setState(ui.status,'info',window.CCTVMode.origin(data.context)+' · รอบ '+data.run_id);
      } catch(error) { if(token===runToken)setState(ui.status,'error',error.message); }
      finally { if(token===runToken)ui.run.disabled=false; }
      return;
    }
    const file = st.file;
    if (!file) { setState(ui.status, 'error', 'กรุณาเลือกไฟล์ภาพหรือวิดีโอก่อน'); return; }
    const kind = st.kind;
    if (!kind) { setState(ui.status, 'error', ERROR_TH.unsupported_media_type); return; }
    if (file.size === 0) { setState(ui.status, 'error', ERROR_TH.missing_file); return; }
    if (file.size > MAX_BYTES) { setState(ui.status, 'error', ERROR_TH.file_too_large); return; }

    resetResults();            // nothing from a previous run stays on screen
    const token = runToken;
    ui.run.disabled = true;
    const pv = ui.preview.querySelector('video');
    if (pv) pv.pause();

    let mode = 'frames', notice = '';
    if (kind === 'video') {
      setState(ui.status, 'loading', 'กำลังตรวจว่าเบราว์เซอร์เล่นวิดีโอนี้ได้หรือไม่ …');
      const p = st.probe ? await st.probe : { ok: false, reason: 'ไม่ได้ตรวจ' };
      if (token !== runToken) return;
      if (p.ok) mode = 'dense';
      else notice = 'เบราว์เซอร์เล่นวิดีโอนี้ไม่ได้ (' + p.reason + ') จึงแสดงผลเป็นภาพทีละเฟรมแทนการเล่นวิดีโอ';
    }
    setState(ui.status, 'loading', kind === 'video'
      ? 'กำลังส่งวิดีโอไปวิเคราะห์ (Stage 1 + Stage 2) …'
      : 'กำลังส่งภาพไปวิเคราะห์ (Stage 1) …');

    const results = [];
    try {
      if (kind === 'video' && mode === 'dense') results.push(await runPipeline(file, token));
      else {
        // The backend owns one inference slot. Sequential fallback avoids rejecting
        // our own Stage 2 request with analysis_busy while Stage 1 is still running.
        results.push(await runStage1(file, mode, notice, token));
        if (token !== runToken) return;
        if (kind === 'video') results.push(await runStage2(file, token));
        else setState(ui.s2State, 'info', 'Stage 2 ต้องใช้ไฟล์วิดีโอ — ไม่ได้เรียก Stage 2 สำหรับภาพนิ่ง');
      }
    } catch (err) {
      if (token === runToken) setState(ui.status, 'error', 'แสดงผลไม่สำเร็จ — ' + err.message);
      return;
    } finally {
      if (token === runToken) ui.run.disabled = false;
    }
    if (token !== runToken) return;
    ui.run.disabled = false;
    ui.preview.classList.add('thumb');   // the result view replaces the large preview
    const failed = results.filter(r => !r || !r.ok).length;
    if (failed === 0 && notice) setState(ui.status, 'warn', 'วิเคราะห์แยก Stage 1 และ Stage 2 สำเร็จ · แสดงภาพทีละเฟรม · ไม่ใช่ Pipeline รวม');
    else if (failed === 0) ui.status.hidden = true;
    else if (failed === results.length) setState(ui.status, 'error', 'วิเคราะห์ไม่สำเร็จ — ดูรายละเอียดในแต่ละ Stage');
    else setState(ui.status, 'warn', 'วิเคราะห์เสร็จบางส่วน — ดูรายละเอียดในแต่ละ Stage');
    loadHealth();
  }

  /* ---------------- wire up ---------------- */
  Array.prototype.forEach.call(ui.model.options, opt => { opt.dataset.label = opt.textContent; });
  ui.file.addEventListener('change', onFileChange);
  $('azResetSettings').addEventListener('click', () => {
    $('azUseSavedSettings').checked = false;
    $('azUseSavedSettings').dispatchEvent(new Event('change'));
    const defaults = {
      azThPerson:'0.25', azThHelmet:'0.20', azThVest:'0.20', azThFall:'0.20', azThFire:'0.20', azThSmoke:'0.20',
      azYoloIou:'0.70', azYoloImg:'640', azYoloMaxDet:'300', azX3dThreshold:'0.50',
      azTrackProximity:'0.16', azTrackMotion:'0.25', azTrackGap:'0.75',
      azFaceConfidence:'0.35', azFacePadding:'0.25', azFaceBlur:'0.80', azSampleFps:'10', azMaxFrames:'16'
    };
    Object.entries(defaults).forEach(([id, value]) => { const input = $(id); if (input) input.value = value; });
    updatePrivacySettingLabels();
  });
  [ui.faceConfidence, ui.facePadding, ui.faceBlur].forEach(input => input.addEventListener('input', updatePrivacySettingLabels));
  async function analyze() {
    window.CCTVMode.lock('analyze',true);
    try { await analyzeRun(); } finally { window.CCTVMode.lock('analyze',false); }
  }
  document.addEventListener('cctv:modechange',ev => {
    resetResults(); ui.status.hidden=true; clear(ui.preview); [ui.faceConfidence,ui.facePadding,ui.faceBlur].forEach(input=>input.disabled=ev.detail.demo); ui.model.disabled=ev.detail.demo; if(ui.device)ui.device.disabled=ev.detail.demo;
    if(st.url){URL.revokeObjectURL(st.url);st.url=null;}
    if(ev.detail.demo){ui.run.disabled=false;ui.file.disabled=true;ui.fileInfo.textContent='ใช้สถานการณ์บนแถบสาธิต · ไม่อัปโหลดไฟล์';ui.preview.hidden=true;}
    else {ui.file.disabled=false;onFileChange();}
    loadHealth();
  });
  ui.run.addEventListener('click', analyze);
  ui.healthRefresh.addEventListener('click', loadHealth);
  window.addEventListener('beforeunload', () => { if (st.url) URL.revokeObjectURL(st.url); });
  onFileChange();
  updatePrivacySettingLabels();
  loadHealth();
})();
