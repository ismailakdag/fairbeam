// Real lifecycle modules bundled in memory; dependency state and network are isolated.
// No DOM/server/native solver. Deferred responses exercise ownership, not elapsed timers.
import assert from 'node:assert/strict';
import {build} from 'vite';
import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
const root=fileURLToPath(new URL('../',import.meta.url)).replaceAll('\\','/');
const files=['src/runner/designRun.ts','src/designer/runResults.ts'].map(f=>root+f);
const imports=new Map();
for(const file of files){
 for(const match of readFileSync(file,'utf8').matchAll(/import\s+(type\s+)?\{([^}]+)\}\s+from\s+["']([^"']+)["']/g)){
  if(match[1])continue;
  const id=match[3];
  if(id==='solid-js'||['../workspace','../lib/validate','./resultFollow'].includes(id))continue;
  const key=path.posix.resolve(path.posix.dirname(file),id).replace(/\.ts$/,'');
  if(key.endsWith('/src/runner/designRun')||key.endsWith('/src/designer/runResults'))continue;
  const names=imports.get(key)??new Set();
  for(const spec of match[2].split(',').map(s=>s.trim()))if(!spec.startsWith('type '))names.add(spec.split(/\s+as\s+/)[0]);
  imports.set(key,names);
 }
}
const control='\0result-lifecycle-control';
const controlSource=`import {createSignal} from 'solid-js';
export const [file,setFile]=createSignal(null),[index,setIndex]=createSignal([]),[bundle,setBundle]=createSignal(null),[source,setSource]=createSignal(''),[resultFocus,setFocus]=createSignal(null);
export const ctl={indices:[],projects:[],clears:0,opened:0,loads:[]};
export const openCount=()=>ctl.opened;
export function clearProject(){ctl.clears++;ctl.opened++;setBundle(null);setSource('');}
export function openBundle(b,f){ctl.opened++;setBundle(b);setSource(f);}
export const loadIndex=()=>ctl.indices.shift().promise;
export const lastProject=()=>null;
export async function loadProject(file,current=()=>true){ctl.loads.push(file);const b=await ctl.projects.shift().promise;if(!current())return false;openBundle(b,file);return true;}
export const jobs=()=>[],models=()=>[],selection=()=>null,notice=()=>null,runOpen=()=>false,live={job:null};
export const designDockTab=()=> 'checks';
export const projectUrl=f=>f;
export const newestResults=x=>x,exampleEntries=x=>x;
export const runRows=(xs,model)=>xs.filter(x=>x.model===model&&x.simulated).map(x=>({...x,label:x.name,title:x.created}));
export const projectLabels=()=>new Map(),runLetters=()=>new Map(),indexQuality=()=>null;
export const runQuality=b=>b.name,runContent=b=>({name:b.name}),rawMetrics=b=>({name:b.name}),bundleMetrics=b=>({name:b.name}),indexMetrics=()=>null;
export const activeMainResult=()=>null,focusResult=setFocus,resultTarget=()=> 'keep';
export const serverActivity=()=>({other:null});
export const t=k=>k,fmt={fixed:String};
`;
const exposed=new Set([...controlSource.matchAll(/(?:export (?:const|function|async function)\s+)(\w+)/g)].map(m=>m[1]));
for(const n of ['file','setFile','index','setIndex','bundle','setBundle','source','setSource','resultFocus','setFocus','jobs','models','selection','notice','runOpen','live','exampleEntries','runContent','rawMetrics','bundleMetrics','indexMetrics','runLetters','indexQuality','focusResult','resultTarget','fmt'])exposed.add(n);
const built=await build({root,configFile:false,logLevel:'silent',resolve:{conditions:['browser']},plugins:[{
 name:'result-lifecycle',enforce:'pre',resolveId(id,importer){
  if(id.endsWith('lifecycle-entry'))return '\0lifecycle-entry';if(id===control)return control;
  if(files.includes(importer?.replaceAll('\\','/'))){const key=path.posix.resolve(path.posix.dirname(importer.replaceAll('\\','/')),id).replace(/\.ts$/,'');if(imports.has(key))return '\0stub:'+key;}
 },load(id){
  if(id===control)return controlSource;
  if(id==='\0lifecycle-entry')return `export * as runs from ${JSON.stringify(files[1])};export * as design from ${JSON.stringify(files[0])};export * as state from ${JSON.stringify(control)};export * as workspace from ${JSON.stringify(root+'src/workspace.ts')};`;
  if(id.startsWith('\0stub:'))return [...imports.get(id.slice(6))].map(n=>exposed.has(n)?`export {${n}} from ${JSON.stringify(control)};`:`export const ${n}=()=>undefined;`).join('\n');
 } }],build:{write:false,minify:false,lib:{entry:'lifecycle-entry',formats:['es']}}});
