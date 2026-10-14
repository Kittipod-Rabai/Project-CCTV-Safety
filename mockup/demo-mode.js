/* Explicit presentation mode. Never patches global fetch or writes demo data to the API. */
(function () {
  'use strict';
  const $ = id => document.getElementById(id);
  let active = false, switching = false, epoch = 0, writes = 0, live = false, timer;
  const pending = new Set(), locks = new Set();
  const toggle = document.createElement('button');
  toggle.id = 'modeToggle'; toggle.className = 'btn'; toggle.type = 'button';
  toggle.setAttribute('aria-pressed', 'false');
  $('ntToggle').before(toggle);
  const banner = document.createElement('div');
  banner.id = 'modeBanner'; banner.setAttribute('role', 'status'); banner.setAttribute('aria-live', 'polite');
  document.querySelector('.topbar').after(banner);
  const view = document.createElement('section');
  view.id = 'demoView'; view.className = 'view'; view.setAttribute('aria-label', 'หน้าสาธิต ข้อมูลจำลอง');
  document.querySelector('main').append(view);
  const monitor = document.querySelector('.live-demo');
  monitor.remove();
  const originalGo = window.go;
  let rows = [], settings = {}, revision = 0, page = 1, query = '', filter = '', type = '', source = '', period = 'all', analysis = null, sample = 'image';
  const labels = {fire:'สงสัยไฟ', smoke:'สงสัยควัน', fall:'สงสัยการล้ม', fight:'สงสัย Fight', no_helmet:'ไม่พบหมวก · กฎ PPE', no_vest:'ไม่พบเสื้อกั๊ก · กฎ PPE'};
  const states = {new:'รอตรวจสอบ', ack:'รับทราบแล้ว', closed:'ปิดรายการ'};
  const fields = [
    ['person','ความมั่นใจ person',.25,.01,.99], ['helmet','ความมั่นใจ helmet',.2,.01,.99],
    ['vest','ความมั่นใจ vest',.2,.01,.99], ['fall','ความมั่นใจ fall',.2,.01,.99],
    ['fire','ความมั่นใจ fire',.2,.01,.99], ['smoke','ความมั่นใจ smoke',.2,.01,.99],
    ['iou','YOLO NMS IoU',.7,.1,.95], ['imgsz','ขนาดภาพเข้า YOLO',640],
    ['max_det','กล่องสูงสุดต่อเฟรม',300,1,1000], ['fight_threshold','เกณฑ์ Fight ของ X3D-S',.5,.05,.95],
    ['proximity','ระยะใกล้ของคน',.16,.01,.5], ['motion','ความเร็วคน',.25,.01,2], ['gap','ช่วงขาด track (วินาที)',.75,.1,3]
  ];
  const defaults = () => Object.fromEntries(fields.map(([key,,value]) => [key,value]));
  function reset() {
    rows = Array.from({length:24}, (_,i) => ({id:'DEMO-'+String(i+1).padStart(3,'0'), type:Object.keys(labels)[i%6],
      status:i%4 === 0 ? 'ack' : i%4 === 1 ? 'closed' : 'new', source:'DEMO-CAM-'+(i%3+1),
      score:(.78+(i%6)*.03).toFixed(2), time:Date.now()-i*3600000, history:[]}));
    settings = defaults(); revision = 0; page = 1; query = filter = type = source = ''; period = 'all'; analysis = null; sample = 'image'; live = false;
    monitor.querySelector('#feed').replaceChildren();
  }
  function sync() {
    toggle.disabled = switching || writes > 0 || locks.size > 0;
    toggle.textContent = active ? 'กลับโหมดจริง' : 'เข้าโหมดสาธิต';
    toggle.setAttribute('aria-pressed', String(active));
    toggle.title = toggle.disabled ? 'รอการวิเคราะห์หรือบันทึกจริงให้เสร็จก่อนสลับโหมด' : '';
    if (active) banner.textContent = 'โหมดสาธิต · ข้อมูลจำลอง ไม่ใช่ผลจากโมเดล · การเปลี่ยนแปลงไม่ถูกบันทึกลงฐานข้อมูล';
    else if (writes || locks.size) banner.textContent = 'กำลังทำงานจริง · รอให้เสร็จก่อนสลับโหมด';
  }
  async function realFetch(url, options = {}) {
    if (active || switching) throw new DOMException('Real API paused in demo mode', 'AbortError');
    const generation = epoch, controller = new AbortController();
    const abort = () => controller.abort();
    options.signal?.addEventListener('abort', abort, {once:true});
    if (options.signal?.aborted) controller.abort();
    pending.add(controller);
    const write = !['GET','HEAD','OPTIONS'].includes((options.method || 'GET').toUpperCase());
    if (write) { ++writes; sync(); }
    const finish = () => {
      pending.delete(controller); options.signal?.removeEventListener('abort',abort);
      if (write) { --writes; sync(); }
    };
    try {
      const response = await fetch(url, {...options,signal:controller.signal});
      // Consume the body under the mode epoch, so stale reads never render in another mode.
      const body = await response.text();
      if (generation !== epoch || active) throw new DOMException('Mode changed', 'AbortError');
      return new Response([204,205,304].includes(response.status) ? null : body, {status:response.status,statusText:response.statusText,headers:response.headers});
    } finally { finish(); }
  }
  window.CCTVMode = {
    get active() { return active; },
    get demoLive() { return active && live && document.body.dataset.page === 'live' && !document.hidden; },
    fetch:realFetch,
    lock(name, locked) { if (locked) locks.add(name); else locks.delete(name); sync(); }
  };
  function node(tag, text, cls) { const n = document.createElement(tag); if (text != null) n.textContent = text; if (cls) n.className = cls; return n; }
  function button(text, fn) { const b = node('button',text,'btn'); b.type = 'button'; b.addEventListener('click',fn); return b; }
  function card(title) { const c = node('section',null,'card demo-card'); c.append(node('h3',title)); view.append(c); return c; }
  const fmt = time => new Date(time).toLocaleString('th-TH',{timeZone:'Asia/Bangkok'});
  function chart(container, entries) {
    const max = Math.max(1,...entries.map(x=>x[1]));
    for (const [name,value] of entries) {
      const row = node('div',null,'db-bar'), meter = document.createElement('meter');
      meter.min = 0; meter.max = max; meter.value = value; meter.setAttribute('aria-label',name+': '+value);
      row.append(node('span',name),meter,node('b',String(value))); container.append(row);
    }
  }
  function go(target) { originalGo(target); if (active) { render(); view.scrollTop = 0; } }
  window.go = go;
  document.addEventListener('click', event => {
    const link = event.target.closest('[data-go]');
    if (active && link) { event.preventDefault(); event.stopImmediatePropagation(); go(link.dataset.go); }
  },true);
  function detail(row) {
    const dialog = document.createElement('dialog'); dialog.className = 'demo-dialog';
    dialog.append(node('h3',row.id+' · ข้อมูลจำลอง'),node('p',labels[row.type]+' · '+row.source+' · คะแนน '+row.score),node('p',fmt(row.time)));
    const status = node('p','สถานะ: '+states[row.status]), audit = node('p',row.history.join(' / ') || 'ยังไม่มีการเปลี่ยนสถานะตัวอย่าง');
    dialog.append(status,audit);
    for (const [key,label] of Object.entries(states)) dialog.append(button(label,() => {
      if (row.status === key) return;
      row.history.push(states[row.status]+' → '+label); row.status = key;
      status.textContent = 'สถานะ: '+label; audit.textContent = row.history.join(' / ');
      render();
    }));
    dialog.append(button('ปิด',()=>dialog.close()));
    dialog.addEventListener('close',()=>dialog.remove()); document.body.append(dialog); dialog.showModal();
  }
  function table(container, items) {
    const wrap = node('div',null,'demo-table-wrap'), t = node('table');
    const head = node('tr'); for (const h of ['รหัสตัวอย่าง','แหล่งภาพ','ผลตัวอย่าง','คะแนน','สถานะ','รายละเอียด']) head.append(node('th',h));
    const thead = node('thead'); thead.append(head); t.append(thead);
    const body = node('tbody');
    for (const row of items) { const tr = node('tr'); for (const text of [row.id,row.source,labels[row.type],row.score,states[row.status]]) tr.append(node('td',text)); const cell = node('td'); cell.append(button('เปิด',()=>detail(row))); tr.append(cell); body.append(tr); }
    t.append(body); wrap.append(t); container.append(wrap); if (!items.length) container.append(node('p','ไม่มีรายการตัวอย่างตรงกับตัวกรอง'));
  }
  function selectedRows() {
    const today = new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Bangkok'}).format(new Date());
    return rows.filter(r => (!filter || r.status === filter) && (!type || r.type === type) && (!source || r.source === source) &&
      (!query || (r.id+' '+r.source+' '+labels[r.type]).toLowerCase().includes(query.toLowerCase())) &&
      (period !== 'today' || new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Bangkok'}).format(r.time) === today));
  }
  function render() {
    if (!active) return;
    document.body.dataset.demoPlaying = String(live && document.body.dataset.page === 'live');
    view.replaceChildren(); view.classList.add('on');
    const target = document.body.dataset.page;
    $('pgSub').textContent = 'โหมดสาธิต · ข้อมูลตัวอย่าง ไม่ใช่ผลจากโมเดล';
    if (target === 'dashboard') {
      const c = card('ภาพรวมข้อมูลจำลอง');
      c.append(node('p',`ทั้งหมด ${rows.length} รายการ · รอตรวจสอบ ${rows.filter(r=>r.status==='new').length} · รับทราบ ${rows.filter(r=>r.status==='ack').length} · ปิดรายการ ${rows.filter(r=>r.status==='closed').length}`));
      chart(card('ประเภทผลตัวอย่าง'),Object.entries(labels).map(([key,label])=>[label,rows.filter(r=>r.type===key).length]));
      const daily = new Map(); for (const row of rows) { const key = new Date(row.time).toLocaleDateString('th-TH',{timeZone:'Asia/Bangkok'}); daily.set(key,(daily.get(key)||0)+1); }
      chart(card('จำนวนรายการตัวอย่างรายวัน'),[...daily]);
      const l = card('สถานะ Live จำลอง'); l.append(node('p',live ? 'กำลังสาธิต · จอมอนิเตอร์ตัวอย่าง' : 'ยังไม่เริ่มสาธิต'),button('เปิด Live สาธิต',()=>go('live')));
      table(card('ผลตัวอย่างล่าสุด'),rows.slice(0,5));
    } else if (target === 'logs') {
      const c = card('ประวัติข้อมูลจำลอง'), controls = node('div',null,'demo-actions');
      const search = node('input'); search.placeholder = 'ค้นหารหัส / แหล่งภาพ / ประเภทผล'; search.setAttribute('aria-label','ค้นหาประวัติจำลอง'); search.value = query;
      // Preserve focus and caret while the filtered table is refreshed.
      search.addEventListener('input',()=>{ const pos=search.selectionStart; query=search.value; page=1; render(); const next=$('demoSearch'); next.focus(); next.setSelectionRange(pos,pos); }); search.id='demoSearch'; controls.append(search);
      for (const [title,value,options,set] of [
        ['สถานะ',filter,[['','ทุกสถานะ'],...Object.entries(states)],v=>filter=v],
        ['ประเภทผล',type,[['','ทุกประเภท'],...Object.entries(labels)],v=>type=v],
        ['แหล่งภาพ',source,[['','ทุกแหล่ง'],...['1','2','3'].map(i=>['DEMO-CAM-'+i,'DEMO-CAM-'+i])],v=>source=v],
        ['ช่วงเวลา',period,[['all','ทั้งหมด'],['today','วันนี้ (Bangkok)']],v=>period=v]
      ]) { const select=node('select'); select.setAttribute('aria-label',title+'จำลอง'); for (const [key,label] of options) { const option=node('option',label); option.value=key; select.append(option); } select.value=value; select.addEventListener('change',()=>{set(select.value);page=1;render();}); controls.append(select); }
      controls.append(button('ล้างตัวกรอง',()=>{query=filter=type=source='';period='all';page=1;render();})); c.append(controls);
      const list=selectedRows(), pages=Math.max(1,Math.ceil(list.length/8)); page=Math.min(page,pages);
      table(c,list.slice((page-1)*8,page*8));
      const prev=button('ก่อนหน้า',()=>{--page;render();}), next=button('ถัดไป',()=>{++page;render();}); prev.disabled=page===1;next.disabled=page===pages;
      c.append(prev,node('span',` หน้า ${page}/${pages} · ${list.length} รายการ `),next);
    } else if (target === 'live') {
      const c=card('Live สาธิต · ไม่เปิดกล้อง ไม่เรียกโมเดล');
      c.append(node('p',live?'กำลังเล่นตัวอย่าง':'หยุดการสาธิต'),button(live?'หยุดการสาธิต':'เริ่มการสาธิต',()=>{live=!live;render();}));
      view.append(monitor); monitor.hidden=false;
      if (live) { window.jitter(); }
    } else if (target === 'analyze') {
      const c=card('Upload & Analyze สาธิต');
      c.append(node('p','เลือกตัวอย่างในเว็บ · ไม่รับไฟล์ส่วนตัวและไม่ส่งไปประมวลผลจริง'));
      const select=node('select'); select.setAttribute('aria-label','เลือกตัวอย่างวิเคราะห์');
      for (const [key,label] of [['image','ภาพตัวอย่าง · PPE'],['video','วิดีโอตัวอย่าง · Fall / Fight']]) {const option=node('option',label);option.value=key;select.append(option);} select.value=sample;
      select.addEventListener('change',()=>{sample=select.value;analysis=null;render();});
      c.append(select,button('แสดงผลวิเคราะห์จำลอง',()=>{analysis={sample,revision,threshold:settings.fight_threshold};render();}));
      if (analysis) {
        c.append(node('p','ผลจำลอง · Settings สาธิต revision '+analysis.revision+' · ไม่ใช่ผลจากโมเดล'));
        const canvas=document.createElement('canvas');canvas.width=640;canvas.height=360;canvas.className='demo-preview';canvas.setAttribute('role','img');canvas.setAttribute('aria-label','ภาพฉากตัวอย่างวาดขึ้น พร้อมกรอบ person และผลจำลอง');
        const ctx=canvas.getContext('2d');ctx.fillStyle='#152635';ctx.fillRect(0,0,640,360);ctx.fillStyle='#29404e';ctx.fillRect(0,270,640,90);
        ctx.fillStyle='#7394a4';ctx.beginPath();ctx.arc(300,100,23,0,Math.PI*2);ctx.fill();ctx.fillRect(278,125,44,100);ctx.fillRect(278,225,15,70);ctx.fillRect(307,225,15,70);
        ctx.strokeStyle='#22d3ee';ctx.lineWidth=3;ctx.strokeRect(260,65,80,240);ctx.fillStyle='#fff';ctx.font='18px sans-serif';ctx.fillText('DEMO · person 0.94',260,50);ctx.fillText('SIMULATED RESULT',20,340);c.append(canvas);
        c.append(node('p',analysis.sample==='image'?'Stage 1 จำลอง: person 0.94 · ไม่พบหมวกตามกฎ PPE · Stage 2 ไม่ใช้กับภาพนิ่ง':`Stage 1 จำลอง: Fall 0.88 · Stage 2 จำลอง: Fight 0.84 · เกณฑ์สาธิต ${analysis.threshold} · ${.84>=analysis.threshold?'สงสัย Fight':'ต่ำกว่าเกณฑ์ Fight'}`));
        c.append(node('p','กรอบและคะแนนเป็นตัวอย่างที่กำหนดไว้ ไม่ใช่การวัดประสิทธิภาพ'));
      }
    } else if (target === 'settings') {
      const c=card('Settings สาธิต · เก็บเฉพาะหน่วยความจำ'), form=node('form'), grid=node('div',null,'st-grid');
      c.append(node('p','revision '+revision+' · ไม่กระทบค่าระบบจริง · ออกจากโหมดแล้วข้อมูลนี้จะถูกล้าง'));
      for (const [key,label,,min,max] of fields) {
        const wrap=node('div',null,'st-field'), name=node('label',label), input=node(key==='imgsz'?'select':'input');
        input.name=key;input.id='demo-setting-'+key;name.htmlFor=input.id;input.required=true;
        if(key==='imgsz') for(const size of [320,480,640,800,960,1280]) {const option=node('option',String(size));option.value=size;input.append(option);}
        else {input.type='number';input.min=min;input.max=max;input.step=key==='max_det'?'1':'any';} input.value=settings[key];wrap.append(name,input);grid.append(wrap);
      }
      const save=node('button','บันทึกค่าจำลอง','btn primary');save.type='submit';
      const message=node('p','', 'demo-message');message.setAttribute('role','status');
      form.append(grid,save,button('ใส่ค่าเริ่มต้นในฟอร์ม',()=>{for(const [key,value] of Object.entries(defaults()))form.elements.namedItem(key).value=value;message.textContent='ใส่ค่าเริ่มต้นแล้ว ยังไม่บันทึก';}),message);
      form.addEventListener('submit',ev=>{ev.preventDefault();if(!form.reportValidity())return;settings=Object.fromEntries(fields.map(([key])=>[key,Number(form.elements.namedItem(key).value)]));++revision;render();view.querySelector('.demo-message').textContent='บันทึกค่าจำลองแล้ว revision '+revision+' · ไม่ได้บันทึกลง backend';});c.append(form);
    }
    const n=card('เหตุสงสัยตัวอย่าง · ข้อมูลจำลอง');
    const unresolved=rows.filter(r=>r.status==='new');n.append(node('p',`รอตรวจสอบ ${unresolved.length} รายการตัวอย่าง`));
    for(const row of unresolved.slice(0,3)) n.append(button(row.id+' · '+labels[row.type],()=>detail(row)));
  }
  toggle.addEventListener('click',async()=>{
    if (switching || writes || locks.size) return;
    switching=true;sync();
    try {
      if (!active) {
        const controller=new AbortController(), timeout=setTimeout(()=>controller.abort(),8000);
        let response, data;
        try {response=await fetch('/api/live/status',{signal:controller.signal,cache:'no-store'});data=await response.json();} finally {clearTimeout(timeout);}
        if(!response.ok || !['idle','starting','running','degraded','stopping','stopped','error','interrupted','completed'].includes(data.status)) throw new Error('ตรวจสถานะ Live ไม่สำเร็จ');
        if(['starting','running','degraded','stopping'].includes(data.status)) throw new Error('กรุณาหยุด Live จริงและรอให้จบก่อนเข้าโหมดสาธิต');
        if(writes || locks.size) throw new Error('รอการทำงานจริงให้เสร็จก่อน');
        reset();
      }
      ++epoch; for(const controller of pending)controller.abort();
      active=!active;document.body.dataset.mode=active?'demo':'real';
      for(const dialog of document.querySelectorAll('.demo-dialog'))dialog.close();
      for(const id of ['mask','rlMask'])$(id)?.classList.remove('on');
      $('ntPanel').hidden=true;$('ntToast').hidden=true;$('ntToggle').setAttribute('aria-expanded','false');
      document.querySelectorAll('#v-analyze video').forEach(video=>video.pause());
      clearInterval(timer); live=false;
      // Allow controller reloads after the switch, and keep failures in their own real views.
      switching=false;
      document.dispatchEvent(new CustomEvent('cctv:modechange',{detail:{demo:active}}));
      go(document.body.dataset.page || 'dashboard');
      if(active)timer=setInterval(()=>{if(window.CCTVMode.demoLive){window.jitter();window.pushFeed();}},1800);
      else {view.replaceChildren();view.classList.remove('on');banner.textContent='โหมดจริง · อ่านข้อมูลจาก backend';reset();}
    } catch(error) {banner.textContent=error.name==='AbortError'?'ตรวจสถานะ Live ไม่ได้ · ลองอีกครั้ง':error.message;}
    finally {switching=false;sync();toggle.focus();}
  });
  document.body.dataset.mode='real';banner.textContent='โหมดจริง · อ่านข้อมูลจาก backend';sync();
}());
