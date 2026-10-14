/* Dashboard counts persisted model summaries; never substitute demo camera data. */
(function () {
  'use strict';
  const $ = id => document.getElementById(id);
  const types = {person:'คน', helmet:'หมวกนิรภัย', vest:'เสื้อกั๊ก', fall:'สัญญาณ Fall',
    fire:'สัญญาณไฟ', smoke:'สัญญาณควัน', no_helmet:'ไม่พบหมวก (กฎ PPE)', no_vest:'ไม่พบเสื้อกั๊ก (กฎ PPE)',
    fight:'X3D: สงสัย Fight', non_fight:'X3D: Non-fight', review_fall_fight_conflict:'Fall/Fight กำกวม'};
  const review = {new:'รอตรวจสอบ', ack:'รับทราบแล้ว', closed:'ปิดรายการ'};
  const states = {idle:'ยังไม่มีเซสชัน', starting:'กำลังเริ่ม', running:'กำลังประมวลผล', stopping:'กำลังหยุด',
    stopped:'จบแล้ว', error:'ผิดพลาด', degraded:'ประมวลผลไม่ทัน', interrupted:'ถูกขัดจังหวะ', completed:'สำเร็จ'};
  const fmt = value => new Date(value).toLocaleString('th-TH', {timeZone:'Asia/Bangkok'});
  const node = (tag, text, cls) => {
    const el = document.createElement(tag); el.textContent = text;
    if (cls) el.className = cls;
    return el;
  };
  let token = 0, controller, loading = false;
  async function api(path, signal) {
    const response = await window.CCTVMode.fetch(path, {signal});
    let data;
    try { data = await response.json(); } catch (_) { throw new Error('API ส่งข้อมูลที่อ่านไม่ได้'); }
    if (!response.ok) throw new Error(data.error?.message || 'เรียก API ไม่สำเร็จ');
    return data;
  }
  function clearHistory() {
    for (const id of ['dbTotal','dbPending','dbRuns']) $(id).textContent = '—';
    $('dbReviewed').textContent = 'รับทราบ — · ปิดรายการ —';
    for (const id of ['dbDaily','dbTypes','dbLatest']) $(id).replaceChildren();
    $('dbUpdated').textContent = 'ยังไม่ได้อ่านข้อมูลรอบนี้';
  }
  function series(id, entries) {
    const max = Math.max(1, ...entries.map(x => x[1]));
    $(id).replaceChildren();
    for (const [label, count] of entries) {
      const row = node('div', '', 'db-bar'), meter = document.createElement('meter');
      meter.min = 0; meter.max = max; meter.value = count;
      meter.setAttribute('aria-label', label + ': ' + count + ' รายการ');
      row.append(node('span',label), meter, node('b',String(count)));
      $(id).append(row);
    }
  }
  function history(data) {
    $('dbTotal').textContent = String(data.total);
    $('dbPending').textContent = String(data.by_status.new);
    $('dbReviewed').textContent = 'รับทราบ ' + data.by_status.ack + ' · ปิดรายการ ' + data.by_status.closed;
    $('dbRuns').textContent = String(data.run_count);
    series('dbDaily', data.daily.map(x => [x.date, x.count]));
    series('dbTypes', Object.entries(data.by_type).map(([key,n]) => [types[key] || key,n]));
    $('dbLatest').replaceChildren();
    for (const item of data.latest) {
      const row = node('div','', 'db-result');
      row.append(node('b','OBS-' + item.id + ' · ' + (types[item.event_type] || item.event_type)),
        node('div',item.source_label + ' · ' + item.model),
        node('small',fmt(item.recorded_at) + ' · ' + review[item.status] + ' · ' + (states[item.run_state] || item.run_state)));
      $('dbLatest').append(row);
    }
    if (!data.total) $('dbLatest').append(node('p','ไม่มีรายการผลโมเดลในช่วงที่เลือก', 'db-empty'));
    $('navLogs').textContent = String(data.pending_total);
    $('dbMessage').textContent = data.total ? 'อ่านภาพรวมจากฐานข้อมูลแล้ว · จำนวนรายการไม่ใช่จำนวนเหตุที่ยืนยัน' :
      data.run_count ? 'มีรอบวิเคราะห์ในช่วงนี้ แต่ยังไม่มีรายการผลโมเดลที่บันทึก' : 'ยังไม่มีข้อมูลในช่วงที่เลือก · เริ่มวิเคราะห์ไฟล์หรือ Live replay เพื่อสร้างประวัติ';
    $('dbUpdated').textContent = 'ข้อมูลประวัติ ณ ' + fmt(data.generated_at) +
      ' (Asia/Bangkok) · สถานะรอบที่เริ่มในช่วงนี้: ' +
      (Object.entries(data.run_states).map(([s,n]) => (states[s] || s) + ' ' + n).join(', ') || 'ไม่มีรอบวิเคราะห์');
  }
  function live(data) {
    $('dbLive').replaceChildren();
    $('dbLiveState').textContent = states[data.status] || data.status;
    if (!data.session_id) {
      $('dbLive').append(node('p','ยังไม่มีเซสชัน Live ใน backend process นี้'));
    } else {
      for (const text of ['เซสชัน: ' + data.session_id,
        'สถานะ: ' + (states[data.status] || data.status),
        'แหล่งภาพ: ' + (data.playback_mode === 'realtime' ? 'RTSP' : 'ไฟล์ replay'),
        'เฟรมรับเข้า ' + data.frames_received + ' · ประมวลผลแล้ว ' + data.frames_processed,
        'YOLO/X3D: ' + data.device_used + ' · YuNet: CPU']) $('dbLive').append(node('p',text));
      if (data.reason) $('dbLive').append(node('p','เหตุผล: ' + data.reason));
    }
    $('dbLiveMessage').textContent = 'อ่านสถานะจาก API แล้ว · ' + fmt(new Date());
  }
  async function load({background = false} = {}) {
    if (window.CCTVMode.active) return;
    const current = ++token;
    if (controller) controller.abort();
    controller = new AbortController();
    const active = controller, timeout = setTimeout(() => active.abort(), 10000);
    loading = true;
    if (!background) {
      clearHistory(); $('dbLive').replaceChildren(); $('dbLiveState').textContent = '—';
      $('dbMessage').textContent = 'กำลังอ่านภาพรวมจาก SQLite…';
      $('dbLiveMessage').textContent = 'กำลังอ่านสถานะ Live…';
    }
    try {
      const results = await Promise.allSettled([
        api('/api/dashboard?period=' + encodeURIComponent($('dbPeriod').value), active.signal),
        api('/api/live/status', active.signal)
      ]);
      if (current !== token) return;
      if (results[0].status === 'fulfilled') history(results[0].value);
      else {
        clearHistory();
        $('navLogs').textContent = '—';
        $('dbMessage').textContent = 'อ่านภาพรวมไม่ได้ · ' + results[0].reason.message + ' · ลองรีเฟรชอีกครั้ง';
      }
      if (results[1].status === 'fulfilled') live(results[1].value);
      else {
        $('dbLive').replaceChildren(); $('dbLiveState').textContent = '—';
        $('dbLiveMessage').textContent = 'อ่านสถานะ Live ไม่ได้ · ' + results[1].reason.message;
      }
    } finally {
      clearTimeout(timeout);
      if (current === token) loading = false;
    }
  }
  $('dbRefresh').addEventListener('click',load);
  $('dbPeriod').addEventListener('change',load);
  document.querySelectorAll('[data-go="dashboard"]').forEach(button => button.addEventListener('click',load));
  setInterval(() => {
    if (!loading && !document.hidden && document.body.dataset.page === 'dashboard') load({background:true});
  }, 10000);
  document.addEventListener('cctv:modechange',ev => {
    ++token; controller?.abort(); loading = false;
    if (!ev.detail.demo) load();
  });
  load();
}());
