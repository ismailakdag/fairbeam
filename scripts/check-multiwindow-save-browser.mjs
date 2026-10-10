// Two actual browser contexts sharing one isolated run server. No solver or saved-user-data writes.
import assert from 'node:assert/strict';
import {mkdir,writeFile} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {tmpdir} from 'node:os';
import puppeteer from 'puppeteer-core';
import {startStack,chromePath} from './scenarios/stack.mjs';
import {Session} from './scenarios/harness.mjs';
const out=resolve(process.env.FAIRBEAM_TEST_ARTIFACTS||join(tmpdir(),`fairbeam-save-conflict-${Date.now()}`));
await mkdir(out,{recursive:true});
const stack=await startStack({log:console.log});let browser;const results=[];
try{
 browser=await puppeteer.launch({headless:true,executablePath:await chromePath(),args:['--no-sandbox','--enable-unsafe-swiftshader','--use-angle=swiftshader']});
 console.log(`Owned stack PIDs: ${stack.pids.join(', ')}`);
 for(const lang of ['en','tr']){
  console.log(`Starting ${lang} two-window conflict check`);
  const contexts=[];
  const make=async()=>{
   const context=await browser.createBrowserContext();contexts.push(context);
   const page=await context.newPage();await page.setViewport({width:1400,height:1000});
   await page.evaluateOnNewDocument(language=>localStorage.setItem('fairbeam.generalSettings',JSON.stringify({language})),lang);
   const s=new Session(page,{lang,scenario:'save-conflict',url:stack.url});s.consoleAllow.push(/Failed to load resource:.*409/);
   await page.goto(stack.url,{waitUntil:'domcontentloaded'});await s.wait('.home');return s;
  };
  const a=await make();await a.fill(await a.field(await a.T('home.newProject.name')),`Conflict ${lang}`,{blur:false});
  await a.click('home.newProject.create');await a.wait('.rb');
  const initial=await a.store((_,m)=>JSON.parse(JSON.stringify(m.s.file())));
  const b=await make();await b.page.locator(`[data-home-design="${initial.id}"] .home-item`).click();await b.wait('.rb');
  assert.equal(await b.store((_,m)=>m.s.file().hash),initial.hash);
  const snapshot=s=>s.store((_,m)=>JSON.parse(JSON.stringify(m.s.draft)));
  const disk=()=>a.page.evaluate(async id=>{const r=await fetch(`/api/designs/${id}`);if(!r.ok)throw new Error(await r.text());return r.json();},initial.id);
  const save=async(s,status)=>{
   await s.click('ribbon.tab.home',{sel:'.rb-tab'});
   const response=s.page.waitForResponse(r=>r.request().method()==='PUT'&&new URL(r.url()).pathname===`/api/designs/${initial.id}`);
   await s.click('common.save',{sel:'.rb-btn'});const r=await response;assert.equal(r.status(),status);
   await s.waitFor(async()=>!(await import('/src/designer/store.ts')).saving());return r.json();
  };
  await a.fill(await a.field(await a.T('props.description')),'Window A saved description');
  await b.fill(await b.field(await b.T('props.description')),'Window B unsaved description');
  const bDraft=await snapshot(b), aSaved=await save(a,200);
  assert.equal((await disk()).design.model.description,'Window A saved description');
  const rejected=await save(b,409);assert.equal(rejected.current_hash,aSaved.hash);
  await b.wait('.dw-right .dz-msg',await b.T('store.conflict'));
  assert.deepEqual(await snapshot(b),bDraft);assert.equal(await b.store((_,m)=>m.s.dirty()),true);
  const savedBeforeCancel=await disk();
  // Optimizer preparation saves the draft but never starts a solver. It must not
  // implicitly accept a previous conflict on behalf of the user.
  const prepareResult=await b.ev((_,m)=>m.run.prepareDesignOptimize(),null,{run:'/src/runner/designRun.ts'});
  const afterPrepare=await disk();
  await writeFile(join(out,`automatic-save-${lang}.json`),JSON.stringify({before:savedBeforeCancel,after:afterPrepare,prepareResult},null,2));
  assert.deepEqual(afterPrepare,savedBeforeCancel,'automatic optimizer preparation must not overwrite the winning disk version');
  assert.deepEqual(await snapshot(b),bDraft);assert.equal(await b.store((_,m)=>m.s.dirty()),true);
  await b.click('common.close',{sel:'.rb-btn'});await b.wait('[role=dialog]');
  const leaveResponse=b.page.waitForResponse(r=>r.request().method()==='PUT'&&new URL(r.url()).pathname===`/api/designs/${initial.id}`);
  await b.click('common.save',{within:'[role=dialog]',exact:true});assert.equal((await leaveResponse).status(),409);
  await b.wait('[role=dialog] .dz-msg',await b.T('store.conflict'));
  assert.deepEqual(await disk(),savedBeforeCancel,'navigation Save cannot accept a previous conflict');
  assert.deepEqual(await snapshot(b),bDraft);
  await b.click('common.cancel',{within:'[role=dialog]'});await b.gone('[role=dialog]');
  assert.deepEqual(await snapshot(b),bDraft);assert.equal(await b.store((_,m)=>m.s.dirty()),true);
  assert.deepEqual(await disk(),savedBeforeCancel,'Cancel leaves the winning disk version unchanged');
  await b.page.screenshot({path:join(out,`conflict-preserved-${lang}.png`)});
  await b.click('common.close',{sel:'.rb-btn'});await b.wait('[role=dialog]');
  await b.click('closeProject.dontSave',{within:'[role=dialog]'});await b.wait('.home');
  await b.page.locator(`[data-home-design="${initial.id}"] .home-item`).click();await b.wait('.rb');
  assert.deepEqual(await snapshot(b),savedBeforeCancel.design);
  assert.equal(await b.store((_,m)=>m.s.dirty()),false);assert.equal(await b.store((_,m)=>m.s.conflict()),null);
  assert.deepEqual(await disk(),savedBeforeCancel,'explicit discard/reopen reads rather than overwrites the winner');
  await b.page.screenshot({path:join(out,`conflict-reloaded-${lang}.png`)});
  // The warning's deliberate Save-again flow still works, conditional on the latest conflict hash.
  await a.fill(await a.field(await a.T('props.description')),'Window A newer saved description');
  await b.fill(await b.field(await b.T('props.description')),'Window B explicitly overwrites');
  await save(a,200);await save(b,409);await save(b,200);
  assert.equal((await disk()).design.model.description,'Window B explicitly overwrites');
  assert.equal(await b.store((_,m)=>m.s.dirty()),false);assert.equal(await b.store((_,m)=>m.s.conflict()),null);
  results.push({lang,initialHash:initial.hash,winnerHash:aSaved.hash,rejectedStatus:409,automaticOptimizeCannotOverwrite:true,navigationSaveCannotOverwrite:true,cancelPreservesDraftAndDisk:true,explicitDiscardReopenRestoresWinner:true,explicitSaveAgainWorks:true});
  for(const s of [a,b])assert.deepEqual(s.consoleIssues.filter(issue=>!s.consoleAllow.some(pattern=>pattern.test(issue))),[],'no unexpected browser errors');
  for(const context of contexts)await context.close();console.log(`${lang}: two-window conflict, Cancel and explicit discard/reopen passed`);
 }
 await writeFile(join(out,'result.json'),JSON.stringify({results,scope:'Two independent browser contexts, real isolated server, sequential stale saves. Backend thread tests cover simultaneous check/write races.'},null,2));
 console.log(JSON.stringify({out,results},null,2));
}catch(error){await writeFile(join(out,'failure.txt'),error.stack||String(error));throw error;}
finally{await browser?.close();await stack.stop();}