globalThis.localStorage={getItem:()=>null,setItem(){}};
const code=(Array.isArray(built)?built[0]:built).output.find(x=>x.type==='chunk').code;
const {runs:r,design:d,state:s,workspace:w}=await import('data:text/javascript;base64,'+Buffer.from(code).toString('base64'));
const deferred=()=>{let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no});return{promise,resolve,reject};};
const tick=async()=>{for(let i=0;i<12;i++)await Promise.resolve();};
const fixture=JSON.parse(readFileSync(root+'public/projects/patch-antenna.json','utf8'));
const b=(name,created)=>({...structuredClone(fixture),name,created});
const entry=x=>({file:'same.json',name:x.name,model:x.model.id,created:x.created,engine:'CPU',simulated:true,bands:[],cells:1});
let checks=0;
for(const mode of ['home','design','results']){
 const p=deferred();s.ctl.indices.push(p);s.setBundle(null);const before=s.ctl.clears;
 const task=d.openExamples();w.setAppMode(mode);s.openBundle(b('new selection','new'),'new.json');p.resolve([{file:'old.json',simulated:true}]);await task;
 assert.equal(s.bundle().name,'new selection');assert.equal(s.ctl.clears,before);checks++;
}
// Navigation away and back to Results must also revoke the old request.
{const p=deferred();s.ctl.indices.push(p);s.setBundle(null);const task=d.openExamples();w.setAppMode('home');w.setAppMode('results');p.resolve([]);const before=s.ctl.clears;await task;assert.equal(s.ctl.clears,before);checks++;}
// A newer examples invocation owns its index response; stale completion cannot clear it.
{const old=deferred(),fresh=deferred(),body=deferred();s.ctl.indices.push(old,fresh);s.ctl.projects.push(body);s.setBundle(null);const a=d.openExamples(),z=d.openExamples();fresh.resolve([{file:'fresh.json',simulated:true}]);await tick();body.resolve(b('fresh','fresh'));await z;old.resolve([{file:'old.json',simulated:true}]);await a;assert.equal(s.bundle().name,'fresh');checks++;}
// Ownership predicate remains active while the example's file body is pending.
{const idx=deferred(),body=deferred();s.ctl.indices.push(idx);s.ctl.projects.push(body);s.setBundle(null);const task=d.openExamples();idx.resolve([{file:'old.json',simulated:true}]);await tick();w.setAppMode('design');s.openBundle(b('new design','new'),'new.json');body.resolve(b('old result','old'));await task;assert.equal(s.bundle().name,'new design');checks++;}
const requests=[];globalThis.fetch=url=>{const response=deferred();requests.push({url,...response});return response.promise;};
const reply=(request,bundle)=>request.resolve({ok:true,json:async()=>bundle});
w.setAppMode('home');s.setFile({id:'model-file',design:{model:{id:fixture.model.id}}});await tick();
const old=b('old','2026-10-10T01:00:00Z'),fresh=b('fresh','2026-10-11T01:00:00Z');
s.setIndex([entry(old)]);d.setDesignResult({file:'same.json',bundle:old});r.ensureDesignRunBundles();assert.equal(r.designRunBundle('same.json').name,'old');
s.setIndex([entry(fresh)]);assert.equal(r.designRunBundle('same.json'),undefined,'obsolete cached metadata hidden immediately');r.ensureDesignRunBundles();const first=requests.at(-1);d.setDesignResult({file:'same.json',bundle:fresh});r.ensureDesignRunBundles();reply(first,fresh);await tick();assert.equal(r.designRunBundle('same.json').name,'fresh');assert.equal(r.runMetricsOf('same.json').name,'fresh');checks++;
// Old in-flight data cannot overwrite a newer generation, nor delete its shared request.
d.setDesignResult(null);s.setIndex([entry(old)]);const before=requests.length;const stale=r.loadRunBundle('same.json').then(()=>false,()=>true);const oldRequest=requests.at(-1);
s.setIndex([entry(fresh)]);const active=r.loadRunBundle('same.json');const freshRequest=requests.at(-1);reply(oldRequest,old);assert.equal(await stale,true);assert.equal(r.loadRunBundle('same.json'),active);assert.equal(requests.length,before+2);reply(freshRequest,fresh);assert.equal((await active).name,'fresh');checks++;
// A stale response from disk itself is refused even when the request's index stays current.
{const task=r.loadRunBundle('same.json').then(()=>false,()=>true);reply(requests.at(-1),old);assert.equal(await task,true);checks++;}
// Same-second CPU/GPU replacements still have distinct identity; backend labels match the index writer.
for(const [engine,os,log] of [['CUDA','Windows',['Create FDTD engine (GPU, backend: CUDA (test))']],['Metal','Darwin',[]],['GPU','Linux',[]]]){
 const gpu={...fresh,run:{...fresh.run,engine:'gpu',host:{...fresh.run.host,os},log_tail:log}};
 s.setIndex([{...entry(fresh),engine}]);
 const rejected=r.loadRunBundle('same.json').then(()=>false,()=>true);reply(requests.at(-1),fresh);assert.equal(await rejected,true,'old same-second CPU bytes rejected');
 const accepted=r.loadRunBundle('same.json');reply(requests.at(-1),gpu);assert.equal((await accepted).run.engine,'gpu');checks++;
}
// Tree reads can overlap generations; late old completion cannot restore old content/quality.
s.setIndex([entry(old)]);const oldRead=r.readRunContent('same.json'),oldTree=requests.at(-1);s.setIndex([entry(fresh)]);const freshRead=r.readRunContent('same.json'),freshTree=requests.at(-1);assert.notEqual(oldTree,freshTree);reply(freshTree,fresh);await freshRead;reply(oldTree,old);await oldRead;assert.equal(r.runContentOf('same.json').name,'fresh');assert.equal(r.runQualityOf('same.json'),'fresh');checks++;
// The metadata cache also ignores a late old callback after a newer index generation is read.
{const middle=b('middle','2026-10-12T01:00:00Z'),latest=b('latest','2026-10-13T01:00:00Z');s.setIndex([entry(middle)]);r.ensureDesignRunBundles();const obsolete=requests.at(-1);s.setIndex([entry(latest)]);r.ensureDesignRunBundles();const current=requests.at(-1);reply(current,latest);await tick();reply(obsolete,middle);await tick();assert.equal(r.designRunBundle('same.json').name,'latest');checks++;}
// Design switch revokes cache and tree loads even when returning to the same file/stamp.
{d.setDesignResult(null);s.setIndex([entry(fresh)]);const pending=r.loadRunBundle('same.json').then(()=>false,()=>true),req=requests.at(-1);s.setIndex([entry(old)]);const tree=r.readRunContent('same.json'),treeRequest=requests.at(-1);s.setFile({id:'another-file',design:{model:{id:'another'}}});await tick();reply(req,fresh);reply(treeRequest,old);await tree;assert.equal(await pending,true);assert.equal(r.designRunBundle('same.json'),undefined);assert.equal(r.runContentOf('same.json'),null);checks++;}
console.log(`Result lifecycle: ${checks} deferred navigation, replacement-cache, tree metadata and stale-response checks passed`);





