/* Real local observation history. Never fall back to mock rows. */
(function () {
  'use strict';
  const $ = id => document.getElementById(id);
  const types = {person:'บุคคล', helmet:'หมวกนิรภัย', vest:'เสื้อสะท้อนแสง', fall:'สงสัยว่ามีคนล้ม',
    fire:'ตรวจพบไฟ', smoke:'ตรวจพบควัน', no_helmet:'ไม่พบหมวกนิรภัย (กฎ PPE)', no_vest:'ไม่พบเสื้อสะท้อนแสง (กฎ PPE)',
    fight:'สงสัยการทะเลาะ (X3D)', non_fight:'ไม่พบสัญญาณทะเลาะ (X3D)', review_fall_fight_conflict:'ผลการล้มและการทะเลาะยังไม่ชัดเจน'};
  const states = {new:'รอตรวจสอบ', ack:'รับทราบแล้ว', closed:'ปิดรายการ'};
  const runStates = {queued:'รอเริ่ม', running:'กำลังทำงาน', completed:'เสร็จแล้ว', stopped:'หยุดแล้ว', degraded:'ทำงานได้บางส่วน', error:'เกิดข้อผิดพลาด', cancelled:'ยกเลิกแล้ว'};
  const sourceTypes = {file:'ไฟล์', realtime:'ภาพสด'};
  const controls = ['rlSearch','rlPeriod','rlSource','rlType','rlStatus'];
  let page = 1, pages = 1, requestToken = 0, detailToken = 0, selected = null, timer;
  const fmt = value => new Date(value).toLocaleString('th-TH', {timeZone:'Asia/Bangkok'});
  const node = (tag, text) => {const n = document.createElement(tag); n.textContent = text; return n;};
  function message(text) { $('rlMessage').textContent = text; }
  async function api(path, options) {
    const response = await window.CCTVMode.fetch(path, options);
    let body;
    try { body = await response.json(); } catch (_) { throw new Error('ระบบส่งข้อมูลประวัติในรูปแบบที่อ่านไม่ได้'); }
    if (!response.ok) throw new Error(body.error?.message || 'อ่านประวัติไม่สำเร็จ');
    return body;
  }
  function query() {
    const params = new URLSearchParams({page:String(page), page_size:'10', period:$('rlPeriod').value});
    for (const [id,key] of [['rlSearch','q'],['rlSource','run_id'],['rlType','event_type'],['rlStatus','status']]) {
      const value = $(id).value.trim(); if (value) params.set(key,value);
    }
    return params.toString();
  }
  async function sources(token) {
    const selectedSource = $('rlSource').value;
    const result = await api('/api/logs/sources');
    if (token !== requestToken) return;
    $('rlSource').replaceChildren(node('option','ทุกแหล่ง'));
    $('rlSource').firstChild.value = '';
    for (const run of result.items) {
      const option = node('option',run.source_label + ' · ' + run.id.slice(0,8) + ' · ' + (runStates[run.state] || run.state));
      option.value = run.id; $('rlSource').append(option);
    }
    if (Array.from($('rlSource').options).some(x => x.value === selectedSource)) $('rlSource').value = selectedSource;
  }
  async function load(refreshSources = false) {
    const token = ++requestToken;
    message((window.CCTVMode.active ? 'กำลังอ่านประวัติสาธิต…' : 'กำลังอ่านประวัติจากฐานข้อมูล…'));
    $('rlBody').replaceChildren(); $('rlEmpty').hidden = true;
    $('rlPrev').disabled = $('rlNext').disabled = true;
    try {
      if (refreshSources) await sources(token);
      if (token !== requestToken) return;
      const result = await api('/api/logs?' + query());
      if (token !== requestToken) return;
      page = result.page; pages = result.pages;
      for (const item of result.items) {
        const row = document.createElement('tr');
        const time = item.start_s == null ? 'ภาพนิ่ง' : item.start_s.toFixed(2) + '–' + item.end_s.toFixed(2) + ' s';
        for (const value of [window.CCTVMode.id('OBS',item.id)+' · '+fmt(item.recorded_at),
          item.source_label+' · '+item.run_id.slice(0,8)+' · '+(runStates[item.run_state] || item.run_state),
          (types[item.event_type] || item.event_type)+' · '+item.model,
          time,item.score.toFixed(4),String(item.observation_count),states[item.status]]) row.append(node('td',value));
        const cell = document.createElement('td'), button = node('button','ดู '+window.CCTVMode.id('OBS',item.id));
        button.type = 'button'; button.className = 'btn'; button.addEventListener('click',() => detail(item.id));
        cell.append(button); row.append(cell); $('rlBody').append(row);
      }
      $('rlEmpty').hidden = result.total > 0;
      $('rlInfo').textContent = result.total + ' รายการผลตรวจจับ · หน้า ' + page + '/' + pages;
      $('navLogs').textContent = String(result.pending_total);
      $('rlPrev').disabled = page <= 1; $('rlNext').disabled = page >= pages;
      message(result.total ? (window.CCTVMode.active ? 'ข้อมูลสาธิตในหน่วยความจำ · สถานะตรวจสอบไม่ใช่การยืนยันเหตุ' : 'ข้อมูลจากโมเดลที่บันทึกจริง · สถานะตรวจสอบไม่ใช่การยืนยันเหตุ') : 'ไม่มีผลที่ตรงกับตัวกรอง · รอบที่ไม่พบวัตถุยังแสดงในรายการแหล่งไฟล์');
    } catch (err) {
      if (token !== requestToken) return;
      $('rlInfo').textContent = ''; $('navLogs').textContent = '—';
      message('อ่านประวัติไม่ได้ · ' + err.message + ' · ไม่มีการใช้ข้อมูลจำลองแทน');
    }
  }
  async function detail(id) {
    const token = ++detailToken;
    selected = null;
    $('rlTitle').textContent = 'กำลังโหลดผล OBS-'+id;
    $('rlMask').classList.add('on'); $('rlDetails').replaceChildren();
    $('rlReviewMessage').textContent = 'กำลังอ่านรายละเอียด…';
    reviewButtons(true);
    try {
      const item = await api('/api/logs/'+id);
      if (token !== detailToken) return;
      selected = item;
      $('rlTitle').textContent = window.CCTVMode.id('OBS',item.id)+' · '+(types[item.event_type] || item.event_type);
      const values = [
        ...(item.context ? [['ที่มาของผล',window.CCTVMode.origin(item.context)],['เวลาหลักฐานเดิม',item.context.captured_at || (item.context.kind==='captured'?'ไม่ได้บันทึกเวลารันเดิม':'ไม่ใช้ · สถานการณ์สมมติ')],['หลักฐาน',item.context.evidence || 'ไม่มี · สถานการณ์สมมติ'],['ค่าที่ใช้ตอนรันหลักฐานเดิม',item.context.recorded_settings ? JSON.stringify(item.context.recorded_settings) : 'ไม่ใช้ · สถานการณ์สมมติ']] : []),
        ['แหล่งภาพ',item.source_label],['ชนิดแหล่งภาพ',sourceTypes[item.source_type] || item.source_type],['รอบตรวจจับ',item.run_id],
        ['สถานะรอบตรวจจับ',runStates[item.run_state] || item.run_state],['รุ่นโมเดล',item.model],['สถานะตรวจสอบ',states[item.status]],
        ['เวลาบันทึก',fmt(item.recorded_at)],['เวลาอัปเดต',fmt(item.updated_at)],
        ['เวลาในวิดีโอ',item.start_s == null ? 'ภาพนิ่ง' : item.start_s.toFixed(2)+'–'+item.end_s.toFixed(2)+' s'],
        ['คะแนนสูงสุด',String(item.score)],['จำนวนผลที่รวม',String(item.observation_count)],
        ['รายละเอียดประกอบ',JSON.stringify(item.details)],
        ['ประวัติเปลี่ยนสถานะ',item.status_history.map(x => fmt(x.changed_at)+' '+states[x.previous_status]+' → '+states[x.status]).join('\n') || 'ยังไม่มีการเปลี่ยนสถานะ']
      ];
      for (const [label,value] of values) {
        const section = document.createElement('div'), key = node('div',label), val = node('div',value);
        key.className = 'k'; val.className = 'v'; section.append(key,val);
        $('rlDetails').append(section);
      }
      $('rlReviewMessage').textContent = (window.CCTVMode.active ? 'เปลี่ยนสถานะในข้อมูลสาธิตเท่านั้น · ไม่บันทึกในระบบจริง' : 'บันทึกสถานะการตรวจสอบแล้ว');
      reviewButtons(false);
      $('rlClose').focus();
    } catch (err) { if (token === detailToken) $('rlReviewMessage').textContent = err.message; }
  }
  function reviewButtons(disabled) {
    for (const [id,status] of [['rlReopen','new'],['rlAck','ack'],['rlClosed','closed']]) $(id).disabled = disabled || selected?.status === status;
  }
  async function review(status) {
    if (!selected) return;
    window.CCTVMode.lock('review',true);
    const id = selected.id, token = detailToken;
    reviewButtons(true); $('rlReviewMessage').textContent = 'กำลังบันทึกสถานะ…';
    try {
      await api('/api/logs/'+id,{method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify({status})});
      if (token !== detailToken) return;
      await detail(id); await load();
    } catch (err) {
      if (token === detailToken) { $('rlReviewMessage').textContent = 'บันทึกไม่สำเร็จ · '+err.message; reviewButtons(false); }
    } finally { window.CCTVMode.lock('review',false); }
  }
  function close() { ++detailToken; selected = null; $('rlMask').classList.remove('on'); }
  $('rlClose').addEventListener('click',close);
  $('rlMask').addEventListener('click',ev => { if (ev.target === $('rlMask')) close(); });
  document.addEventListener('keydown',ev => { if (ev.key === 'Escape') close(); });
  for (const [id,status] of [['rlReopen','new'],['rlAck','ack'],['rlClosed','closed']]) $(id).addEventListener('click',() => review(status));
  for (const [key,label] of Object.entries(types)) { const option = node('option',label); option.value = key; $('rlType').append(option); }
  for (const id of controls) $(id).addEventListener(id === 'rlSearch' ? 'input' : 'change',() => {
    clearTimeout(timer); ++requestToken; page = 1; timer = setTimeout(() => load(),id === 'rlSearch' ? 200 : 0);
  });
  $('rlPrev').addEventListener('click',() => { if (page > 1) {--page; load();} });
  $('rlNext').addEventListener('click',() => { if (page < pages) {++page; load();} });
  $('rlClear').addEventListener('click',() => { for (const id of controls) $(id).value = id === 'rlPeriod' ? 'all' : ''; page = 1; load(); });
  $('rlRefresh').addEventListener('click',() => load(true));
  document.addEventListener('cctv:open-observation',ev => {
    const id = ev.detail?.id;
    if (!Number.isSafeInteger(id) || id <= 0) return;
    for (const control of controls) $(control).value = control === 'rlPeriod' ? 'all' : '';
    page = 1;
    load(true);
    detail(id);
  });
  document.addEventListener('cctv:modechange',ev => { ++requestToken; close(); clearTimeout(timer); page=1; load(true); });
  document.addEventListener('cctv:datachange',() => { if (window.CCTVMode.active) load(true); });
  document.querySelectorAll('[data-go="logs"]').forEach(button => button.addEventListener('click',() => {page = 1; load(true);}));
}());
