/* Dashboard counts persisted model summaries; never substitute demo camera data. */
(function () {
  'use strict';
  const $ = id => document.getElementById(id);
  const types = {person:'บุคคล', helmet:'หมวกนิรภัย', vest:'เสื้อสะท้อนแสง', fall:'สงสัยว่ามีคนล้ม',
    fire:'ตรวจพบไฟ', smoke:'ตรวจพบควัน', no_helmet:'ไม่พบหมวกนิรภัย (กฎ PPE)', no_vest:'ไม่พบเสื้อสะท้อนแสง (กฎ PPE)',
    fight:'สงสัยการทะเลาะ (X3D)', non_fight:'ไม่พบสัญญาณทะเลาะ (X3D)', review_fall_fight_conflict:'ผลการล้มและการทะเลาะยังไม่ชัดเจน'};
  const review = {new:'รอตรวจสอบ', ack:'รับทราบแล้ว', closed:'ปิดรายการ'};
  const states = {idle:'ยังไม่เริ่มตรวจจับ', starting:'กำลังเริ่มตรวจจับ', running:'กำลังตรวจจับ', stopping:'กำลังหยุดตรวจจับ',
    stopped:'หยุดแล้ว', error:'เกิดข้อผิดพลาด', degraded:'ระบบประมวลผลไม่ทันบางส่วน', interrupted:'หยุดชั่วคราว', completed:'เสร็จแล้ว'};
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
    for (const [label, count, eventType] of entries) {
      const row = node('div', '', 'db-bar'), meter = document.createElement('meter');
      if (eventType) row.dataset.eventType = eventType;
      meter.min = 0; meter.max = max; meter.value = count;
      meter.setAttribute('aria-label', label + ': ' + count + ' รายการ');
      row.append(node('span',label), meter, node('b',String(count)));
      $(id).append(row);
    }
  }
  function history(data) {
    const seed = $('dbDemoSeed');
    if (seed) seed.hidden = !window.CCTVMode.active;
    $('dbTotal').textContent = String(data.total);
    $('dbPending').textContent = String(data.by_status.new);
    $('dbReviewed').textContent = 'รับทราบ ' + data.by_status.ack + ' · ปิดรายการ ' + data.by_status.closed;
    $('dbRuns').textContent = String(data.run_count);
    series('dbDaily', data.daily.map(x => [x.date, x.count]));
    series('dbTypes', Object.entries(data.by_type).map(([key,n]) => [types[key] || key,n,key]));
    $('dbLatest').replaceChildren();
    for (const item of data.latest) {
      const row = node('div','', 'db-result');
      row.append(node('small',window.CCTVMode.origin(item.context)),node('b',window.CCTVMode.id('OBS',item.id) + ' · ' + (types[item.event_type] || item.event_type)),
        node('div',item.source_label + ' · ' + item.model),
        node('small',fmt(item.recorded_at) + ' · ' + review[item.status] + ' · ' + (states[item.run_state] || item.run_state)));
      $('dbLatest').append(row);
    }
    if (!data.total) $('dbLatest').append(node('p','ไม่มีผลตรวจจับในช่วงที่เลือก', 'db-empty'));
    $('navLogs').textContent = String(data.pending_total);
    $('dbMessage').textContent = data.total ? (window.CCTVMode.active ? 'แสดงผลจากข้อมูลสาธิต · ผลตรวจจับยังไม่ใช่การยืนยันว่าเกิดเหตุ' : 'แสดงผลจากประวัติที่บันทึกไว้ · โปรดตรวจสอบก่อนยืนยันเหตุ') :
      data.run_count ? 'มีรอบวิเคราะห์ในช่วงนี้ แต่ยังไม่มีผลตรวจจับที่บันทึกไว้' : 'ยังไม่มีข้อมูลในช่วงที่เลือก · วิเคราะห์ภาพหรือวิดีโอเพื่อเริ่มบันทึกผล';
    $('dbUpdated').textContent = (window.CCTVMode.active ? 'อัปเดตข้อมูลสาธิตล่าสุด: ' : 'อัปเดตประวัติล่าสุด: ') + fmt(data.generated_at) +
      ' (เวลาไทย) · สถานะรอบวิเคราะห์: ' +
      (Object.entries(data.run_states).map(([s,n]) => (states[s] || 'สถานะอื่น') + ' ' + n).join(', ') || 'ไม่มีรอบวิเคราะห์');
  }
  function live(data) {
    $('dbLive').replaceChildren();
    if (data.context) $('dbLive').append(node('p',window.CCTVMode.origin(data.context)));
    $('dbLiveState').textContent = states[data.status] || data.status;
    if (!data.session_id) {
      $('dbLive').append(node('p',window.CCTVMode.active ? 'ยังไม่ได้เริ่มสถานการณ์สาธิต' : 'ยังไม่มีการเริ่มตรวจจับแบบ Live'));
    } else {
      for (const text of ['รหัสรอบ: ' + data.session_id,
        'สถานะ: ' + (states[data.status] || data.status),
        'แหล่งภาพ: ' + (data.playback_mode === 'realtime' ? 'กล้อง RTSP' : 'ไฟล์วิดีโอ'),
        data.context ? 'เวลาสถานการณ์: '+data.elapsed_s+' วินาที · ใช้ผลตัวอย่างที่เตรียมไว้' : 'เฟรมที่รับเข้า ' + data.frames_received + ' · ประมวลผลแล้ว ' + data.frames_processed,
        data.context ? 'ความเร็วและเวลาประมวลผลไม่ได้วัดในสถานการณ์สาธิต · อุปกรณ์จากผลที่บันทึก: '+(data.device_used||'ไม่ได้วัด') : 'รุ่นโมเดล YOLO/X3D: ' + data.device_used + ' · YuNet: CPU']) $('dbLive').append(node('p',text));
      if (data.reason) $('dbLive').append(node('p','เหตุผล: ' + data.reason));
    }
    $('dbLiveMessage').textContent = (window.CCTVMode.active ? 'สถานะสถานการณ์สาธิต · ' : 'อัปเดตสถานะล่าสุด · ') + fmt(data.generated_at || new Date());
  }
  async function load({background = false} = {}) {
    const current = ++token;
    if (controller) controller.abort();
    controller = new AbortController();
    const active = controller, timeout = setTimeout(() => active.abort(), 10000);
    loading = true;
    if (!background) {
      clearHistory(); $('dbLive').replaceChildren(); $('dbLiveState').textContent = '—';
      $('dbMessage').textContent = window.CCTVMode.active
        ? 'กำลังโหลดข้อมูลสาธิต…' : 'กำลังโหลดประวัติผลตรวจจับ…';
      $('dbLiveMessage').textContent = 'กำลังโหลดสถานะการเฝ้าระวัง…';
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
        $('dbMessage').textContent = 'โหลดภาพรวมไม่ได้ · ' + results[0].reason.message + ' · ลองอัปเดตอีกครั้ง';
      }
      if (results[1].status === 'fulfilled') live(results[1].value);
      else {
        $('dbLive').replaceChildren(); $('dbLiveState').textContent = '—';
        $('dbLiveMessage').textContent = 'โหลดสถานะการเฝ้าระวังไม่ได้ · ' + results[1].reason.message;
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
    load();
  });
  document.addEventListener('cctv:datachange',() => { if (window.CCTVMode.active) load({background:true}); });
  load();
}());
