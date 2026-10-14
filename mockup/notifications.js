/* Durable in-page suspected-event notices. No browser Push/Notification permission. */
(function () {
  'use strict';
  const $ = id => document.getElementById(id);
  const names = {fall:'สงสัยว่ามีคนล้ม', fire:'ตรวจพบไฟ', smoke:'ตรวจพบควัน',
    no_helmet:'ไม่พบหมวกนิรภัย (กฎ PPE)', no_vest:'ไม่พบเสื้อสะท้อนแสง (กฎ PPE)',
    fight:'สงสัยการทะเลาะ (X3D)', review_fall_fight_conflict:'ผลการล้มและการทะเลาะยังไม่ชัดเจน'};
  const fmt = value => new Date(value).toLocaleString('th-TH', {timeZone:'Asia/Bangkok'});
  const review = {new:'รอตรวจสอบ', ack:'รับทราบแล้ว', closed:'ปิดรายการ'};
  const node = (tag, text, cls) => {
    const el = document.createElement(tag); el.textContent = text;
    if (cls) el.className = cls;
    return el;
  };
  let modeToken = 0;
  let cursor = null, busy = false, refreshRequested = false, recover = false, toastItem, toastTimer, renderKey = '';
  const items = new Map();
  function openHistory(item) {
    $('ntPanel').hidden = true; $('ntToggle').setAttribute('aria-expanded','false');
    $('ntToast').hidden = true;
    window.go('logs');
    document.dispatchEvent(new CustomEvent('cctv:open-observation',{detail:{id:item.observation_id}}));
  }
  function render() {
    const latest = [...items.values()].sort((a,b) => b.id-a.id).slice(0,20);
    const key = JSON.stringify(latest);
    if (key === renderKey) return; // Polling unchanged data must preserve keyboard focus.
    renderKey = key;
    $('ntList').replaceChildren();
    items.clear();
    for (const item of latest) {
      items.set(item.id,item);
      const row = node('div','', 'nt-item');
      row.append(node('small',window.CCTVMode.origin(item.context)),node('b',window.CCTVMode.id('NT',item.id)+' · '+(names[item.event_type] || item.event_type)),
        node('p',item.source_label + ' · ' + item.model),
        node('small',fmt(item.created_at)+' · คะแนนขณะเข้าเกณฑ์ '+item.score.toFixed(4)),
        node('small','สถานะรายการล่าสุด: '+review[item.status]));
      const button = node('button','ดูผลตรวจจับ '+window.CCTVMode.id('OBS',item.observation_id),'btn');
      button.type = 'button'; button.addEventListener('click',() => openHistory(item));
      row.append(button); $('ntList').append(row);
    }
    if (!latest.length) $('ntList').append(node('p','ยังไม่มีการแจ้งเตือน','nt-empty'));
  }
  function toast(item, count) {
    toastItem = item;
    clearTimeout(toastTimer);
    $('ntToastText').textContent = (item.context ? 'โหมดสาธิต · '+(item.context.kind==='captured'?'ใช้ผลเดิมจากภาพนิ่ง ไม่ได้ประมวลผลซ้ำ':'สถานการณ์สมมติ')+' · ' : '') + (names[item.event_type] || item.event_type) + ' · ' + item.source_label +
      ' · รอตรวจสอบ' + (count > 1 ? ' · มีการแจ้งเตือนใหม่ '+count+' รายการ' : '');
    $('ntToast').hidden = false;
    toastTimer = setTimeout(() => { $('ntToast').hidden = true; },12000);
  }
  async function load(snapshot = false) {
    const token = modeToken;
    if (busy) { refreshRequested ||= snapshot; return; }
    busy = true;
    const controller = new AbortController(), timeout = setTimeout(() => controller.abort(),8000);
    let more = false;
    try {
      const initial = cursor === null, previous = cursor;
      const response = await window.CCTVMode.fetch('/api/notifications' +
        (initial || snapshot || recover ? '' : '?after_id='+cursor+'&limit=50'), {signal:controller.signal});
      const data = await response.json();
      if (token !== modeToken) return;
      if (!response.ok) throw new Error(data.error?.message || 'อ่านรายการแจ้งไม่สำเร็จ');
      const fresh = initial || data.reset ? [] : data.items.filter(x => x.id > previous && x.status === 'new');
      if (initial || snapshot || recover || data.reset) items.clear();
      for (const item of data.items) items.set(item.id,item);
      cursor = data.cursor; more = data.has_more; recover = false;
      render();
      $('ntCount').textContent = String(data.total);
      $('ntMessage').textContent = 'มีการแจ้งเตือนทั้งหมด '+data.total+' รายการ · แสดง 20 รายการล่าสุด · เวลาไทย';
      $('ntRule').textContent = 'เว้นการแจ้งซ้ำสำหรับรายการเดิม '+data.cooldown_s+' วินาที · เปลี่ยนสถานะรายการได้ในประวัติผลตรวจจับ';
      if (fresh.length) toast(fresh.reduce((a,b) => a.id>b.id ? a : b),fresh.length);
    } catch (err) {
      if (token !== modeToken) return;
      recover = true;
      $('ntCount').textContent = '—';
      $('ntMessage').textContent = 'โหลดการแจ้งเตือนไม่ได้ · '+err.message+' · รายการด้านล่างเป็นข้อมูลล่าสุดที่อ่านได้';
    } finally {
      clearTimeout(timeout); busy = false;
      if (more || refreshRequested) {
        const snapshotNext = refreshRequested; refreshRequested = false;
        setTimeout(() => load(snapshotNext),0);
      }
    }
  }
  function close() {
    $('ntPanel').hidden = true; $('ntToggle').setAttribute('aria-expanded','false'); $('ntToggle').focus();
  }
  $('ntToggle').addEventListener('click',() => {
    const open = $('ntPanel').hidden;
    $('ntPanel').hidden = !open; $('ntToggle').setAttribute('aria-expanded',String(open));
    if (open) { load(true); $('ntClose').focus(); }
  });
  $('ntClose').addEventListener('click',close);
  $('ntRefresh').addEventListener('click',() => load(true));
  $('ntToastClose').addEventListener('click',() => { $('ntToast').hidden = true; });
  $('ntToastOpen').addEventListener('click',() => { if (toastItem) openHistory(toastItem); });
  document.addEventListener('keydown',ev => { if (ev.key === 'Escape' && !$('ntPanel').hidden) close(); });
  setInterval(() => { if (!document.hidden) load(!$('ntPanel').hidden); },2000);
  document.addEventListener('cctv:modechange',ev => { ++modeToken; clearTimeout(toastTimer); items.clear(); cursor=null; renderKey=''; refreshRequested=false; load(true); });
  document.addEventListener('cctv:datachange',() => { if (window.CCTVMode.active) load(); });
  load();
}());
