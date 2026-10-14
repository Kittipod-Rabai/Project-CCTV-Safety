/* Persisted analysis defaults, separate from per-request advanced controls. */
(function () {
  'use strict';
  const $ = id => document.getElementById(id);
  const fields = [
    ['person','เกณฑ์คะแนนตรวจพบบุคคล',.01,.99,.01,'azThPerson','yolo.thresholds.person'],
    ['helmet','เกณฑ์คะแนนตรวจพบหมวกนิรภัย',.01,.99,.01,'azThHelmet','yolo.thresholds.helmet'],
    ['vest','เกณฑ์คะแนนตรวจพบเสื้อสะท้อนแสง',.01,.99,.01,'azThVest','yolo.thresholds.vest'],
    ['fall','เกณฑ์คะแนนตรวจพบการล้ม',.01,.99,.01,'azThFall','yolo.thresholds.fall'],
    ['fire','เกณฑ์คะแนนตรวจพบไฟ',.01,.99,.01,'azThFire','yolo.thresholds.fire'],
    ['smoke','เกณฑ์คะแนนตรวจพบควัน',.01,.99,.01,'azThSmoke','yolo.thresholds.smoke'],
    ['iou','การตัดกรอบซ้ำ (YOLO NMS IoU)',.1,.95,.01,'azYoloIou','yolo.iou'],
    ['imgsz','ขนาดภาพที่ส่งให้ YOLO',null,null,null,'azYoloImg','yolo.imgsz'],
    ['max_det','จำนวนกรอบสูงสุดต่อภาพ',1,1000,1,'azYoloMaxDet','yolo.max_det'],
    ['fight','เกณฑ์คะแนนสงสัยการทะเลาะ (X3D-S)',.05,.95,.01,'azX3dThreshold','x3d.fight_threshold'],
    ['proximity','ระยะห่างสำหรับเชื่อมตำแหน่งคน (สัดส่วนทแยงภาพ)',.01,.5,.01,'azTrackProximity','tracking.proximity_diagonals'],
    ['motion','ความเร็วขั้นต่ำในการเคลื่อนที่ (สัดส่วนทแยงภาพ/วินาที)',.01,2,.01,'azTrackMotion','tracking.motion_diagonals_per_s'],
    ['gap','เวลาสูงสุดที่ระบบยังเชื่อมตำแหน่งเดิมได้ (วินาที)',.1,3,.01,'azTrackGap','tracking.max_track_gap_s']
  ];
  const controls = new Map();
  let modeToken = 0;
  let latest = null, revision = null, loaded = false, busy = false, dirty = false, conflict = false;
  const node = (tag,text) => { const el = document.createElement(tag); el.textContent = text; return el; };
  const read = (value,path) => path.split('.').reduce((obj,key) => obj[key],value);
  function set(value,path,input) {
    const keys = path.split('.'); let target = value;
    for (const key of keys.slice(0,-1)) target = target[key] ||= {};
    target[keys[keys.length-1]] = input;
  }
  for (const [key,label,min,max,step,,path] of fields) {
    const wrap = node('div',''); wrap.className = 'st-field';
    const name = node('label',label); name.htmlFor = 'st-'+key;
    const input = document.createElement(key === 'imgsz' ? 'select' : 'input');
    input.id = 'st-'+key; input.required = true; input.disabled = true;
    if (key === 'imgsz') {
      for (const size of [320,480,640,800,960,1280]) {
        const option = node('option',String(size)); option.value = String(size); input.append(option);
      }
    } else { input.type = 'number'; input.min = String(min); input.max = String(max); input.step = step === 1 ? '1' : 'any'; }
    wrap.append(name,input); $('stFields').append(wrap); controls.set(path,input);
  }
  function buttons() {
    for (const input of controls.values()) input.disabled = !loaded || busy;
    $('stSave').disabled = !loaded || busy || !dirty || conflict;
    $('stDefaults').disabled = !loaded || busy;
    $('stLoad').disabled = busy;
  }
  function editor(data) {
    for (const [, , , , , ,path] of fields) controls.get(path).value = String(read(data.analysis_settings,path));
    revision = data.revision; loaded = true; dirty = false; conflict = false;
    $('stRevision').textContent = (window.CCTVMode.active ? 'ชุดค่าตั้งสาธิต · เวอร์ชัน ' : 'ชุดค่าตั้งระบบ · เวอร์ชัน ')+revision + (data.updated_at
      ? ' · บันทึกล่าสุด '+new Date(data.updated_at).toLocaleString('th-TH',{timeZone:'Asia/Bangkok'})
      : ' · ยังไม่เคยบันทึก ใช้ค่าเริ่มต้นของโครงการ');
  }
  function analyzer() {
    const saved = $('azUseSavedSettings').checked;
    for (const [, , , , ,id,path] of fields) {
      $(id).disabled = saved;
      if (saved && latest) $(id).value = String(read(latest.analysis_settings,path));
    }
    $('azSavedSettingsMeta').textContent = saved
      ? (window.CCTVMode.active ? 'ใช้ค่าที่บันทึกไว้ตอนเริ่มรอบ · ไม่ได้ประมวลผลโมเดลใหม่' : 'ระบบจะใช้ค่าที่บันทึกเมื่อเริ่มแต่ละรอบ') + (latest ? ' · เวอร์ชัน '+latest.revision : ' · ยังไม่มีค่าที่บันทึกไว้')
      : (window.CCTVMode.active ? 'ใช้ค่าที่ปรับในฟอร์มกับรอบสาธิตนี้เท่านั้น ไม่เปลี่ยนค่าตั้งหลัก' : 'ใช้ค่าที่ปรับในฟอร์มกับคำขอนี้เท่านั้น ไม่เปลี่ยนค่าตั้งหลัก');
  }
  async function api(options) {
    const controller = new AbortController(), timer = setTimeout(() => controller.abort(),10000);
    try {
      const response = await window.CCTVMode.fetch('/api/settings',{...options,signal:controller.signal,cache:'no-store'});
      const data = await response.json();
      if (!response.ok) {
        const error = new Error(data.error?.message || 'เรียก API ตั้งค่าไม่สำเร็จ');
        error.code = data.error?.code; throw error;
      }
      return data;
    } finally { clearTimeout(timer); }
  }
  async function load(force = false) {
    if (busy) return;
    const token = modeToken;
    busy = true; buttons(); $('stMessage').textContent = window.CCTVMode.active ? 'กำลังโหลดค่าตั้งสาธิต…' : 'กำลังโหลดค่าที่บันทึก…';
    try {
      const data = await api();
      if (token !== modeToken) return;
      latest = data;
      if (!dirty || force || !loaded) editor(data);
      analyzer();
      $('stMessage').textContent = dirty ? 'มีการแก้ไขที่ยังไม่ได้บันทึก ค่าล่าสุดอาจเปลี่ยนจากหน้าต่างอื่น ให้โหลดค่าล่าสุดก่อนบันทึก' : (window.CCTVMode.active ? 'โหลดค่าตั้งสาธิตแล้ว · ใช้เฉพาะในโหมดสาธิต' : 'โหลดค่าตั้งระบบแล้ว');
    } catch (error) {
      if (token !== modeToken) return;
      $('stMessage').textContent = 'โหลดค่าตั้งไม่ได้ · '+error.message + (loaded ? ' · ยังแสดงค่าที่โหลดไว้ก่อนหน้า' : '');
      $('azSavedSettingsMeta').textContent = window.CCTVMode.active
        ? 'โหลดค่าตั้งสาธิตไม่ได้ · ไม่มีการเปิดระบบจริงหรือประมวลผลโมเดลแทน'
        : 'โหลดค่าที่บันทึกไม่ได้ · ระบบจะตรวจการตั้งค่าอีกครั้งก่อนวิเคราะห์';
    } finally { if (token === modeToken) { busy = false; buttons(); } }
  }
  $('stForm').addEventListener('input',() => { dirty = true; buttons(); $('stMessage').textContent = 'มีการแก้ไขที่ยังไม่ได้บันทึก'; });
  $('stForm').addEventListener('submit',async ev => {
    ev.preventDefault();
    if (busy || !loaded || conflict || !$('stForm').reportValidity()) return;
    const settings = {};
    for (const [path,input] of controls) set(settings,path,Number(input.value));
    window.CCTVMode.lock('settings',true);
    busy = true; buttons(); $('stMessage').textContent = 'กำลังบันทึกการตั้งค่า…';
    try {
      const data = await api({method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify({analysis_settings:settings,revision})});
      latest = data; editor(data); analyzer();
      $('stMessage').textContent = (window.CCTVMode.active ? 'บันทึกค่าตั้งสาธิตแล้ว · เวอร์ชัน ' : 'บันทึกค่าตั้งระบบแล้ว · เวอร์ชัน ')+data.revision+(window.CCTVMode.active ? ' · ใช้กับรอบสาธิตถัดไป · การปรับขนาดภาพและการติดตามไม่เปลี่ยนผลเดิม' : ' · ใช้กับการวิเคราะห์หรือเฝ้าระวังรอบถัดไป');
    } catch (error) {
      conflict = error.code === 'settings_conflict';
      $('stMessage').textContent = conflict
        ? 'มีการบันทึกค่าจากหน้าต่างอื่นแล้ว โหลดค่าล่าสุดก่อนแก้ต่อ (การแก้ไขนี้ยังไม่ได้บันทึก)'
        : 'บันทึกไม่สำเร็จ · '+error.message+' · ยังคงค่าที่แก้ไว้ในฟอร์ม';
    } finally { busy = false; buttons(); window.CCTVMode.lock('settings',false); }
  });
  $('stLoad').addEventListener('click',() => load(true));
  $('stDefaults').addEventListener('click',() => {
    if (!latest) return;
    for (const [path,input] of controls) input.value = String(read(latest.defaults,path));
    dirty = true; buttons(); $('stMessage').textContent = 'คืนค่าเริ่มต้นในฟอร์มแล้ว · กดบันทึกเพื่อใช้กับรอบถัดไป';
  });
  $('azUseSavedSettings').addEventListener('change',analyzer);
  document.querySelectorAll('[data-go="settings"],[data-go="analyze"]').forEach(button => button.addEventListener('click',() => load()));
  document.addEventListener('cctv:modechange',ev => { ++modeToken; busy=false; latest=null; loaded=false; dirty=false; conflict=false; $('azUseSavedSettings').checked=true; analyzer(); load(true); });
  analyzer(); buttons(); load();
}());
