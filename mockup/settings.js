/* Persisted analysis defaults, separate from per-request advanced controls. */
(function () {
  'use strict';
  const $ = id => document.getElementById(id);
  const fields = [
    ['person','ความมั่นใจ person',.01,.99,.01,'azThPerson','yolo.thresholds.person'],
    ['helmet','ความมั่นใจ helmet',.01,.99,.01,'azThHelmet','yolo.thresholds.helmet'],
    ['vest','ความมั่นใจ vest',.01,.99,.01,'azThVest','yolo.thresholds.vest'],
    ['fall','ความมั่นใจ fall',.01,.99,.01,'azThFall','yolo.thresholds.fall'],
    ['fire','ความมั่นใจ fire',.01,.99,.01,'azThFire','yolo.thresholds.fire'],
    ['smoke','ความมั่นใจ smoke',.01,.99,.01,'azThSmoke','yolo.thresholds.smoke'],
    ['iou','YOLO NMS IoU',.1,.95,.01,'azYoloIou','yolo.iou'],
    ['imgsz','ขนาดภาพเข้า YOLO',null,null,null,'azYoloImg','yolo.imgsz'],
    ['max_det','กล่องสูงสุดต่อเฟรม',1,1000,1,'azYoloMaxDet','yolo.max_det'],
    ['fight','เกณฑ์ Fight ของ X3D-S',.05,.95,.01,'azX3dThreshold','x3d.fight_threshold'],
    ['proximity','ระยะใกล้ของคน (เท่าของเส้นทแยงมุมภาพ)',.01,.5,.01,'azTrackProximity','tracking.proximity_diagonals'],
    ['motion','ความเร็วคน (เส้นทแยงมุมภาพ/วินาที)',.01,2,.01,'azTrackMotion','tracking.motion_diagonals_per_s'],
    ['gap','ช่วงขาด track สูงสุด (วินาที)',.1,3,.01,'azTrackGap','tracking.max_track_gap_s']
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
    $('stRevision').textContent = 'ค่าที่โหลด revision '+revision + (data.updated_at
      ? ' · บันทึกล่าสุด '+new Date(data.updated_at).toLocaleString('th-TH',{timeZone:'Asia/Bangkok'})+' (Bangkok)'
      : ' · ยังไม่เคยบันทึก ใช้ค่าเริ่มต้นของโครงการ');
  }
  function analyzer() {
    const saved = $('azUseSavedSettings').checked;
    for (const [, , , , ,id,path] of fields) {
      $(id).disabled = saved;
      if (saved && latest) $(id).value = String(read(latest.analysis_settings,path));
    }
    $('azSavedSettingsMeta').textContent = saved
      ? 'backend อ่านค่าที่บันทึกเมื่อเริ่มแต่ละคำขอ' + (latest ? ' · ค่าที่อ่านล่าสุด revision '+latest.revision : ' · ยังอ่านค่าบันทึกไม่ได้')
      : 'ใช้ค่าขั้นสูงในฟอร์มเฉพาะคำขอนี้ ไม่บันทึกทับค่าระบบ';
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
    if (busy || window.CCTVMode.active) return;
    const token = modeToken;
    busy = true; buttons(); $('stMessage').textContent = 'กำลังอ่านค่าที่บันทึก…';
    try {
      const data = await api();
      if (token !== modeToken) return;
      latest = data;
      if (!dirty || force || !loaded) editor(data);
      analyzer();
      $('stMessage').textContent = dirty ? 'มีร่างที่ยังไม่บันทึก คงค่าที่แก้ไว้ หาก revision เปลี่ยนให้โหลดค่าปัจจุบันก่อนบันทึก' : 'อ่านค่าจาก backend แล้ว';
    } catch (error) {
      if (token !== modeToken) return;
      $('stMessage').textContent = 'อ่านค่าตั้งไม่ได้ · '+error.message + (loaded ? ' · ฟอร์มยังเป็นค่าที่โหลดครั้งก่อน' : '');
      $('azSavedSettingsMeta').textContent = 'อ่านค่าที่บันทึกไม่ได้ · การวิเคราะห์จะตรวจที่ backend อีกครั้ง';
    } finally { if (token === modeToken) { busy = false; buttons(); } }
  }
  $('stForm').addEventListener('input',() => { dirty = true; buttons(); $('stMessage').textContent = 'มีค่าที่แก้แต่ยังไม่บันทึก'; });
  $('stForm').addEventListener('submit',async ev => {
    ev.preventDefault();
    if (window.CCTVMode.active || busy || !loaded || conflict || !$('stForm').reportValidity()) return;
    const settings = {};
    for (const [path,input] of controls) set(settings,path,Number(input.value));
    window.CCTVMode.lock('settings',true);
    busy = true; buttons(); $('stMessage').textContent = 'กำลังบันทึกค่า…';
    try {
      const data = await api({method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify({analysis_settings:settings,revision})});
      latest = data; editor(data); analyzer();
      $('stMessage').textContent = 'บันทึกแล้ว revision '+data.revision+' · ใช้กับการวิเคราะห์หรือ Live session ถัดไป';
    } catch (error) {
      conflict = error.code === 'settings_conflict';
      $('stMessage').textContent = conflict
        ? 'มีการบันทึกค่าจากหน้าต่างอื่น กรุณาโหลดค่าปัจจุบันแล้วแก้ใหม่ ร่างนี้ยังไม่ถูกบันทึก'
        : 'บันทึกไม่สำเร็จ · '+error.message+' · คงค่าที่แก้ไว้ในฟอร์ม';
    } finally { busy = false; buttons(); window.CCTVMode.lock('settings',false); }
  });
  $('stLoad').addEventListener('click',() => load(true));
  $('stDefaults').addEventListener('click',() => {
    if (!latest) return;
    for (const [path,input] of controls) input.value = String(read(latest.defaults,path));
    dirty = true; buttons(); $('stMessage').textContent = 'ใส่ค่าเริ่มต้นในฟอร์มแล้ว ยังไม่บันทึก กดบันทึกเพื่อใช้กับรอบถัดไป';
  });
  $('azUseSavedSettings').addEventListener('change',analyzer);
  document.querySelectorAll('[data-go="settings"],[data-go="analyze"]').forEach(button => button.addEventListener('click',() => load()));
  document.addEventListener('cctv:modechange',ev => { ++modeToken; busy=false; if (!ev.detail.demo) load(); });
  analyzer(); buttons(); load();
}());
