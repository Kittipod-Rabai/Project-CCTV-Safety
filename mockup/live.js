/* Real single-stream pilot client. Mock cameras elsewhere remain labelled as mock data. */
(function () {
  'use strict';
  const $ = id => document.getElementById(id);
  const sourceType = $('liveSourceType'), source = $('liveSource'), device = $('liveDevice');
  const sourceFile = $('liveSourceFile'), sourceFileField = $('liveSourceFileField');
  const sourcePathField = $('liveSourcePathField'), sourceFileName = $('liveSourceFileName');
  const start = $('liveStart'), stop = $('liveStop'), status = $('liveRealStatus');
  const preview = $('liveRealPreview'), events = $('liveRealEvents'), sourceHelp = $('liveSourceHelp');
  const confidenceList = $('liveRealConfidence'), confidenceMeta = $('liveRealConfidenceMeta');
  const metrics = $('liveRealMetrics');
  if (!start) return;
  let socket = null;
  let generation = 0;
  let activeSession = null;
  let statusTimer = null;
  let latestFight = null;
  let latestConfidenceMessage = null;
  const stateLabels = {idle:'ยังไม่เริ่ม', queued:'กำลังรอเริ่ม', starting:'กำลังเริ่ม', running:'กำลังทำงาน', stopped:'หยุดแล้ว', degraded:'ทำงานได้บางส่วน', error:'เกิดข้อผิดพลาด'};
  const stateLabel = value => stateLabels[value] || value || 'ไม่ทราบสถานะ';
  function report(text) { status.textContent = text; }
  function setControls(active) {
    [sourceType, source, sourceFile, device, $('liveModel')].forEach(input => {
      if (input) input.disabled = active || window.CCTVMode.active;
    });
  }
  function finishSession() {
    start.disabled = false; stop.disabled = true; setControls(false);
    clearTimeout(statusTimer);
    if (socket) { const old = socket; socket = null; old.close(); }
  }
  function pollStatus(token, id) {
    clearTimeout(statusTimer);
    statusTimer = setTimeout(async () => {
      if (token !== generation) return;
      try {
        const body = await request('/api/live/status');
        if (token !== generation) return;
        if (body.session_id !== id) {
          report('รอบตรวจจับเปลี่ยนแล้ว · หยุดแสดงผลรอบก่อน'); finishSession(); return;
        }
        renderMetrics(body);
        if (['stopped', 'degraded', 'error', 'idle'].includes(body.status)) {
          report(stateLabel(body.status) + (body.reason ? ' · ' + body.reason : '')); finishSession(); return;
        }
        report('การเชื่อมต่อผลสดขาดหาย · ระบบ' + stateLabel(body.status) + ' · กดหยุดได้');
      } catch (err) {
        if (token !== generation) return;
        report('อ่านสถานะไม่ได้ · ' + err.message + ' · ตรวจว่าระบบวิเคราะห์กำลังทำงาน');
      }
      if (token === generation) pollStatus(token, id);
    }, 500);
  }
  function deviceSummary(devices, fallback) {
    if (!devices) return fallback || 'ไม่ทราบอุปกรณ์';
    return 'YOLO ' + (devices.yolo || '—') + ' · X3D ' + (devices.x3d || '—') + ' · YuNet ' + (devices.yunet || '—');
  }
  function addEvent(text) {
    const row = document.createElement('div'); row.className = 'feed-item'; row.title = 'รายการผลตรวจจับ · ' + text; row.textContent = text;
    events.prepend(row); while (events.children.length > 40) events.lastChild.remove();
  }
  function confidenceRow(label, value, count) {
    const row = document.createElement('div'); row.className = 'live-confidence-row';
    const title = document.createElement('span'); title.className = 'live-confidence-label'; title.textContent = label;
    const score = document.createElement('span'); score.className = 'live-confidence-value';
    score.textContent = value == null ? '—' : Number(value).toFixed(2);
    if (count != null) score.textContent += ' · ' + count + ' กล่อง';
    const track = document.createElement('span'); track.className = 'live-confidence-track';
    const fill = document.createElement('i');
    fill.style.width = value == null ? '0%' : Math.max(0, Math.min(1, Number(value))) * 100 + '%';
    track.append(fill); row.append(title, score, track); return row;
  }
  function renderConfidence(message) {
    if (!confidenceList) return;
    if (message) latestConfidenceMessage = message;
    const latest = latestConfidenceMessage;
    const classes = latest?.classes || {};
    const names = [['person', 'บุคคล'], ['helmet', 'หมวกนิรภัย'], ['vest', 'เสื้อสะท้อนแสง'],
      ['fall', 'สงสัยคนล้ม'], ['fire', 'ไฟ'], ['smoke', 'ควัน']];
    confidenceList.replaceChildren();
    for (const [key, label] of names) {
      const item = classes[key];
      confidenceList.append(confidenceRow(label, item ? item.max_confidence : null, item ? item.count : 0));
    }
    confidenceList.append(confidenceRow('สงสัยการทะเลาะ (X3D)', latestFight, null));
    if (confidenceMeta && latest) {
      confidenceMeta.textContent = 'รุ่นโมเดล '+(latest.model || 'YOLO') + ' · วินาทีที่ ' + (latest.context ? Number(latest.demo_time_s||0).toFixed(2) : Number(latest.time_s||0).toFixed(2)) + ' · พบ ' + (latest.detection_count || 0) + ' กรอบ';
    } else if (confidenceMeta) {
      const demoRunning=window.CCTVMode.active&&window.CCTVMode.demo?.status().status==='running';
      confidenceMeta.textContent=demoRunning?'รอผลสาธิตแรก · วินาทีที่ 10 · ใช้คะแนนตัวอย่างที่เตรียมไว้':window.CCTVMode.active?'เลือกสถานการณ์แล้วกดเริ่มเฝ้าระวัง':'รอผลจากโมเดลจริง';
    }
  }
  function renderMetrics(message) {
    if (!metrics) return;
    if(message.context){metrics.textContent=window.CCTVMode.origin(message.context)+' · ความเร็วและเวลาประมวลผลไม่ได้วัด · อุปกรณ์จากผลที่บันทึก: '+(message.device_used||'ไม่ได้วัด');return;}
    const timings = message.timings_ms || {};
    const value = key => timings[key] ? `${Number(timings[key].mean_ms).toFixed(1)} ms` : '—';
    const fps = Number(message.processing_fps || 0).toFixed(1);
    const sourceFps = message.source_fps ? Number(message.source_fps).toFixed(1) : '—';
    metrics.textContent = `เฉลี่ยสูงสุด 120 งานล่าสุด · Decode ${value('decode')} · YuNet ${value('face')} · YOLO ${value('yolo')} · X3D ${value('x3d')} · Preview ${value('preview_encode')} · ประมวลผล ${fps} FPS (ต้นทาง ${sourceFps}) · คิว ${message.queue_depth ?? 0}/12 · สแกนหน้า ${message.frames_face_scanned ?? 0}/${message.frames_received ?? 0}`;
  }
  async function request(path, method) {
    const r = await window.CCTVMode.fetch(path, { method: method || 'GET', headers: {'Content-Type': 'application/json'} });
    const body = await r.json();
    if (!r.ok) throw new Error(body.error?.message || 'ระบบเฝ้าระวังสดตอบกลับผิดพลาด');
    return body;
  }
  function handleMessage(msg,token,connection) {
    if(token!==generation||socket!==connection)return;
        if (msg.session_id !== activeSession) return;
        if (msg.type === 'preview' && typeof msg.jpeg_b64 === 'string') {
          preview.alt = msg.context
            ? 'ภาพวาดสถานการณ์สาธิต · ไม่ได้รัน YuNet หรือยืนยันการเบลอใบหน้า'
            : 'Live preview ที่ผ่านการเบลอใบหน้า';
          preview.src = 'data:image/jpeg;base64,' + msg.jpeg_b64; preview.hidden = false;
        } else if (msg.type === 'confidence') {
          renderConfidence(msg);
          if(msg.context){const classLabels={person:'บุคคล',helmet:'หมวกนิรภัย',vest:'เสื้อสะท้อนแสง',fall:'คนล้ม',fire:'ไฟ',smoke:'ควัน'};addEvent('โหมดสาธิต · วินาทีที่ '+msg.demo_time_s+' · '+Object.entries(msg.classes).map(([name,value])=>(classLabels[name]||name)+' '+Number(value.max_confidence).toFixed(4)).join(' · ')+' · รวมผลซ้ำในรายการเดิม');}
        } else if (msg.type === 'candidate') addEvent('พบเงื่อนไขสำหรับประเมินต่อ · วินาทีที่ ' + msg.time_s + ' · ใช้เวลา ' + msg.processing_latency_ms + ' มิลลิวินาที');
        else if (msg.type === 'x3d') {
          latestFight = msg.fight;
          renderConfidence(null);
          addEvent((msg.label === 'fight' ? 'สงสัยการทะเลาะ' : 'ไม่พบสัญญาณทะเลาะ') + ' · คะแนน ' + Number(msg.fight).toFixed(2) + ' · วินาทีที่ ' + msg.start_s + '–' + msg.end_s);
        }
        else if (msg.type === 'health') {
          const replayHint = msg.playback_mode === 'processing_paced' ? ' · ปรับความเร็วคลิปตามกำลังเครื่อง · ไม่ข้ามเฟรม' : '';
          const devices = msg.device_components ? ' · ' + deviceSummary(msg.device_components) : '';
          renderMetrics(msg);
          report(msg.context ? 'โหมดสาธิต · '+stateLabel(msg.state)+' · '+Number(msg.elapsed_s||0).toFixed(1)+' วินาที · ไม่ได้ประมวลผลเฟรมจริง' : stateLabel(msg.state) + (msg.reason ? ' · ' + msg.reason : '') + devices + replayHint + ' · ตรวจใบหน้าแล้ว ' + msg.frames_face_scanned + '/' + msg.frames_received+' เฟรม');
          if (['stopped','degraded','error'].includes(msg.state)) finishSession();
        }

  }
  function updateSourceHelp() {
    const isFile = sourceType.value === 'file';
    if (sourceFileField) sourceFileField.hidden = !isFile;
    if (sourcePathField) sourcePathField.hidden = isFile;
    source.placeholder = isFile ? 'data/raw/clip.mp4' : 'rtsp://กล้องในเครือข่ายของคุณ/stream';
    if (sourceHelp) sourceHelp.textContent = isFile
      ? 'เลือกคลิปจากเครื่องเพื่อทดสอบ ระบบจะส่งไฟล์ชั่วคราวและลบเมื่อจบการทำงาน (ขนาดไม่เกิน 100 MB)'
      : 'ใส่ RTSP URL ของกล้องที่เครื่องนี้เข้าถึงได้ · อย่าแชร์ URL เพราะอาจมีข้อมูลเข้าสู่ระบบ';
  }
  if (sourceFile) sourceFile.addEventListener('change', () => {
    const file = sourceFile.files && sourceFile.files[0];
    if (sourceFileName) sourceFileName.textContent = file ? file.name : 'รองรับ MP4, AVI, MOV, MKV · ไม่เกิน 100 MB';
  });
  sourceType.addEventListener('change', updateSourceHelp);
  updateSourceHelp();
  start.addEventListener('click', async () => {
    if(window.CCTVMode.active){
      const token=++generation;finishSession();events.replaceChildren();preview.hidden=true;latestFight=null;latestConfidenceMessage=null;renderConfidence(null);
      window.CCTVMode.lock('live-start',true);start.disabled=true;
      try {
        const body=await window.CCTVMode.startLive();if(token!==generation)return;activeSession=body.session_id;
        let unsubscribe;const connection={close:()=>unsubscribe?.()};socket=connection;
        unsubscribe=window.CCTVMode.subscribeLive(msg=>handleMessage(msg,token,connection));
        setControls(true);stop.disabled=false;renderMetrics(body);renderConfidence(null);addEvent('เริ่มสถานการณ์สาธิต · ใช้ชุดค่าตั้งเวอร์ชัน '+body.settings_revision);report('เริ่มสถานการณ์สาธิตแล้ว · ผลแรกจะแสดงที่วินาที 10 หรือกด “เหตุการณ์ถัดไป”');
        $('liveDemoContext').hidden=false;$('liveDemoContext').textContent=window.CCTVMode.origin(body.context)+' · ใช้ชุดค่าตั้งเวอร์ชัน '+body.settings_revision;
      }catch(error){report(error.message);finishSession();}
      finally{window.CCTVMode.lock('live-start',false);}
      return;
    }
    const isFile = sourceType.value === 'file';
    const file = sourceFile && sourceFile.files && sourceFile.files[0];
    if (isFile && !file) {
      report('กรุณาเลือกไฟล์วิดีโอ');
      sourceFile?.focus();
      return;
    }
    if (!isFile && !source.value.trim()) {
      report('กรุณาระบุ RTSP URL');
      source.focus();
      return;
    }
    if (isFile && file.size > 100 * 1024 * 1024) {
      report('ไฟล์ต้องมีขนาดไม่เกิน 100 MB');
      return;
    }
    const token = ++generation;
    clearTimeout(statusTimer);
    if (socket) { socket.close(); socket = null; }
    activeSession = null;
    start.disabled = true; stop.disabled = true; setControls(true);
    events.replaceChildren(); preview.hidden = true; preview.removeAttribute('src');
    latestFight = null; latestConfidenceMessage = null;
    if (confidenceList) confidenceList.replaceChildren();
    if (confidenceMeta) confidenceMeta.textContent = 'กำลังเริ่มรอบตรวจจับใหม่';
    if (metrics) metrics.textContent = 'กำลังเริ่มรอบตรวจจับใหม่…';
    try {
      let result;
      if (isFile) {
        const data = new FormData();
        data.append('file', file);
        data.append('model', $('liveModel').value);
        data.append('device', device.value);
        result = await window.CCTVMode.fetch('/api/live/start-upload', {method:'POST', body:data});
      } else {
        result = await window.CCTVMode.fetch('/api/live/start', {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({
          source_type:sourceType.value, source:source.value, model:$('liveModel').value, device:device.value
        })});
      }
      const body = await result.json();
      if (token !== generation) return;
      if (!result.ok) throw new Error(body.error?.message || 'เริ่ม Live ไม่สำเร็จ');
      if (typeof body.session_id !== 'string') throw new Error('ระบบไม่ส่งรหัสรอบตรวจจับ · โปรดเริ่มระบบใหม่');
      activeSession = body.session_id;
      addEvent('ใช้ชุดค่าตั้งเวอร์ชัน '+body.settings_revision);
      stop.disabled = false;
      report(sourceType.value === 'file'
        ? 'กำลังเล่นคลิปต่อเนื่อง · หากเครื่องช้าจะเล่นช้าลงเพื่อไม่ทิ้งเฟรม · ' + deviceSummary(body.device_components, body.device_used)
        : 'กำลังทำงาน · ' + deviceSummary(body.device_components, body.device_used));
      latestFight = null;
      latestConfidenceMessage = null;
      if (metrics) metrics.textContent = 'กำลังวัดเวลาประมวลผลในแต่ละขั้น…';
      if (confidenceList) {
        const waiting = document.createElement('div');
        waiting.className = 'live-confidence-empty';
        waiting.textContent = 'กำลังรอผลตรวจจับ…';
        confidenceList.replaceChildren(waiting);
      }
      if (confidenceMeta) confidenceMeta.textContent = 'กำลังวิเคราะห์';
      const connection = new WebSocket((location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host +
        '/api/live/events?session_id=' + encodeURIComponent(activeSession));
      socket = connection;
      connection.onmessage = ev => {
        if (token !== generation || socket !== connection) return;
        let msg;
        try { msg = JSON.parse(ev.data); } catch (_) { report('WebSocket ส่งข้อมูลไม่ถูกต้อง'); return; }
        handleMessage(msg,token,connection);
      };
      connection.onerror = () => {
        if (token === generation && socket === connection) report('WebSocket ขาดการเชื่อมต่อ · กำลังตรวจสถานะ API');
      };
      connection.onclose = () => {
        if (token !== generation || socket !== connection || !start.disabled) return;
        pollStatus(token, body.session_id);
      };
    } catch (err) {
      if (token === generation) { report(err.message); finishSession(); }
    }
  });
  stop.addEventListener('click', async () => {
    if(window.CCTVMode.active){window.CCTVMode.stopLive();finishSession();report('หยุดสถานการณ์สาธิตแล้ว');return;}
    stop.disabled = true;
    try { await request('/api/live/stop', 'POST'); report('กำลังหยุดและระบายเฟรมที่รับแล้ว'); }
    catch (err) { report(err.message); stop.disabled = false; }
  });
  document.addEventListener('cctv:modechange',() => {
    ++generation;finishSession();preview.hidden=true;preview.removeAttribute('src');events.replaceChildren();latestFight=null;latestConfidenceMessage=null;renderConfidence(null);
    preview.alt=window.CCTVMode.active
      ? 'ภาพวาดสถานการณ์สาธิต · ไม่ได้รัน YuNet หรือยืนยันการเบลอใบหน้า'
      : 'Live preview ที่ผ่านการเบลอใบหน้า';
    $('liveDemoContext').hidden=true;report(window.CCTVMode.active?'พร้อมเริ่มสถานการณ์สาธิต':'ยังไม่เริ่มตรวจจับ');
  });
  window.addEventListener('beforeunload', () => {
    clearTimeout(statusTimer);
    if (socket) socket.close();
  });
}());
