/* Mode lifecycle and explicit providers; never replaces global fetch. */
(function () {
  'use strict';
  const $=id=>document.getElementById(id);
  let active=false,switching=false,epoch=0,writes=0,provider=null,loadToken=0;
  const pending=new Set(),locks=new Set();
  const toggle=document.createElement('button');toggle.id='modeToggle';toggle.type='button';toggle.className='btn';toggle.setAttribute('aria-pressed','false');$('ntToggle').before(toggle);
  const banner=document.createElement('div');banner.id='modeBanner';banner.setAttribute('role','status');banner.setAttribute('aria-live','polite');document.querySelector('.topbar').after(banner);
  document.querySelector('.live-demo')?.remove();
  const toolbar=document.createElement('div');toolbar.id='demoToolbar';toolbar.hidden=true;
  const scenario=document.createElement('select');scenario.id='demoScenario';scenario.setAttribute('aria-label','สถานการณ์สาธิต');
  for(const item of window.CCTVDemo.SCENARIOS){const option=document.createElement('option');option.value=item.id;option.textContent=item.label;scenario.append(option);}
  scenario.value='captured-smoke';
  const buttons={};for(const [key,label] of [['pause','พักสถานการณ์'],['next','เหตุการณ์ถัดไป'],['reset','เริ่มสาธิตใหม่']]){const button=document.createElement('button');button.id='demo-'+key;button.type='button';button.className='btn';button.textContent=label;buttons[key]=button;}
  const elapsed=document.createElement('span');elapsed.id='demoElapsed';elapsed.setAttribute('role','status');
  const guide=document.createElement('p');guide.id='demoGuide';guide.textContent='AEGIVIS ผู้พัฒนา · โรงงาน/คลังสินค้าสมมติ · เลือกสถานการณ์แล้วกดเริ่ม Live หรือวิเคราะห์ · เรื่องหลัก 90 วินาที · สื่อจริง: เล่นซ้ำจากภาพนิ่ง';
  toolbar.append(scenario,...Object.values(buttons),elapsed,guide);banner.after(toolbar);
  const texts=new Map(),realChoices=new Map();
  const copy={dbTitle:'ภาพรวมผลวิเคราะห์สาธิต',dbUpdated:'ข้อมูลสาธิตในหน่วยความจำ',stTitle:'ค่าตั้งต้นการวิเคราะห์สาธิต',livePilotTitle:'สาธิตแหล่งภาพหนึ่งรายการ',liveRuntimeStatus:'โหมดสาธิต · ไม่ได้รันโมเดลหรือเปิดกล้อง',liveSourceHelp:'ใช้สถานการณ์ที่เลือกบนแถบสาธิต · ไม่มีการอัปโหลดไฟล์ส่วนตัว'};
  function contextualCopy(){
    for(const id of ['azDevice','liveDevice','azModel','liveModel']){
      const input=$(id);if(!input)continue;
      if(active){if(!realChoices.has(id))realChoices.set(id,input.value);
        if(id.endsWith('Device')){if(!input.querySelector('option[value="demo"]')){const option=document.createElement('option');option.value='demo';option.textContent='ไม่ได้รันโมเดล';input.append(option);}input.value='demo';}
        else input.value='yolov8n';
      }else if(realChoices.has(id)){input.querySelector('option[value="demo"]')?.remove();input.value=realChoices.get(id);realChoices.delete(id);}
    }

    for(const [id,text] of Object.entries(copy)){const node=$(id);if(!node)continue;if(!texts.has(node))texts.set(node,node.textContent);node.textContent=active?text:texts.get(node);}
    for(const node of document.querySelectorAll('[data-demo-copy]')){if(!texts.has(node))texts.set(node,node.textContent);node.textContent=active?node.dataset.demoCopy:texts.get(node);}
  }
  function sync(){
    toggle.disabled=switching||writes>0||locks.size>0;toggle.textContent=active?'กลับโหมดจริง':'เข้าโหมดสาธิต';toggle.setAttribute('aria-pressed',String(active));toggle.title=toggle.disabled?'รอการวิเคราะห์หรือบันทึกให้จบก่อนสลับโหมด':'';toolbar.hidden=!active;
    if(active){const status=provider.status();elapsed.textContent=`เวลาสถานการณ์ ${Number(status.elapsed_s||0).toFixed(1)}/90 s · ${document.hidden?'พักเพราะซ่อนแท็บ':status.paused?'พัก':'เล่น'} · ไม่ใช่เวลา inference`;
      buttons.pause.textContent=provider.paused?'เล่นต่อ':'พักสถานการณ์';buttons.pause.disabled=buttons.next.disabled=status.status!=='running';buttons.reset.disabled=locks.size>0;scenario.disabled=status.status==='running'||locks.size>0;}
  }
  class RealProvider {
    async request(url,options={}) {
      if(active||switching)throw new DOMException('Real API paused','AbortError');
      const generation=epoch,controller=new AbortController(),abort=()=>controller.abort();pending.add(controller);
      options.signal?.addEventListener('abort',abort,{once:true});if(options.signal?.aborted)abort();
      const write=!['GET','HEAD','OPTIONS'].includes((options.method||'GET').toUpperCase());if(write){writes++;sync();}
      try {const response=await fetch(url,{...options,signal:controller.signal});const body=await response.text();if(generation!==epoch||active)throw new DOMException('Mode changed','AbortError');return new Response([204,205,304].includes(response.status)?null:body,{status:response.status,statusText:response.statusText,headers:response.headers});}
      finally{pending.delete(controller);options.signal?.removeEventListener('abort',abort);if(write){writes--;sync();}}
    }
  }
  const real=new RealProvider();
  async function checkedFile(file,signal){
    if(!/^demo-assets\/[a-z0-9-]+\.(json|jpg)$/.test(file.path))throw Error('เส้นทางสื่อเดโมไม่ถูกต้อง');
    const response=await fetch(file.path,{signal,cache:'no-store'});if(!response.ok)throw Error('ไม่พบชุดสื่อในเครื่อง · รัน scripts/prepare_demo_assets.py');
    const bytes=await response.arrayBuffer(),hash=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes)),b=>b.toString(16).padStart(2,'0')).join('');
    if(hash!==file.sha256)throw Error('Checksum สื่อเดโมไม่ตรงกับ manifest');return bytes;
  }
  async function loadCapture(){
    const controller=new AbortController(),token=loadToken;pending.add(controller);const timeout=setTimeout(()=>controller.abort(),10000);
    try{
      const response=await fetch('demo-manifest.json',{signal:controller.signal,cache:'no-store'});if(!response.ok)throw Error('ไม่พบ manifest สื่อเดโม');const manifest=await response.json();
      if(manifest.approved_preview!==true||manifest.sample_id!=='captured-smoke'||manifest.media_kind!=='still-image-replay')throw Error('สื่อยังไม่ผ่านการตรวจ preview');
      const [payload,image]=await Promise.all([checkedFile(manifest.payload,controller.signal),checkedFile(manifest.preview,controller.signal)]);
      const captured=JSON.parse(new TextDecoder().decode(payload)),r=captured.result;
      if(r?.is_model_output!==true||r?.model!=='yolov8n'||r.model!==manifest.model||r?.source?.width!==640||r?.source?.height!==360||!Array.isArray(r?.frames)||r.frames.length!==1||!Array.isArray(r.frames[0].detections)||r.frames[0].detections.length!==2||r.frames[0].detections.map(d=>d.class_name).sort().join(',')!=='fire,smoke'||r.frames[0].detections.some(d=>!['smoke','fire'].includes(d.class_name)||d.confidence!==({smoke:.8779,fire:.3589}[d.class_name])||d.xyxy?.length!==4||!d.xyxy.every(Number.isFinite))||new Uint8Array(image)[0]!==255||new Uint8Array(image)[1]!==216)throw Error('ผลบันทึกไม่ครบหรือไม่ตรง manifest');
      if(token!==loadToken)throw new DOMException('Mode changed','AbortError');let binary='';for(const b of new Uint8Array(image))binary+=String.fromCharCode(b);
      return {...captured,...manifest,preview:btoa(binary)};
    }finally{clearTimeout(timeout);pending.delete(controller);}
  }
  function drawPreview(sample){
    const canvas=document.createElement('canvas');canvas.width=640;canvas.height=360;const ctx=canvas.getContext('2d');ctx.fillStyle='#183141';ctx.fillRect(0,0,640,360);ctx.fillStyle='#38515e';ctx.fillRect(0,280,640,80);
    const names=(sample.detections||[]).map(d=>d[0]);
    if(names.includes('smoke')){ctx.fillStyle='#a6adb955';for(let i=0;i<6;i++){ctx.beginPath();ctx.arc(120+i*70,120+(i%2)*65,90,0,Math.PI*2);ctx.fill();}}
    if(names.includes('fire')){ctx.fillStyle='#fb923c';ctx.beginPath();ctx.moveTo(235,260);ctx.lineTo(250,230);ctx.lineTo(265,260);ctx.fill();}
    let person=0;for(const name of names)if(name==='person'){
      ctx.save();if(['fall','conflict'].includes(sample.id)){ctx.translate(230,285);ctx.rotate(-Math.PI/2);ctx.translate(-260,-50);}
      const x=300+person++*140;ctx.fillStyle='#9bb8c5';ctx.beginPath();ctx.arc(x,75,20,0,Math.PI*2);ctx.fill();ctx.fillRect(x-20,95,40,110);ctx.fillRect(x-20,200,15,100);ctx.fillRect(x+5,200,15,100);ctx.restore();
    }
    if(names.includes('helmet')){ctx.fillStyle='#facc15';ctx.fillRect(270,55,55,18);}
    if(names.includes('vest')){ctx.fillStyle='#84cc16';ctx.fillRect(280,110,40,70);}
    ctx.fillStyle='#fff';ctx.font='18px sans-serif';ctx.fillText('SYNTHETIC SCENE · '+sample.id,20,335);
    return canvas.toDataURL('image/jpeg',.85).split(',')[1];
  }
  function newProvider(){return new window.CCTVDemo.DemoProvider({loadCapture,preview:drawPreview});}
  function notify(){sync();document.dispatchEvent(new CustomEvent('cctv:datachange'));}
  async function request(url,options={}){
    if(!active)return real.request(url,options);const generation=epoch;let data,status=200;
    try{data=await provider.request(url,options);}catch(error){data={error:{code:error.code||'demo_error',message:error.message}};status=error.code==='settings_conflict'?409:error.code==='not_found'?404:400;}
    if(generation!==epoch)throw new DOMException('Mode changed','AbortError');if(['PUT','PATCH'].includes(options.method))queueMicrotask(notify);
    return new Response(JSON.stringify(data),{status,headers:{'Content-Type':'application/json'}});
  }
  function origin(context){return context?.mode==='demo'?'โหมดสาธิต · '+context.note+(context.captured_at?' · รันเดิม '+context.captured_at:context.kind==='captured'?' · ไม่ได้บันทึกเวลารันเดิม':''):'';}
  function clearTransient(){for(const id of ['mask','rlMask'])$(id)?.classList.remove('on');$('ntPanel').hidden=true;$('ntToast').hidden=true;$('ntToggle').setAttribute('aria-expanded','false');document.querySelectorAll('#v-analyze video').forEach(v=>v.pause());}
  function change(){contextualCopy();$('pgSub').textContent=active?'โหมดสาธิต · หน้าจอเดียวกับระบบจริง · ผลบันทึก/สมมติในหน่วยความจำ':'ระบบต้นแบบ · แสดงผลจาก backend';clearTransient();document.dispatchEvent(new CustomEvent('cctv:modechange',{detail:{demo:active}}));sync();}
  window.CCTVMode={get active(){return active;},get demo(){return provider;},get scenario(){return scenario.value;},fetch:request,RealProvider,origin,id:(kind,id)=>(active?'DEMO-':'')+kind+'-'+id,
    lock(name,value){if(value)locks.add(name);else locks.delete(name);sync();},changed:notify,
    async analyze(overrides){const result=await provider.analyze(scenario.value,overrides);notify();return result;},async startLive(){const status=await provider.start(scenario.value);notify();return status;},
    stopLive(){const status=provider.stop();notify();return status;},subscribeLive(fn){return provider.subscribe(fn);}
  };
  buttons.pause.addEventListener('click',()=>{provider.paused=!provider.paused;notify();});buttons.next.addEventListener('click',()=>{provider.next();notify();});
  buttons.reset.addEventListener('click',()=>{if(locks.size)return;++epoch;++loadToken;provider.reset();change();notify();});
  scenario.addEventListener('change',()=>{guide.textContent='AEGIVIS ผู้พัฒนา · '+scenario.selectedOptions[0].textContent+' · เลือกเริ่ม Live หรือวิเคราะห์ · ไม่ได้ inference ใหม่';});
  toggle.addEventListener('click',async()=>{
    if(switching||writes||locks.size)return;switching=true;sync();
    try{
      if(!active){const controller=new AbortController(),timeout=setTimeout(()=>controller.abort(),8000);let response,data;
        try{response=await fetch('/api/live/status',{signal:controller.signal,cache:'no-store'});data=await response.json();}finally{clearTimeout(timeout);}
        if(!response.ok||!['idle','starting','running','degraded','stopping','stopped','completed','error','interrupted'].includes(data.status))throw Error('ตรวจสถานะ Live ไม่สำเร็จ');
        if(['starting','running','degraded','stopping'].includes(data.status))throw Error('กรุณาหยุด Live จริงให้จบก่อนเข้าโหมดสาธิต');if(writes||locks.size)throw Error('รอการทำงานจริงให้จบก่อน');}
      ++epoch;++loadToken;for(const controller of pending)controller.abort();provider?.stop();active=!active;provider=active?newProvider():null;document.body.dataset.mode=active?'demo':'real';switching=false;
      banner.textContent=active?'โหมดสาธิต · โรงงาน/คลังสินค้าสมมติ · AEGIVIS ผู้พัฒนา · ไม่เขียนฐานข้อมูลจริง':'โหมดจริง · อ่านข้อมูลจาก backend';change();
    }catch(error){banner.textContent=error.name==='AbortError'?'ตรวจสถานะ Live ไม่ได้ · ลองอีกครั้ง':error.message;}
    finally{switching=false;sync();toggle.focus();}
  });
  // No wall-clock catch-up when hidden; the scenario clock is independent from evidence time.
  setInterval(()=>{if(active&&!document.hidden){const previous=provider.nextIndex;provider.tick(.25);if(previous!==provider.nextIndex)notify();else sync();}},250);document.addEventListener('visibilitychange',sync);
  document.body.dataset.mode='real';banner.textContent='โหมดจริง · อ่านข้อมูลจาก backend';sync();
}());
