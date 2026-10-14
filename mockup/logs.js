/* Real local observation history. Never fall back to mock rows. */
(function () {
  'use strict';
  const $ = id => document.getElementById(id);
  const types = {person:'คน', helmet:'หมวกนิรภัย', vest:'เสื้อกั๊ก', fall:'สัญญาณ Fall',
    fire:'สัญญาณไฟ', smoke:'สัญญาณควัน', no_helmet:'ไม่พบหมวก · กฎ PPE', no_vest:'ไม่พบเสื้อกั๊ก · กฎ PPE',
    fight:'X3D: สงสัย Fight', non_fight:'X3D: Non-fight', review_fall_fight_conflict:'Fall/Fight กำกวม'};
  const states = {new:'รอตรวจสอบ', ack:'รับทราบแล้ว', closed:'ปิดรายการ'};
  const controls = ['rlSearch','rlPeriod','rlSource','rlType','rlStatus'];
  let page = 1, pages = 1, requestToken = 0, detailToken = 0, selected = null, timer;
  const fmt = value => new Date(value).toLocaleString('th-TH', {timeZone:'Asia/Bangkok'});
  const node = (tag, text) => {const n = document.createElement(tag); n.textContent = text; return n;};
  function message(text) { $('rlMessage').textContent = text; }
  async function api(path, options) {
    const response = await window.CCTVMode.fetch(path, options);
    let body;
    try { body = await response.json(); } catch (_) { throw new Error('API ไม่ได้ส่งข้อมูลประวัติที่อ่านได้'); }
    if (!response.ok) throw new Error(body.error?.message || 'เรียก API ประวัติไม่สำเร็จ');
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
      const option = node('option',run.source_label + ' · ' + run.id.slice(0,8) + ' · ' + run.state);
      option.value = run.id; $('rlSource').append(option);
    }
    if (Array.from($('rlSource').options).some(x => x.value === selectedSource)) $('rlSource').value = selectedSource;
  }
  async function load(refreshSources = false) {
    if (window.CCTVMode.active) return;
    const token = ++requestToken;
    message('กำลังอ่านประวัติจากฐานข้อมูล…');
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
        for (const value of ['OBS-'+item.id+' · '+fmt(item.recorded_at),
          item.source_label+' · '+item.run_id.slice(0,8)+' · '+item.run_state,
          (types[item.event_type] || item.event_type)+' · '+item.model,
          time,item.score.toFixed(4),String(item.observation_count),states[item.status]]) row.append(node('td',value));
        const cell = document.createElement('td'), button = node('button','ดู OBS-'+item.id);
        button.type = 'button'; button.className = 'btn'; button.addEventListener('click',() => detail(item.id));
        cell.append(button); row.append(cell); $('rlBody').append(row);
      }
      $('rlEmpty').hidden = result.total > 0;
      $('rlInfo').textContent = result.total + ' รายการผลตรวจจับ · หน้า ' + page + '/' + pages;
      $('navLogs').textContent = String(result.pending_total);
      $('rlPrev').disabled = page <= 1; $('rlNext').disabled = page >= pages;
      message(result.total ? 'ข้อมูลจากโมเดลที่บันทึกจริง · สถานะตรวจสอบไม่ใช่การยืนยันเหตุ' : 'ไม่มีผลที่ตรงกับตัวกรอง · รอบที่ไม่พบวัตถุยังแสดงในรายการแหล่งไฟล์');
    } catch (err) {
      if (token !== requestToken) return;
      $('rlInfo').textContent = ''; $('navLogs').textContent = '—';
      message('อ่านประวัติไม่ได้ · ' + err.message + ' · ไม่มีการใช้ข้อมูลจำลองแทน');
    }
  }
  async function detail(id) {
    const token = ++detailToken;
    selected = null;
    $('rlTitle').textContent = 'กำลังอ่าน OBS-'+id;
    $('rlMask').classList.add('on'); $('rlDetails').replaceChildren();
    $('rlReviewMessage').textContent = 'กำลังอ่านรายละเอียด…';
    reviewButtons(true);
    try {
      const item = await api('/api/logs/'+id);
      if (token !== detailToken) return;
      selected = item;
      $('rlTitle').textContent = 'OBS-'+item.id+' · '+(types[item.event_type] || item.event_type);
      const values = [
        ['แหล่งไฟล์',item.source_label],['ประเภทแหล่ง',item.source_type],['รอบวิเคราะห์',item.run_id],
        ['สถานะรอบ',item.run_state],['โมเดล',item.model],['สถานะตรวจสอบ',states[item.status]],
        ['เวลาบันทึก (Bangkok)',fmt(item.recorded_at)],['เวลาอัปเดต (Bangkok)',fmt(item.updated_at)],
        ['เวลาในวิดีโอ',item.start_s == null ? 'ภาพนิ่ง' : item.start_s.toFixed(2)+'–'+item.end_s.toFixed(2)+' s'],
        ['คะแนนสูงสุด',String(item.score)],['จำนวน observations',String(item.observation_count)],
        ['รายละเอียดประกอบ',JSON.stringify(item.details)],
        ['ประวัติเปลี่ยนสถานะ',item.status_history.map(x => fmt(x.changed_at)+' '+states[x.previous_status]+' → '+states[x.status]).join('\n') || 'ยังไม่มีการเปลี่ยนสถานะ']
      ];
      for (const [label,value] of values) {
        const section = document.createElement('div'), key = node('div',label), val = node('div',value);
        key.className = 'k'; val.className = 'v'; section.append(key,val);
        $('rlDetails').append(section);
      }
      $('rlReviewMessage').textContent = 'บันทึกสถานะโดยผู้ใช้ในเครื่อง · ไม่มีระบบบัญชีผู้รับผิดชอบ';
      reviewButtons(false);
      $('rlClose').focus();
    } catch (err) { if (token === detailToken) $('rlReviewMessage').textContent = err.message; }
  }
  function reviewButtons(disabled) {
    for (const [id,status] of [['rlReopen','new'],['rlAck','ack'],['rlClosed','closed']]) $(id).disabled = disabled || selected?.status === status;
  }
  async function review(status) {
    if (!selected) return;
    if (window.CCTVMode.active) return;
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
  document.addEventListener('cctv:modechange',ev => { ++requestToken; close(); clearTimeout(timer); if (!ev.detail.demo) { page=1; load(true); } });
  document.querySelectorAll('[data-go="logs"]').forEach(button => button.addEventListener('click',() => {page = 1; load(true);}));
}());
