// Geometry-only patch edit measurements in a temporary workspace; no EM run.
import assert from 'node:assert/strict';
import {mkdir,writeFile} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import puppeteer from 'puppeteer-core';
import {startStack,chromePath} from './scenarios/stack.mjs';
import {Session} from './scenarios/harness.mjs';
const out=resolve(process.env.FAIRBEAM_TEST_ARTIFACTS||join(tmpdir(),`fairbeam-preview-performance-${Date.now()}`));await mkdir(out,{recursive:true});
const stack=await startStack({log:console.log});let browser;
try{
 browser=await puppeteer.launch({headless:true,executablePath:await chromePath(),args:['--no-sandbox','--enable-unsafe-swiftshader','--use-angle=swiftshader']});
 const page=await browser.newPage();await page.setViewport({width:1400,height:1000});
 const s=new Session(page,{lang:'en',scenario:'preview-performance',url:stack.url});
 const requests=[],pending=[];const starts=new Map();
 page.on('request',request=>{if(new URL(request.url()).pathname==='/api/preview'&&request.method()==='POST'){
  const record={at:performance.now(),body:JSON.parse(request.postData()),status:'pending'};requests.push(record);starts.set(request,record);
 }});
 page.on('requestfailed',request=>{const record=starts.get(request);if(record){record.status='aborted';record.elapsedMs=performance.now()-record.at;}});
 page.on('response',response=>{const record=starts.get(response.request());if(record)pending.push((async()=>{record.status=response.status();record.elapsedMs=performance.now()-record.at;try{const b=await response.json();record.buildSeconds=b.build_s;record.serverElapsedSeconds=b.elapsed_s;}catch{}})());});
 await page.goto(stack.url,{waitUntil:'domcontentloaded'});await s.wait('.home');
 await page.evaluate(async()=>{const r=await fetch('/api/designs',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({id:'preview_perf',name:'Preview performance patch',template:'patch'})});if(!r.ok)throw new Error(await r.text());});
 await s.ev((_,m)=>m.r.refreshModels(),null,{r:'/src/runner/store.ts'});
 await page.locator('[data-home-design="preview_perf"] .home-item').click();await s.wait('.rb');
 await s.waitFor(async()=>{const m=await import('/src/runner/store.ts');return m.previewState()==='ready';},null,{timeout:30000});
 await s.ev((_,m)=>m.d.openParametersTab(),null,{d:'/src/designer/dockState.ts'});await s.wait('.param-table');
 const fieldId=await s.store((_,m)=>m.s.fieldId('params[1].default'));
 const selector=`.param-dock #${fieldId}`;await s.wait(selector);
 const cdp=await page.createCDPSession();await cdp.send('Performance.enable');
 const metrics=async()=>Object.fromEntries((await cdp.send('Performance.getMetrics')).metrics.map(m=>[m.name,m.value]));
 const snapshot=()=>s.store((_,m)=>({draft:JSON.parse(JSON.stringify(m.s.draft)),undo:m.s.canUndo(),dirty:m.s.dirty(),steps:m.s.historySteps().length}));
 const settle=async()=>{await s.sleep(600);await s.waitFor(async()=>{const m=await import('/src/runner/store.ts');return m.previewState()==='ready'||m.previewState()==='error';},null,{timeout:30000});await Promise.all(pending);};
 await settle();requests.length=0;
 const initial=await snapshot(),before=await metrics(),t0=performance.now();
 await page.focus(selector);await page.keyboard.press('End');await page.keyboard.type('.0',{delay:400});
 assert.equal(await page.$eval(selector,e=>e.value),'32.0','input keeps the literal text while focused');
 await page.keyboard.press('Tab');await settle();
 const after=await metrics(),sameValue=await snapshot();
 const unchanged={wallMs:performance.now()-t0,taskSeconds:after.TaskDuration-before.TaskDuration,requestCount:requests.length,requests:structuredClone(requests),before:initial,after:sameValue};
 assert.deepEqual(sameValue.draft,initial.draft,'trailing decimal does not change numeric design');
  assert.equal(unchanged.requestCount,0,'unchanged parsed values need no server geometry build');
  assert.equal(sameValue.undo,initial.undo,'equivalent numeric text adds no undo entry');
  assert.equal(sameValue.steps,initial.steps,'equivalent numeric text adds no history step');
  const inspectorSelector=`.dw-right #${fieldId}`;
  await page.focus(inspectorSelector);await page.keyboard.press('End');await page.keyboard.type('.0',{delay:300});
  assert.equal(await page.$eval(inspectorSelector,e=>e.value),'32.0');await page.keyboard.press('Tab');await settle();
  assert.equal(requests.length,0,'parameter inspector also ignores unchanged parsed values');
  assert.deepEqual(await snapshot(),initial,'parameter inspector preserves history and draft');
 requests.length=0;const fastBefore=await metrics(),fastT0=performance.now();
 await s.fill(selector,'34.5');await settle();const fastAfter=await metrics(),changed=await snapshot();
 const typing={wallMs:performance.now()-fastT0,taskSeconds:fastAfter.TaskDuration-fastBefore.TaskDuration,requestCount:requests.length,requests:structuredClone(requests),width:changed.draft.params[1].default};
 assert.equal(typing.width,34.5);assert.equal(typing.requestCount,1,'fast typing sends one final preview');
  const rendered=await s.ev((_,m)=>{
    const b=m.r.draftPreview(),part=b.parts.find(p=>p.name==='patch');
    return {parameter:b.model.params.find(p=>p.key==='W').value,width:part.bbox[1][0]-part.bbox[0][0],state:m.r.previewState()};
  },null,{r:'/src/runner/store.ts'});
  assert.deepEqual(rendered,{parameter:34.5,width:34.5,state:'ready'},'finished preview shows the latest actual patch geometry');
  // Change back in the other editor after the documented typing-coalescing window:
  // this is a new edit, unlike spelling the current value with a trailing decimal.
  await s.sleep(1600);requests.length=0;
  await s.fill(inspectorSelector,'32');await settle();
  const back=await snapshot();
  assert.equal(back.draft.params[1].default,32);
  assert.equal(requests.length,1,'a real change back to the initial value still rebuilds');
  assert.equal(back.steps,changed.steps+1,'separate value edit has its own undo step');
  await s.store((_,m)=>m.s.undo());await settle();
  assert.equal((await snapshot()).draft.params[1].default,34.5,'undo restores the immediately preceding value');
  await s.store((_,m)=>m.s.redo());await settle();
  assert.equal((await snapshot()).draft.params[1].default,32,'redo restores the return edit');
  const transitions=[];
  for(const editor of ['.param-dock','.dw-right']){
   const targetFor=async key=>`${editor} #${await s.store((key,m)=>m.s.fieldId(`params[1].${key}`),key)}`;
   requests.length=0;
   await s.fill(await targetFor('default'),'16 * 2');await settle();
   const expression=(await snapshot()).draft.params[1];
   assert.equal(expression.expr,'16 * 2');assert.equal(Object.hasOwn(expression,'default'),false);
   assert.equal(requests.length,1,'an equal-valued expression is still a semantic design change');
   assert.equal(await s.store((_,m)=>m.s.names().names.W),32);
   assert.equal(await s.ev((_,m)=>{const p=m.r.draftPreview().parts.find(p=>p.name==='patch');return p.bbox[1][0]-p.bbox[0][0];},null,{r:'/src/runner/store.ts'}),32,'derived expression controls the native geometry');
   requests.length=0;
   await s.fill(await targetFor('expr'),'32');await settle();
   const numeric=(await snapshot()).draft.params[1];
   assert.equal(numeric.default,32);assert.equal(Object.hasOwn(numeric,'expr'),false);
   assert.equal(requests.length,1,'expression to number updates the persisted parameter type');
   await s.fill(await targetFor('default'),'NaN');await settle();
   assert.equal((await snapshot()).draft.params[1].expr,'NaN','invalid text remains an expression, not silent numeric NaN');
   const invalid=await s.store((_,m)=>({error:m.s.names().errors.W,checks:m.s.checks().filter(c=>c.severity==='error')}));
   assert.ok(invalid.error,'unknown NaN identifier has a parameter evaluation error');
   assert.ok(invalid.checks.length,'invalid expression remains visibly actionable in Checks');
   await s.fill(await targetFor('expr'),'32');await settle();
   assert.equal(await s.store((_,m)=>m.s.names().errors.W),undefined,'correcting invalid text clears evaluation failure');
   const recovered=await s.ev((_,m)=>({state:m.r.previewState(),width:m.r.draftPreview().model.params.find(p=>p.key==='W').value}),null,{r:'/src/runner/store.ts'});
   assert.deepEqual(recovered,{state:'ready',width:32},'valid correction rebuilds current geometry');
   transitions.push({editor,expression:expression.expr,numeric:numeric.default,invalidError:invalid.error,recovered});
  }
  const result={scope:'Geometry-only Windows Chromium software-rendered patch; task time includes checks/UI/render, not EM throughput.',unchanged,typing,rendered,returnEdit:{width:back.draft.params[1].default,steps:back.steps,undoRestored:34.5,redoRestored:32},transitions};
 await writeFile(join(out,'result.json'),JSON.stringify(result,null,2));await page.screenshot({path:join(out,'patch-after-typing.png')});
 console.log(JSON.stringify({out,unchanged:{requests:unchanged.requestCount,taskSeconds:unchanged.taskSeconds,undoBefore:initial.undo,undoAfter:sameValue.undo,stepsBefore:initial.steps,stepsAfter:sameValue.steps},typing:{requests:typing.requestCount,taskSeconds:typing.taskSeconds}},null,2));
}catch(error){await writeFile(join(out,'failure.txt'),error.stack||String(error));throw error;}finally{await browser?.close();await stack.stop();}
