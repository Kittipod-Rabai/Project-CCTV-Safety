const {test}=require('node:test');
const assert=require('node:assert/strict');
const {Store,DemoProvider,DEFAULTS,SCENARIOS}=require('../mockup/demo-provider.js');
const clone=x=>JSON.parse(JSON.stringify(x));
const NOW=Date.parse('2026-10-14T15:30:00Z');
function empty(){const s=new Store(NOW);s.runs=[];s.rows=[];s.notices=[];s.serial=0;return s;}
function obs(type,score,count=1,t=0){return {event_type:type,score,count,start_s:t,end_s:t,details:{score}};}
const smoke=SCENARIOS.find(s=>s.id==='smoke');
test('deterministic 28 runs over 7 calendar days and derived totals',()=>{
  const a=new Store(NOW),b=new Store(NOW);assert.deepEqual(a.dashboard(),b.dashboard());
  const days={};for(const run of a.runs){const d=new Date(Date.parse(run.created_at)+7*3600000).toISOString().slice(0,10);days[d]=(days[d]||0)+1;assert.equal(run.context.kind,'synthetic');}
  assert.deepEqual(Object.values(days),[3,4,2,5,3,4,7]);assert.equal(a.runs.length,28);assert.ok(a.runs.every(r=>r.state==='completed'));
  const d=a.dashboard();assert.equal(d.total,a.rows.length);assert.equal(Object.values(d.by_type).reduce((a,b)=>a+b,0),d.total);assert.equal(d.daily.reduce((n,x)=>n+x.count,0),d.total);assert.equal(d.latest.length,5);
  assert.ok(a.runs.some(run=>!a.rows.some(row=>row.run_id===run.id)));assert.ok(a.rows.some(r=>r.event_type==='review_fall_fight_conflict'));
});
test('repeat results merge counts/max/ranges and keep original day',()=>{
  const s=empty(),run=s.begin(smoke);s.observe(run,'yolov8n',[obs('smoke',.8,2,1)]);const recorded=s.rows[0].recorded_at;
  s.time+=86400000;s.observe(run,'yolov8n',[obs('smoke',.6,3,8)]);
  assert.equal(s.rows.length,1);assert.equal(s.rows[0].observation_count,5);assert.equal(s.rows[0].score,.8);assert.equal(s.rows[0].details.score,.8);assert.equal(s.rows[0].recorded_at,recorded);assert.equal(s.rows[0].start_s,1);assert.equal(s.rows[0].end_s,8);assert.equal(s.dashboard('today').total,0);
});
test('current score, cooldown boundary, ack/closed/reopen and audit',()=>{
  const s=empty(),run=s.begin(smoke);s.observe(run,'yolov8n',[obs('smoke',.9)]);assert.equal(s.notices.length,1);
  s.time+=29999;s.observe(run,'yolov8n',[obs('smoke',.9)]);assert.equal(s.notices.length,1);
  s.time++;s.observe(run,'yolov8n',[obs('smoke',.3)]);assert.equal(s.notices.length,1);
  s.observe(run,'yolov8n',[obs('smoke',.5)]);assert.equal(s.notices.length,2);
  s.review(1,'ack');s.review(1,'ack');assert.equal(s.rows[0].status_history.length,1);
  s.time+=30000;s.observe(run,'yolov8n',[obs('smoke',.9)]);assert.equal(s.notices.length,2);assert.equal(s.notifications().total,2);assert.equal(s.notifications().items[0].status,'ack');
  s.review(1,'closed');s.review(1,'new');assert.equal(s.notices.length,2);
  s.observe(run,'yolov8n',[obs('smoke',.9)]);assert.equal(s.notices.length,3);
});
test('reopen itself neither emits nor resets cooldown',()=>{
  const s=empty(),r=s.begin(smoke);s.observe(r,'yolov8n',[obs('smoke',.8)]);s.time+=1000;s.review(1,'ack');s.review(1,'new');s.observe(r,'yolov8n',[obs('smoke',.8)]);assert.equal(s.notices.length,1);
});
test('no notifications for ordinary classes/non-fight and threshold equality for Fight',()=>{
  const s=empty(),r=s.begin(smoke);for(const type of ['person','helmet','vest','non_fight'])s.observe(r,'test',[obs(type,.99)]);assert.equal(s.notices.length,0);
  s.observe(r,'x3d_s',[obs('fight',.6999)]);assert.equal(s.notices.length,0);s.observe(r,'x3d_s',[obs('fight',.7)]);assert.equal(s.notices.length,1);
});
test('notification cursor pagination and reset',()=>{
  const s=empty(),r=s.begin(smoke);for(let i=0;i<4;i++){s.time+=30000;s.observe(r,'yolov8n',[obs('smoke',.8)]);}
  const first=s.notifications(0,2);assert.deepEqual(first.items.map(n=>n.id),[1,2]);assert.equal(first.cursor,2);assert.equal(first.has_more,true);
  assert.deepEqual(s.notifications(2,2).items.map(n=>n.id),[3,4]);assert.equal(s.notifications(999).reset,true);
});
test('Bangkok calendar Dashboard 7d differs from rolling Logs 168h',()=>{
  const s=empty();s.time=Date.parse('2026-10-07T16:00:00Z');const r=s.begin(smoke);s.observe(r,'yolov8n',[obs('smoke',.8)]);s.time=Date.parse('2026-10-14T15:00:00Z');
  assert.equal(s.dashboard('7d').total,0);assert.equal(s.list({period:'7d'}).total,1);
  s.time=Date.parse('2026-10-14T17:00:00Z');assert.equal(s.dashboard('today').total,0);
});
test('search/type/status/source pagination and global pending count',()=>{
  const s=new Store(NOW),r=s.rows.find(r=>r.status==='new');
  const list=s.list({q:r.run_id,event_type:r.event_type,status:'new',run_id:r.run_id,page:999,page_size:1});
  assert.equal(list.page,1);assert.equal(list.total,1);assert.equal(list.items[0].id,r.id);assert.equal(list.pending_total,s.pending());
  assert.equal(s.list({q:'not-an-existing-source'}).total,0);assert.equal(s.list({q:'not-an-existing-source'}).pending_total,s.pending());
});
test('PPE derives person score and equipment spatial association',async()=>{
  const p=new DemoProvider({now:NOW});let result=await p.analyze('ppe-ok');assert.deepEqual(result.stage1.frames[0].ppe[0].alerts,[]);assert.equal(result.stage1.frames[0].ppe[0].has_helmet,true);
  result=await p.analyze('ppe-missing');const row=p.store.rows.find(r=>r.run_id===result.run_id&&r.event_type==='no_helmet');assert.equal(row.score,.92);assert.match(row.details.score_basis,/person_confidence/);
  assert.equal(result.stage1.is_model_output,false);assert.equal(result.context.kind,'synthetic');assert.equal(result.stage1.privacy,null);
});
test('settings numeric/schema validation and compare-and-swap',()=>{
  const s=new Store(NOW);const settings=clone(DEFAULTS);settings.yolo.thresholds.person=.255;s.save({revision:0,analysis_settings:settings});assert.equal(s.revision,1);
  assert.throws(()=>s.save({revision:0,analysis_settings:settings}),e=>e.code==='settings_conflict');
  for(const v of [NaN,Infinity,'0.3',true,-.1,1.01]){const bad=clone(DEFAULTS);bad.yolo.thresholds.person=v;assert.throws(()=>s.save({revision:1,analysis_settings:bad}));}
  const bad=clone(DEFAULTS);bad.yolo.extra=1;assert.throws(()=>s.save({revision:1,analysis_settings:bad}));assert.equal(s.revision,1);
});
test('YOLO threshold >= vs X3D strict > and no invented inference',async()=>{
  const p=new DemoProvider({now:NOW});let r=await p.analyze('below',{yolo:{thresholds:{smoke:.34}}});assert.equal(r.stage1.frames[0].detections.length,1);
  r=await p.analyze('below',{yolo:{thresholds:{smoke:.3401}}});assert.equal(r.stage1.frames[0].detections.length,0);
  r=await p.analyze('fight',{x3d:{fight_threshold:.82}});assert.equal(r.stage2.windows[0].label,'non_fight');
  r=await p.analyze('fight',{x3d:{fight_threshold:.8199},yolo:{imgsz:320,iou:.9}});assert.equal(r.stage2.windows[0].label,'fight');assert.equal(r.stage2.windows[0].probs.fight,.82);
});
test('Live snapshot, pause, next, deduplication, stop and reset',async()=>{
  const p=new DemoProvider({now:NOW}),base=p.store.rows.length,notices=p.store.notices.length;const messages=[];p.subscribe(m=>messages.push(m));
  await p.start('smoke');p.store.save({revision:0,analysis_settings:{...clone(DEFAULTS),yolo:{...clone(DEFAULTS.yolo),thresholds:{...DEFAULTS.yolo.thresholds,smoke:.95}}}});
  p.paused=true;p.tick(20);assert.equal(p.elapsed,0);p.next();assert.equal(p.elapsed,10);assert.equal(p.store.rows.length,base+2);assert.equal(p.store.notices.length,notices+1);
  const row=p.store.rows.find(r=>r.run_id===p.session.id&&r.event_type==='smoke');assert.equal(row.start_s,null);assert.equal(row.observation_count,1);assert.equal(p.session.settings_revision,0);
  p.next();assert.equal(row.observation_count,2);assert.equal(p.store.notices.length,notices+1);p.store.review(row.id,'ack');p.next();assert.equal(p.store.notices.length,notices+1);p.next();assert.equal(p.status().status,'completed');
  const count=messages.length;p.next();p.tick(300);assert.equal(messages.length,count);
  assert.ok(messages.every(m=>m.session_id===p.session.id));assert.equal(messages.find(m=>m.type==='confidence').time_s,null);
  p.reset(NOW);assert.equal(p.store.runs.length,28);assert.equal(p.store.revision,0);assert.equal(p.status().status,'idle');assert.equal(p.listeners.size,0);
});
test('unacknowledged repeating result re-notifies after cooldown only',async()=>{
  const p=new DemoProvider({now:NOW}),n=p.store.notices.length;await p.start('smoke');p.paused=true;p.next();p.next();assert.equal(p.store.notices.length,n+1);p.next();assert.equal(p.store.notices.length,n+2);
});
test('preparation failure and reset during pending capture never create a run',async()=>{
  const p=new DemoProvider({now:NOW,loadCapture:async()=>{throw Error('missing pack');}});await assert.rejects(p.start('captured-smoke'),/missing pack/);assert.equal(p.store.runs.length,28);
  let resolve;const q=new DemoProvider({now:NOW,loadCapture:()=>new Promise(r=>resolve=r)});const task=q.start('captured-smoke');q.reset(NOW);resolve({preview:'',result:{}});await assert.rejects(task,{name:'AbortError'});assert.equal(q.store.runs.length,28);
});
test('async preparation keeps settings revision captured before await',async()=>{
  let resolve;const p=new DemoProvider({now:NOW,preview:()=>new Promise(r=>resolve=r)});const task=p.analyze('smoke');p.store.save({revision:0,analysis_settings:clone(DEFAULTS)});resolve('');const r=await task;assert.equal(r.stage1.settings_revision,0);assert.equal(p.store.runs.at(-1).settings_revision,0);
});
test('unsupported request fails locally; revisions and history stay isolated',async()=>{
  const p=new DemoProvider({now:NOW});await assert.rejects(p.request('/api/pipeline/analyze',{method:'POST'}));const a=await p.request('/api/settings');a.analysis_settings.yolo.thresholds.person=.9;assert.equal(p.store.settings.yolo.thresholds.person,.25);
});
