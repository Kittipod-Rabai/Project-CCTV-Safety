/* Run: node --test tests/test_demo_mode.cjs
 * Minimal DOM scaffold tests the real mode controller's network boundary.
 * Browser interaction/layout checks are recorded in demo-mode-verification.md.
 */
const {test} = require('node:test');
const assert = require('node:assert/strict');
const {readFileSync} = require('node:fs');
const vm = require('node:vm');
const source = readFileSync(require('node:path').join(__dirname,'../mockup/demo-mode.js'),'utf8');
function setup(fetch) {
  const nodes = new Map(), events = new Map(), timers=[];
  class Element {
    constructor(tag='div') { this.tagName=tag.toUpperCase(); this.children=[]; this.listeners={}; this.dataset={}; this.classList={add(){},remove(){}}; }
    set id(value) { this._id=value; nodes.set(value,this); }
    get id() { return this._id; }
    append(...items) { this.children.push(...items); }
    before() {} after() {} remove() {} focus() {}
    replaceChildren(...items) { this.children=items; }
    setAttribute(key,value) { this[key]=value; }
    addEventListener(name,fn) { (this.listeners[name] ||= []).push(fn); }
    querySelector(selector) { return nodes.get(selector.slice(1)); }
    getContext() { return {fillRect(){},beginPath(){},arc(){},fill(){},moveTo(){},lineTo(){},save(){},restore(){},translate(){},rotate(){},fillText(){}}; }
    toDataURL() { return 'data:image/jpeg;base64,c3ludGhldGlj'; }
  }
  for(const id of ['ntToggle','ntPanel','ntToast','pgSub','feed','mask','rlMask']) {const n=new Element(); n.id=id;}
  const body=new Element(); body.dataset.page='dashboard';
  const monitor=new Element(), main=new Element(), topbar=new Element();
  const document={body,hidden:false,createElement:tag=>new Element(tag),getElementById:id=>nodes.get(id),
    querySelector:selector=>selector==='.live-demo'?monitor:selector==='main'?main:topbar,
    querySelectorAll:()=>[],addEventListener:(name,fn)=>{(events.get(name)||events.set(name,[]).get(name)).push(fn);},
    dispatchEvent:ev=>{for(const fn of events.get(ev.type)||[])fn(ev);}};
  const window={CCTVDemo:require('../mockup/demo-provider.js'),go:target=>body.dataset.page=target};
  class CustomEvent {constructor(type,options){this.type=type;this.detail=options?.detail;}}
  vm.runInNewContext(source,{window,document,fetch,Response,DOMException,AbortController,CustomEvent,
    queueMicrotask,TextDecoder,btoa,crypto:require('node:crypto').webcrypto,setTimeout:()=>1,clearTimeout(){},setInterval:fn=>{timers.push(fn);return timers.length;},clearInterval(){},Intl,Date,Map,Set,console});
  return {mode:window.CCTVMode,toggle:nodes.get('modeToggle'),banner:nodes.get('modeBanner'),scenario:nodes.get('demoScenario'),body,
    document,timers,click:()=>nodes.get('modeToggle').listeners.click[0]()};
}
const json = data => new Response(JSON.stringify(data),{headers:{'Content-Type':'application/json'}});
for(const status of ['starting','running','degraded','stopping']) test('requires stopping real Live: '+status,async()=>{
  let calls=0;const app=setup(async()=>{++calls;return json({status});});
  await app.click();assert.equal(app.mode.active,false);assert.match(app.banner.textContent,/หยุด Live/);assert.equal(calls,1);
});
test('PPE missing is the default demo storyline',()=>{
  const app=setup(async()=>json({status:'idle'}));
  assert.equal(app.scenario.value,'ppe-missing');
});
test('unknown status and network failure keep real mode',async()=>{
  for(const fetch of [async()=>json({status:'unknown'}),async()=>{throw Error('offline');}]) {
    const app=setup(fetch);await app.click();assert.equal(app.mode.active,false);assert.ok(app.banner.textContent);
  }
});
test('demo reads and writes use local store and never backend',async()=>{
  const calls=[];const app=setup(async(url,options)=>{calls.push([url,options?.method||'GET']);return json({status:'idle'});});
  await app.click();assert.equal(app.mode.active,true);assert.equal(app.body.dataset.mode,'demo');
  const settings=await (await app.mode.fetch('/api/settings')).json();
  const save=await app.mode.fetch('/api/settings',{method:'PUT',body:JSON.stringify({analysis_settings:settings.analysis_settings,revision:0})});
  assert.equal(save.status,200);assert.equal((await save.json()).revision,1);
  assert.equal((await app.mode.fetch('/api/dashboard')).status,200);
  assert.equal((await app.mode.fetch('/api/pipeline/analyze',{method:'POST'})).status,404);
  assert.deepEqual(calls,[['/api/live/status','GET']]);
  await app.click();assert.equal(app.mode.active,false);assert.equal(app.body.dataset.mode,'real');assert.equal(calls.length,1);
});
test('mode switch discards a response whose body completes late',async()=>{
  let resolveBody, signal;
  const app=setup(async(url,options)=>{
    if(url==='/api/live/status')return json({status:'idle'});
    signal=options.signal;return {text:()=>new Promise(resolve=>resolveBody=resolve),status:200};
  });
  const pending=app.mode.fetch('/api/dashboard');await Promise.resolve();
  await app.click();assert.equal(signal.aborted,true);resolveBody('{}');
  await assert.rejects(pending,{name:'AbortError'});
});
test('writes lock switching until response body is consumed',async()=>{
  let resolveBody, checks=0;
  const app=setup(async()=>{++checks;return {text:()=>new Promise(resolve=>resolveBody=resolve),status:200,statusText:'OK',headers:{}};});
  const write=app.mode.fetch('/api/settings',{method:'PUT'});await Promise.resolve();
  assert.equal(app.toggle.disabled,true);await app.click();assert.equal(checks,1);assert.equal(app.mode.active,false);
  resolveBody('{}');await write;assert.equal(app.toggle.disabled,false);
});
test('failed writes release lock; analysis lock spans sequential requests',async()=>{
  const app=setup(async()=>{throw Error('offline');});
  await assert.rejects(app.mode.fetch('/api/settings',{method:'PUT'}),/offline/);assert.equal(app.toggle.disabled,false);
  app.mode.lock('analysis',true);await app.click();assert.equal(app.mode.active,false);assert.equal(app.toggle.disabled,true);
  app.mode.lock('analysis',false);assert.equal(app.toggle.disabled,false);
});
test('204 no-content responses remain valid',async()=>{
  const app=setup(async()=>new Response(null,{status:204}));const response=await app.mode.fetch('/api/example');assert.equal(response.status,204);
});
function capturePack() {
  const hash=bytes=>require('node:crypto').createHash('sha256').update(bytes).digest('hex');
  const image=Buffer.from([255,216,255,217]);
  const payload=Buffer.from(JSON.stringify({result:{is_model_output:true,model:'yolov8n',device_used:'cpu',source:{width:640,height:360,fps:null,frame_count:null,duration_s:null},frames:[{detections:[{class_name:'smoke',confidence:.8779,xyxy:[1,1,640,350]},{class_name:'fire',confidence:.3589,xyxy:[230,230,260,252]}]}]}}));
  const manifest={approved_preview:true,sample_id:'captured-smoke',media_kind:'still-image-replay',model:'yolov8n',payload:{path:'demo-assets/smoke-result.json',sha256:hash(payload)},preview:{path:'demo-assets/smoke-preview.jpg',sha256:hash(image)}};
  return {image,payload,manifest};
}
test('approved local pack creates a captured result with demo provenance and no API writes',async()=>{
  const pack=capturePack(),calls=[];
  const app=setup(async(url)=>{calls.push(url);if(url==='/api/live/status')return json({status:'idle'});if(url==='demo-manifest.json')return json(pack.manifest);return new Response(url.endsWith('.jpg')?pack.image:pack.payload);});
  await app.click();app.scenario.value='captured-smoke';const result=await app.mode.analyze();assert.equal(result.context.kind,'captured');assert.equal(result.stage1.is_model_output,false);
  assert.deepEqual(result.stage1.frames[0].detections.map(d=>[d.class_name,d.confidence]),[['smoke',.8779],['fire',.3589]]);
  assert.match(result.context.note,/D-Fire กลางแจ้ง.*ไม่ใช่ภาพจากโรงงาน.*ไม่ได้รันโมเดลใหม่.*Smoke 0\.8779 \/ Fire 0\.3589/);
  assert.deepEqual(calls,['/api/live/status','demo-manifest.json','demo-assets/smoke-result.json','demo-assets/smoke-preview.jpg']);
});
for(const fault of ['missing','checksum','unapproved','incomplete'])test('pack failure stays local: '+fault,async()=>{
  const pack=capturePack();
  if(fault==='checksum')pack.manifest.preview.sha256='0'.repeat(64);
  if(fault==='unapproved')pack.manifest.approved_preview=false;
  if(fault==='incomplete'){pack.payload=Buffer.from(JSON.stringify({result:{model:'yolov8n',frames:[]}}));pack.manifest.payload.sha256=require('node:crypto').createHash('sha256').update(pack.payload).digest('hex');}
  const app=setup(async(url)=>{if(url==='/api/live/status')return json({status:'idle'});if(url==='demo-manifest.json')return json(pack.manifest);if(fault==='missing')return new Response('missing',{status:404});return new Response(url.endsWith('.jpg')?pack.image:pack.payload);});
  app.scenario.value='captured-smoke';
  await app.click();await assert.rejects(app.mode.analyze());assert.equal(app.mode.demo.store.runs.length,28);
});
test('hidden tabs freeze the scenario and resume without catch-up; leaving stops callbacks',async()=>{
  const pack=capturePack();const app=setup(async(url)=>{
    if(url==='/api/live/status')return json({status:'idle'});
    if(url==='demo-manifest.json')return json(pack.manifest);
    return new Response(url.endsWith('.jpg')?pack.image:pack.payload);
  });
  await app.click();await app.mode.startLive();app.timers[0]();assert.equal(app.mode.demo.elapsed,.25);
  app.document.hidden=true;for(let i=0;i<100;i++)app.timers[0]();assert.equal(app.mode.demo.elapsed,.25);
  app.document.hidden=false;app.timers[0]();assert.equal(app.mode.demo.elapsed,.5);
  const old=app.mode.demo;await app.click();for(let i=0;i<100;i++)app.timers[0]();assert.equal(old.elapsed,.5);assert.equal(old.session.state,'completed');
});
