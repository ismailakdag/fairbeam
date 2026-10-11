// Magnitude-only measurements never acquire an invented phase in plots or exports.
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {importReference} from '../src/import/reference.ts';
import {compareSParams, compareSParamQuantities, traces} from '../src/compare/series.ts';
import {copyResultData, exportResultCsv, resultDataTable} from '../src/designer/resultData.ts';
import {exportResultTouchstone} from '../src/designer/resultTouchstone.ts';
import {touchstoneS1p, touchstoneNPort} from '../src/export/touchstone.ts';
import {hasSParameterPhase} from '../src/lib/sparams.ts';
const project=JSON.parse(readFileSync(new URL('../public/projects/inset-patch.json',import.meta.url),'utf8'));
const ref=importReference('magnitude.csv','Frequency (GHz),S11 Magnitude (dB)\n2,-10\n3,-20',project);
const complex=importReference('complex.csv','Frequency (GHz),S11 Real,S11 Imaginary\n2,0.1,0.2\n3,0.2,0.1',project);
const tr=traces(project,[ref,complex]);
assert.equal(hasSParameterPhase(ref),false);assert.equal(hasSParameterPhase(complex),true);
assert.equal(compareSParams(tr,[[1,1]],'db').series.length,3);
assert.equal(compareSParams(tr,[[1,1]],'phase').series.length,2);
for(const format of ['plot','db','db_phase','re_im','mag_phase','all'])for(const mode of ['db','phase']){
 const groups=compareSParamQuantities(tr,[[1,1]],format,mode);
 for(const group of groups){
  assert.equal(group.series.some(s=>s.label.includes('magnitude.csv')),['db','mag'].includes(group.key),`${format}/${mode}/${group.key}`);
  assert.ok(group.series.some(s=>s.label.includes('complex.csv')),'measured complex reference remains');
 }
}
const db=resultDataTable(ref,'sparams',undefined,{format:'db'});
assert.ok(Math.abs(db.rows[0][1]+10)<1e-12);assert.ok(Math.abs(db.rows[1][1]+20)<1e-12);
const all=resultDataTable(ref,'sparams',undefined,{format:'all'});
assert.deepEqual(all.rows[0].slice(2,5),[null,null,null],'unknown phase and RI cells stay missing');
assert.equal(resultDataTable(ref,'smith').rows.length,0);
assert.equal(resultDataTable(ref,'smith',undefined,{smithPort:1}).rows.length,0);
assert.equal(resultDataTable(ref,'impedance').rows.length,0);
const descriptor=Object.getOwnPropertyDescriptor(globalThis,'navigator');let copied='unchanged';
Object.defineProperty(globalThis,'navigator',{configurable:true,value:{clipboard:{writeText:async text=>{copied=text;}}}});
try{
 const runs=[{file:'project.json',bundle:project},{file:'reference.csv',bundle:ref}];
 for(const format of ['db_phase','re_im','mag_phase','all']){
  const result=await copyResultData(project,'sparams',undefined,runs,{format});
  assert.equal(result.ok,false);assert.match(result.message,/phase data is missing/);assert.equal(copied,'unchanged');
  await assert.rejects(exportResultCsv(project,'sparams','blocked.csv',undefined,runs,{format}),/phase data is missing/);
 }
 assert.equal((await copyResultData(ref,'sparams',undefined,undefined,{sparamMode:'phase'})).ok,false);
 assert.equal((await copyResultData(ref,'smith')).ok,false);
 assert.equal((await copyResultData(ref,'sparams',undefined,undefined,{format:'db'})).ok,true);
 assert.ok(copied.includes('|S11| (dB)'));assert.ok(!copied.includes('∠'));
 assert.equal((await copyResultData(complex,'sparams',undefined,undefined,{format:'all'})).ok,true);
}finally{if(descriptor)Object.defineProperty(globalThis,'navigator',descriptor);else delete globalThis.navigator;}
assert.equal(touchstoneS1p(ref),null);assert.equal(touchstoneNPort(ref),null);
assert.ok(touchstoneS1p(complex));
await assert.rejects(exportResultTouchstone(ref,'blocked'),/phase data is missing/);
await assert.rejects(exportResultTouchstone(project,'blocked',[{file:'a',bundle:project},{file:'b',bundle:ref}]),/phase data is missing/);
console.log('Magnitude-only reference: magnitude preserved; phase/RI/Smith omitted; complex clipboard, CSV and Touchstone blocked; complex references retained.');
