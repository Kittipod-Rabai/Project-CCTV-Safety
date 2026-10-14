/* Test-only bridge: execute the same operation vectors as Python EventStore. */
const fs=require('node:fs');
const {Store}=require('../mockup/demo-provider.js');
const input=JSON.parse(fs.readFileSync(0,'utf8')),s=new Store(input.now);
s.rows=[];s.runs=[];s.notices=[];s.serial=0;
const runs=new Map(),out=[];
for(const action of input.actions){
  s.time=action.time;
  if(action.op==='begin'){const run=s.begin({id:'contract',label:'test',zone:'test'},'upload');run.id=action.id;runs.set(action.id,run);}
  if(action.op==='observe')s.observe(runs.get(action.id),action.model,action.items);
  if(action.op==='review')s.review(action.id,action.status);
  if(action.op==='finish')s.finish(action.id);
  if(action.op==='snapshot')out.push({dashboard:s.dashboard(action.period),logs:s.list(action.filters),notifications:s.notifications(action.after??null,action.limit||20)});
}
process.stdout.write(JSON.stringify(out));
