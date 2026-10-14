/* Local-only deterministic data provider. The same response contracts feed the real UI.
 * UMD export keeps semantic tests independent of the browser and backend. */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.CCTVDemo = api;
}(typeof window === 'undefined' ? globalThis : window, function () {
  'use strict';
  const clone = value => JSON.parse(JSON.stringify(value));
  const DAY = 86400000, OFFSET = 7 * 3600000;
  const iso = ms => new Date(ms).toISOString();
  const midnight = ms => Math.floor((ms + OFFSET) / DAY) * DAY - OFFSET;
  const day = ms => new Date(ms + OFFSET).toISOString().slice(0,10);
  const TYPES = ['fall','fight','fire','helmet','no_helmet','no_vest','non_fight','person','review_fall_fight_conflict','smoke','vest'];
  const CLASSES = ['person','helmet','vest','fall','fire','smoke'];
  const FLOORS = {fall:.5,fire:.5,smoke:.5,no_helmet:.5,no_vest:.5,fight:.7,review_fall_fight_conflict:.5};
  const DEFAULTS = {yolo:{thresholds:{person:.25,helmet:.2,vest:.2,fall:.2,fire:.2,smoke:.2},iou:.7,imgsz:640,max_det:300},
    x3d:{fight_threshold:.5},tracking:{proximity_diagonals:.16,motion_diagonals_per_s:.25,max_track_gap_s:.75}};
  const SCENARIOS = [
    {id:'captured-smoke',label:'คลังสินค้า · Smoke/Fire · ผลบันทึกจริงจากภาพนิ่ง',kind:'captured',zone:'คลังสินค้า'},
    {id:'ppe-ok',label:'สายการผลิต · PPE ครบ · สมมติ',zone:'สายการผลิต',detections:[['person',.94],['helmet',.91],['vest',.89]]},
    {id:'ppe-missing',label:'จุดรับสินค้า · PPE ไม่ครบ · สมมติ',zone:'จุดรับสินค้า',detections:[['person',.92]]},
    {id:'fall',label:'ทางเดินโรงงาน · Fall · สมมติ',zone:'ทางเดินโรงงาน',detections:[['person',.91],['fall',.77]],fight:.12},
    {id:'smoke',label:'คลังสินค้า · Smoke/Fire · สมมติ',zone:'คลังสินค้า',detections:[['smoke',.86],['fire',.36]]},
    {id:'fight',label:'ลานรับสินค้า · Fight · สมมติ',zone:'ลานรับสินค้า',detections:[['person',.9],['person',.88]],fight:.82},
    {id:'normal',label:'สายการผลิต · Non-fight · สมมติ',zone:'สายการผลิต',detections:[['person',.93],['helmet',.9],['vest',.88]],fight:.13},
    {id:'conflict',label:'ทางเดินโรงงาน · Fall/Fight กำกวม · สมมติ',zone:'ทางเดินโรงงาน',detections:[['person',.9],['fall',.79]],fight:.81},
    {id:'empty',label:'คลังสินค้า · ไม่พบผล · สมมติ',zone:'คลังสินค้า',detections:[]},
    {id:'below',label:'คลังสินค้า · Smoke ต่ำกว่าเกณฑ์แจ้ง · สมมติ',zone:'คลังสินค้า',detections:[['smoke',.34]]}
  ];
  function error(message, code='invalid_parameter') { const e = new Error(message); e.code=code; return e; }
  function validateSettings(value) {
    function shape(input, expected) {
      if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).sort().join()!==Object.keys(expected).sort().join()) throw error('โครงสร้าง Settings ไม่ครบหรือมี field ที่ไม่รองรับ');
      for (const key of Object.keys(expected)) if (typeof expected[key] === 'object') shape(input[key],expected[key]);
    }
    shape(value,DEFAULTS);
    const ranges=[...CLASSES.map(k=>[value.yolo.thresholds[k],.01,.99]),[value.yolo.iou,.1,.95],
      [value.yolo.max_det,1,1000],[value.x3d.fight_threshold,.05,.95],
      [value.tracking.proximity_diagonals,.01,.5],[value.tracking.motion_diagonals_per_s,.01,2],[value.tracking.max_track_gap_s,.1,3]];
    if(ranges.some(([v,min,max])=>typeof v!=='number'||!Number.isFinite(v)||v<min||v>max) || !Number.isInteger(value.yolo.max_det) || ![320,480,640,800,960,1280].includes(value.yolo.imgsz)) throw error('ค่าตั้งอยู่นอกช่วงหรือชนิดไม่ถูกต้อง');
    return clone(value);
  }
  function settingsWith(base, overrides) {
    const next=clone(base);
    if(overrides)for(const [section,values] of Object.entries(overrides)) {
      if(!next[section]||!values||typeof values!=='object')throw error('Settings section ไม่ถูกต้อง');
      for(const [key,value] of Object.entries(values)) {
        if(key==='thresholds'&&section==='yolo')Object.assign(next.yolo.thresholds,value);
        else next[section][key]=value;
      }
    }
    return validateSettings(next);
  }
  class Store {
    constructor(now=Date.now()) { this.reset(now); }
    reset(now=Date.now()) {
      this.anchor=now;this.time=now;this.runs=[];this.rows=[];this.notices=[];this.revision=0;this.settings=clone(DEFAULTS);this.updated=null;this.serial=0;
      const counts=[3,4,2,5,3,4,7], seed=SCENARIOS.slice(1,9);
      let n=0;
      for(let d=0;d<7;d++)for(let i=0;i<counts[d];i++,n++) {
        const start=midnight(now)-(6-d)*DAY;
        // All today's seed runs precede the anchor, even at midnight.
        this.time=start+(d===6?Math.floor((now-start)*(i+1)/(counts[d]+1)): (8+i)*3600000);
        const scenario=seed[n%seed.length], run=this.begin(scenario,'upload');
        const result=this.result(scenario,clone(DEFAULTS),null);
        this.record(run,result,0);
        for(const row of this.rows.filter(r=>r.run_id===run.id))this.review(row.id,['new','new','ack','closed'][row.id%4]);
        this.finish(run.id);
      }
      this.time=now;
    }
    context(scenario, capture) {
      return {mode:'demo',kind:scenario.kind==='captured'?'captured':'synthetic',source:scenario.label,
        captured_at:capture?.captured_at||null,evidence:capture?.evidence||null,
        recorded_settings:capture?.settings||null,recorded_device:capture?.device_used||null,
        note:scenario.kind==='captured'?'ผลบันทึกจริงจากภาพทดสอบ D-Fire · โซนคลังเป็นบริบทสมมติ · เล่นซ้ำจากภาพนิ่ง ไม่ได้รันโมเดลใหม่':'สถานการณ์สมมติ · ภาพวาดและคะแนนตัวอย่าง ไม่ใช่ผลโมเดล'};
    }
    begin(scenario, sourceType='live', settings=this.settings, context=this.context(scenario)) {
      const run={id:'DEMO-RUN-'+String(++this.serial).padStart(4,'0'),source_label:'โรงงานตัวอย่าง / '+scenario.zone+' / '+scenario.id+' (ไฟล์สาธิต)',
        source_type:sourceType,state:'running',created_at:iso(this.time),completed_at:null,context:clone(context),analysis_settings:clone(settings),settings_revision:this.revision};
      this.runs.push(run);return run;
    }
    finish(id) { const run=this.runs.find(r=>r.id===id);if(run){run.state='completed';run.completed_at=iso(this.time);} }
    observe(run,model,items) {
      for(const incoming of items) {
        if(!TYPES.includes(incoming.event_type)||!Number.isFinite(incoming.score)||incoming.score<0||incoming.score>1)throw error('Observation ไม่ถูกต้อง');
        let row=this.rows.find(r=>r.run_id===run.id&&r.model===model&&r.event_type===incoming.event_type);
        if(!row) {row={id:this.rows.length+1,run_id:run.id,event_type:incoming.event_type,model,recorded_at:iso(this.time),updated_at:iso(this.time),start_s:incoming.start_s??null,end_s:incoming.end_s??null,score:incoming.score,observation_count:0,status:'new',details:{},status_history:[]};this.rows.push(row);}
        row.updated_at=iso(this.time);row.observation_count+=incoming.count;
        row.start_s=row.start_s==null||incoming.start_s==null?null:Math.min(row.start_s,incoming.start_s);
        row.end_s=row.end_s==null||incoming.end_s==null?null:Math.max(row.end_s,incoming.end_s);
        if(incoming.score>=row.score){row.score=incoming.score;row.details=clone(incoming.details||{});}
        const floor=FLOORS[incoming.event_type], last=this.notices.filter(n=>n.observation_id===row.id).at(-1);
        if(floor!=null&&incoming.score>=floor&&row.status==='new'&&(!last||this.time-Date.parse(last.created_at)>=30000))this.notices.push({id:this.notices.length+1,observation_id:row.id,created_at:iso(this.time),score:incoming.score,start_s:incoming.start_s??null,end_s:incoming.end_s??null});
      }
    }
    item(row) {
      const run=this.runs.find(r=>r.id===row.run_id);
      return clone({...row,source_label:run.source_label,source_type:run.source_type,run_state:run.state,context:run.context});
    }
    get(id) {const row=this.rows.find(r=>r.id===Number(id));if(!row)throw error('ไม่พบรายการเดโม','not_found');return this.item(row);}
    review(id,status) {
      const row=this.rows.find(r=>r.id===Number(id));if(!row)throw error('ไม่พบรายการเดโม','not_found');
      if(!['new','ack','closed'].includes(status))throw error('สถานะไม่ถูกต้อง');
      if(row.status!==status){row.status_history.push({previous_status:row.status,status,changed_at:iso(this.time)});row.status=status;row.updated_at=iso(this.time);}
      return this.get(id);
    }
    sorted(rows) {return [...rows].sort((a,b)=>Date.parse(b.recorded_at)-Date.parse(a.recorded_at)||b.id-a.id);}
    pending() {return this.rows.filter(r=>r.status==='new').length;}
    list(params={}) {
      const period=params.period||'all', lower=period==='today'?midnight(this.time):period==='yesterday'?midnight(this.time)-DAY:period==='7d'?this.time-7*DAY:-Infinity;
      const rows=this.sorted(this.rows.filter(r=> {
        const run=this.runs.find(x=>x.id===r.run_id),t=Date.parse(r.recorded_at);
        return t>=lower&&(period!=='yesterday'||t<midnight(this.time))&&(!params.status||params.status===r.status)&&(!params.event_type||params.event_type===r.event_type)&&(!params.run_id||params.run_id===r.run_id)&&(!params.q||(run.source_label+' '+run.id+' '+r.event_type+' '+r.model+' '+r.id).toLowerCase().includes(params.q.toLowerCase()));
      }));
      const size=Math.max(1,Math.min(100,Number(params.page_size)||10)),pages=Math.max(1,Math.ceil(rows.length/size)),page=Math.max(1,Math.min(pages,Number(params.page)||1));
      return {items:rows.slice((page-1)*size,page*size).map(r=>this.item(r)),total:rows.length,page,page_size:size,pages,pending_total:this.pending()};
    }
    dashboard(period='7d') {
      const start=midnight(this.time)-6*DAY,lower=period==='today'?midnight(this.time):period==='7d'?start:-Infinity;
      const rows=this.rows.filter(r=>Date.parse(r.recorded_at)>=lower&&Date.parse(r.recorded_at)<=this.time);
      const runs=this.runs.filter(r=>Date.parse(r.created_at)>=lower&&Date.parse(r.created_at)<=this.time);
      const by_type=Object.fromEntries(TYPES.map(t=>[t,0])),by_status={ack:0,closed:0,new:0},run_states={};
      for(const row of rows){by_type[row.event_type]++;by_status[row.status]++;}for(const run of runs)run_states[run.state]=(run_states[run.state]||0)+1;
      return {period,timezone:'Asia/Bangkok',time_basis:'recorded_at',generated_at:iso(this.time),range_start:Number.isFinite(lower)?iso(lower):null,range_end:iso(this.time),total:rows.length,by_type,by_status,pending_total:this.pending(),run_count:runs.length,run_states,
        daily:Array.from({length:7},(_,i)=>({date:day(start+i*DAY),count:rows.filter(r=>day(Date.parse(r.recorded_at))===day(start+i*DAY)).length})),latest:this.sorted(rows).slice(0,5).map(r=>this.item(r))};
    }
    notifications(after=null,limit=20) {
      const max=this.notices.length,reset=after!==null&&after>max;
      const initial=after===null||reset;
      const notices=initial?[...this.notices].reverse().slice(0,limit):this.notices.filter(n=>n.id>after).slice(0,limit);
      const cursor=!initial&&notices.length?notices.at(-1).id:max;
      return {items:notices.map(n=>{const row=this.get(n.observation_id);return {...n,event_type:row.event_type,model:row.model,status:row.status,source_label:row.source_label,source_type:row.source_type,run_id:row.run_id,context:row.context};}),total:max,cursor,has_more:cursor<max,reset,cooldown_s:30,min_scores:FLOORS};
    }
    saved() {return {analysis_settings:clone(this.settings),defaults:clone(DEFAULTS),revision:this.revision,updated_at:this.updated};}
    save(data) {if(data.revision!==this.revision)throw error('Revision เดโมเปลี่ยนแล้ว','settings_conflict');this.settings=validateSettings(data.analysis_settings);this.revision++;this.updated=iso(this.time);return this.saved();}
    result(scenario,settings,capture,preview='') {
      const context=this.context(scenario,capture);
      const detections=scenario.kind==='captured'?clone(capture.result.frames[0].detections):
        (scenario.detections||[]).map(([name,confidence],i)=>({class_name:name,class_id:CLASSES.indexOf(name),confidence,
          xyxy:name==='helmet'?[270,55,325,90]:name==='vest'?[270,110,325,180]:name==='smoke'?[40,20,600,330]:name==='fire'?[235,230,265,260]:['fall','conflict'].includes(scenario.id)?[230,200,440,285]:[250+i*140,50,345+i*140,310]}));
      const filtered=detections.filter(d=>d.confidence>=settings.yolo.thresholds[d.class_name]);
      const persons=filtered.filter(d=>d.class_name==='person');
      const ppe=persons.filter(p=>p.confidence>=.2).map((p,i)=>{
        const present=(name,top,bottom)=>filtered.some(d=>{
          const [x1,y1,x2,y2]=p.xyxy,[a,b,c,e]=d.xyxy,x=(a+c)/2,y=(b+e)/2;
          return d.class_name===name&&d.confidence>=.2&&x>=x1&&x<=x2&&y>=y1+(y2-y1)*top&&y<=y1+(y2-y1)*bottom;
        });
        const helmet=present('helmet',0,.35),vest=present('vest',.2,.75);
        return {person_index:i,person_confidence:p.confidence,has_helmet:helmet,has_vest:vest,
          alerts:[...(!helmet?['no_helmet']:[]),...(!vest?['no_vest']:[])],method:'ppe-centre-in-person-region'};
      });
      // Sparse approved previews only. Never fabricate a complete face scan or dense playback.
      const video=scenario.fight!==undefined;
      const source=scenario.kind==='captured'?clone(capture.result.source):{width:640,height:360,fps:video?1:null,frame_count:video?2:null,duration_s:video?2:null};
      const stage1={is_model_output:false,model:scenario.kind==='captured'?capture.result.model:'yolov8n',device_used:scenario.kind==='captured'?capture.result.device_used:null,
        schema_version:'1.0',detector_schema_version:2,class_names:CLASSES,media_type:video?'video':'image',mode:'frames',source,
        thresholds:clone(settings.yolo.thresholds),ppe_min_confidence:.2,analysis_settings:clone(settings),settings_revision:this.revision,
        frames:[{index:0,time_s:video?0:null,image_jpeg_b64:preview,detections:filtered,ppe}],context,
        disclaimer:'โหมดสาธิต · '+context.note+' · เปลี่ยนเกณฑ์กับผลที่บันทึกไว้ ไม่ได้ inference ใหม่; IoU/imgsz/max_det/Tracking ไม่ได้ประมวลผลใหม่',privacy:null};
      if(capture?.result.timings_ms)stage1.timings_ms=clone(capture.result.timings_ms);
      if(!video)return {stage1,stage2:null,context};
      const fight=scenario.fight,label=fight>settings.x3d.fight_threshold?'fight':'non_fight';
      const conflict=scenario.id==='conflict'&&label==='fight'&&filtered.some(d=>d.class_name==='fall');
      const window={index:0,start_s:0,end_s:2,probs:{non_fight:1-fight,fight},label};
      const stage2={is_model_output:false,model:'x3d_s',device_used:null,schema_version:'1.0',source,class_names:['non_fight','fight'],frames_per_window:13,window_s:2,fight_threshold:settings.x3d.fight_threshold,
        analysis_settings:clone(settings),settings_revision:this.revision,windows:[window],summary:{max_fight_prob:fight,fight_windows:label==='fight'?1:0,total_windows:1},context,disclaimer:stage1.disclaimer};
      if(conflict)stage2.pipeline={mode:'synthetic-review',total_windows:1,person_triggered_windows:1,candidate_triggered_windows:0,fight_without_candidate_trigger:1,proximity_diagonals:settings.tracking.proximity_diagonals,motion_diagonals_per_s:settings.tracking.motion_diagonals_per_s,review_fall_fight_conflict_windows:1,fight_candidate_windows:0,fall_detected_windows:1,windows:[{decision:'review_fall_fight_conflict',decision_label:'Fall/Fight กำกวม · ตรวจสอบ',max_concurrent_tracks:persons.length,trigger_reasons:[],proximity_frames:0,motion_frames:0,person_triggered:persons.length>0,candidate_triggered:false}]};
      return {stage1,stage2,context};
    }
    record(run,result,time_s) {
      if(result.stage1.media_type==='image')time_s=null;
      const frame=result.stage1.frames[0], groups=new Map();
      for(const detection of frame.detections) {
        const key=detection.class_name, group=groups.get(key)||{event_type:key,count:0,score:0,details:{}};
        group.count++;if(detection.confidence>=group.score){group.score=detection.confidence;group.details={xyxy:detection.xyxy,frame_index:frame.index};}groups.set(key,group);
      }
      for(const person of frame.ppe)for(const key of person.alerts){const group=groups.get(key)||{event_type:key,count:0,score:0};group.count++;group.score=Math.max(group.score,person.person_confidence);group.details={method:'ppe-centre-in-person-region',score_basis:'person_confidence; derived PPE rule'};groups.set(key,group);}
      this.observe(run,result.stage1.model,[...groups.values()].map(g=>({...g,start_s:time_s,end_s:time_s})));
      if(result.stage2) {
        const w=result.stage2.windows[0];this.observe(run,'x3d_s',[{event_type:w.label,score:w.probs[w.label],count:1,start_s:w.start_s,end_s:w.end_s,details:{score_basis:'X3D softmax (synthetic)',probs:w.probs}}]);
        if(result.stage2.pipeline?.review_fall_fight_conflict_windows)this.observe(run,'x3d_s',[{event_type:'review_fall_fight_conflict',score:w.probs.fight,count:1,start_s:w.start_s,end_s:w.end_s,details:{decision:'Fall/Fight conflict; human review required'}}]);
      }
    }
  }
  class DemoProvider {
    constructor({now=Date.now(),loadCapture,preview=()=>''}={}) {this.store=new Store(now);this.loadCapture=loadCapture;this.preview=preview;this.listeners=new Set();this.generation=0;this.resetLive();}
    resetLive() {this.session=null;this.elapsed=0;this.nextIndex=0;this.paused=true;this.result=null;this.timeline=[10,20,45,90];}
    reset(now=Date.now()) {this.generation++;this.listeners.clear();this.resetLive();this.store.reset(now);}
    scenario(id) {const scenario=SCENARIOS.find(s=>s.id===id);if(!scenario)throw error('ไม่พบสถานการณ์');return scenario;}
    async prepare(id,overrides) {
      const generation=this.generation,scenario=this.scenario(id),settings=settingsWith(this.store.settings,overrides),revision=this.store.revision;
      const capture=scenario.kind==='captured'?await this.loadCapture():null;
      const preview=capture?capture.preview:await this.preview(scenario);
      if(generation!==this.generation)throw new DOMException('Demo reset','AbortError');
      const result=this.store.result(scenario,settings,capture,preview);result.stage1.settings_revision=revision;if(result.stage2)result.stage2.settings_revision=revision;
      return {scenario,settings,result,revision};
    }
    async analyze(id,overrides) {const {scenario,settings,result,revision}=await this.prepare(id,overrides);const run=this.store.begin(scenario,'upload',settings,result.context);run.settings_revision=revision;this.store.record(run,result,result.stage2?0:null);this.store.finish(run.id);return {...result,run_id:run.id};}
    async start(id) {if(this.session?.state==='running')throw error('มีเซสชันเดโมกำลังทำงาน');const {scenario,settings,result,revision}=await this.prepare(id);this.resetLive();this.result=result;this.session=this.store.begin(scenario,'file',settings,result.context);this.session.settings_revision=revision;this.startTime=this.store.time;this.paused=false;return this.status();}
    status() {return this.session?{status:this.session.state,state:this.session.state,generated_at:iso(this.store.time),session_id:this.session.id,settings_revision:this.session.settings_revision,analysis_settings:clone(this.session.analysis_settings),device_used:this.result.stage1.device_used,device_components:null,playback_mode:'demo',frames_received:this.nextIndex,frames_processed:this.nextIndex,context:this.session.context,elapsed_s:this.elapsed,paused:this.paused,timings_ms:this.result.stage1.timings_ms||null}: {status:'idle',state:'idle',session_id:null};}
    subscribe(fn) {this.listeners.add(fn);return ()=>this.listeners.delete(fn);}
    emit(message) {for(const fn of this.listeners)fn({...message,session_id:this.session.id,context:this.session.context});}
    tick(seconds) {
      if(this.paused||this.session?.state!=='running')return;
      this.advance(Math.min(90,this.elapsed+seconds));
    }
    next() {if(this.session?.state==='running')this.advance(this.timeline[this.nextIndex]??90);}
    advance(target) {
      if(this.session?.state!=='running')return;
      while(this.nextIndex<this.timeline.length&&this.timeline[this.nextIndex]<=target) {
        const t=this.timeline[this.nextIndex++];this.elapsed=t;this.store.time=this.startTime+t*1000;
        if(t===90){this.store.finish(this.session.id);this.paused=true;this.emit({type:'health',...this.status(),state:'stopped'});break;}
        const result=this.result, frame=result.stage1.frames[0];this.store.record(this.session,result,frame.time_s);
        this.emit({type:'preview',jpeg_b64:frame.image_jpeg_b64,time_s:frame.time_s,demo_time_s:t,processing_latency_ms:null});
        const classes={};for(const d of frame.detections){const c=classes[d.class_name]||{count:0,max_confidence:0};c.count++;c.max_confidence=Math.max(c.max_confidence,d.confidence);classes[d.class_name]=c;}
        this.emit({type:'confidence',model:result.stage1.model,time_s:frame.time_s,demo_time_s:t,detection_count:frame.detections.length,classes});
        if(result.stage2){const w=result.stage2.windows[0];this.emit({type:'x3d',start_s:w.start_s,end_s:w.end_s,non_fight:w.probs.non_fight,fight:w.probs.fight,label:w.label});}
        this.emit({type:'health',...this.status()});
      }
      this.elapsed=target;this.store.time=this.startTime+target*1000;
    }
    stop() {if(this.session){this.store.finish(this.session.id);this.paused=true;this.emit({type:'health',...this.status(),state:'stopped'});}return this.status();}
    async request(path,options={}) {
      const url=new URL(path,'http://demo.local'),p=url.pathname,q=Object.fromEntries(url.searchParams),method=options.method||'GET';
      const data=options.body?JSON.parse(options.body):null;
      if(p==='/api/dashboard')return this.store.dashboard(q.period);
      if(p==='/api/logs/sources')return {items:[...this.store.runs].sort((a,b)=>b.created_at.localeCompare(a.created_at)||b.id.localeCompare(a.id)).slice(0,100).map(clone)};
      if(p==='/api/logs')return this.store.list(q);
      if(/^\/api\/logs\/\d+$/.test(p))return method==='PATCH'?this.store.review(p.split('/').at(-1),data.status):this.store.get(p.split('/').at(-1));
      if(p==='/api/notifications')return this.store.notifications(q.after_id===undefined?null:Number(q.after_id),Math.min(50,Number(q.limit)||20));
      if(p==='/api/settings')return method==='PUT'?this.store.save(data):this.store.saved();
      if(p==='/api/live/status')return this.status();
      if(p==='/api/health')return {device:'ไม่ได้รันโมเดล',models:{yolov8n:'demo',yolov8s:'demo',x3d_s:'demo'},runtime:{cuda_available:false,face_backend:'demo'}};
      if(p==='/api/live/start-upload'&&method==='OPTIONS')return {};
      throw error('เดโมไม่รองรับคำขอนี้ ไม่มีการเรียก backend แทน','not_found');
    }
  }
  return {Store,DemoProvider,SCENARIOS,DEFAULTS,FLOORS,validateSettings,settingsWith};
}));
