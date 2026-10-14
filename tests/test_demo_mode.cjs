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
  const nodes = new Map(), events = new Map();
  class Element {
    constructor() { this.children=[]; this.listeners={}; this.dataset={}; this.classList={add(){},remove(){}}; }
    set id(value) { this._id=value; nodes.set(value,this); }
    get id() { return this._id; }
    append(...items) { this.children.push(...items); }
    before() {} after() {} remove() {} focus() {}
    replaceChildren(...items) { this.children=items; }
    setAttribute(key,value) { this[key]=value; }
    addEventListener(name,fn) { (this.listeners[name] ||= []).push(fn); }
    querySelector(selector) { return nodes.get(selector.slice(1)); }
  }
  for(const id of ['ntToggle','ntPanel','ntToast','pgSub','feed','mask','rlMask']) {const n=new Element(); n.id=id;}
  const body=new Element(); body.dataset.page='dashboard';
  const monitor=new Element(), main=new Element(), topbar=new Element();
  const document={body,hidden:false,createElement:()=>new Element(),getElementById:id=>nodes.get(id),
    querySelector:selector=>selector==='.live-demo'?monitor:selector==='main'?main:topbar,
    querySelectorAll:()=>[],addEventListener:(name,fn)=>{(events.get(name)||events.set(name,[]).get(name)).push(fn);},
    dispatchEvent:ev=>{for(const fn of events.get(ev.type)||[])fn(ev);}};
  const window={go:target=>body.dataset.page=target};
  class CustomEvent {constructor(type,options){this.type=type;this.detail=options.detail;}}
  vm.runInNewContext(source,{window,document,fetch,Response,DOMException,AbortController,CustomEvent,
    setTimeout:()=>1,clearTimeout(){},setInterval:()=>1,clearInterval(){},Intl,Date,Map,Set,console});
  return {mode:window.CCTVMode,toggle:nodes.get('modeToggle'),banner:nodes.get('modeBanner'),body,
    click:()=>nodes.get('modeToggle').listeners.click[0]()};
}
const json = data => new Response(JSON.stringify(data),{headers:{'Content-Type':'application/json'}});
for(const status of ['starting','running','degraded','stopping']) test('requires stopping real Live: '+status,async()=>{
  let calls=0;const app=setup(async()=>{++calls;return json({status});});
  await app.click();assert.equal(app.mode.active,false);assert.match(app.banner.textContent,/หยุด Live/);assert.equal(calls,1);
});
test('unknown status and network failure keep real mode',async()=>{
  for(const fetch of [async()=>json({status:'unknown'}),async()=>{throw Error('offline');}]) {
    const app=setup(fetch);await app.click();assert.equal(app.mode.active,false);assert.ok(app.banner.textContent);
  }
});
test('demo rejects real API reads/writes and returns to real without backend writes',async()=>{
  const calls=[];const app=setup(async(url,options)=>{calls.push([url,options?.method||'GET']);return json({status:'idle'});});
  await app.click();assert.equal(app.mode.active,true);assert.equal(app.body.dataset.mode,'demo');
  for(const method of ['GET','POST','PUT','PATCH'])await assert.rejects(app.mode.fetch('/api/settings',{method}),{name:'AbortError'});
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
