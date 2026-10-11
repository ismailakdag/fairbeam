// Two pages in one browser context share localStorage but own their unsaved draft backups.
// Uses a temporary server workspace and actual UI edits/recovery; no solver.
import assert from 'node:assert/strict';
import {mkdir,writeFile} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {tmpdir} from 'node:os';
import puppeteer from 'puppeteer-core';
import {startStack,chromePath} from './scenarios/stack.mjs';
import {Session} from './scenarios/harness.mjs';
const out=resolve(process.env.FAIRBEAM_TEST_ARTIFACTS||join(tmpdir(),`fairbeam-shared-backup-${Date.now()}`));await mkdir(out,{recursive:true});
const stack=await startStack({log:console.log});let browser;const results=[];
try{
 browser=await puppeteer.launch({headless:true,executablePath:await chromePath(),args:['--no-sandbox','--enable-unsafe-swiftshader','--use-angle=swiftshader']});console.log(`Owned PIDs: ${stack.pids.join(', ')}`);
 for(const lang of (process.argv.includes('--lang')?[process.argv[process.argv.indexOf('--lang')+1]]:['en','tr'])){
  const context=await browser.createBrowserContext();
  const make=async()=>{const page=await context.newPage();await page.setViewport({width:1400,height:1000});await page.evaluateOnNewDocument(language=>localStorage.setItem('fairbeam.generalSettings',JSON.stringify({language})),lang);const s=new Session(page,{lang,scenario:'shared-backup',url:stack.url});await page.goto(stack.url,{waitUntil:'domcontentloaded'});await s.wait('.home');return s;};
  const a=await make();await a.fill(await a.field(await a.T('home.newProject.name')),`Shared backup ${lang}`,{blur:false});await a.click('home.newProject.create');await a.wait('.rb');
  const initial=await a.store((_,m)=>JSON.parse(JSON.stringify(m.s.file())));
  const b=await make();await b.page.locator(`[data-home-design="${initial.id}"] .home-item`).click();await b.wait('.rb');
  const backups=()=>a.page.evaluate(id=>Object.entries(localStorage).filter(([k])=>k.startsWith('fairbeam:draft:v3:')).map(([key,value])=>({key,...JSON.parse(value)})).filter(v=>v.id===id),initial.id);
  const snapshot=s=>s.store((_,m)=>JSON.parse(JSON.stringify(m.s.draft)));
  const disk=()=>a.page.evaluate(async id=>(await(await fetch(`/api/designs/${id}`)).json()),initial.id);
  console.log(`${lang}: editing A`);await a.page.bringToFront();await a.fill(await a.field(await a.T('props.description')),'Unsaved window A');console.log(`${lang}: editing B`);await b.page.bringToFront();await b.fill(await b.field(await b.T('props.description')),'Unsaved window B');
  await a.waitFor(id=>Object.entries(localStorage).filter(([k,v])=>k.startsWith('fairbeam:draft:v3:')&&JSON.parse(v).id===id).length===2,initial.id);
  const before=await backups(),backupB=before.find(x=>x.design.model.description==='Unsaved window B');assert.ok(backupB);assert.equal(new Set(before.map(x=>x.owner)).size,2);
  const draftB=await snapshot(b);assert.deepEqual((await disk()).design,initial.design,'draft edits have not touched disk');
  console.log(`${lang}: saving A`);await a.page.bringToFront();await a.click('ribbon.tab.home',{sel:'.rb-tab'});await a.click('common.save',{sel:'.rb-btn'});await a.waitFor(async()=>!(await import('/src/designer/store.ts')).dirty());
  const after=await backups();assert.ok(after.some(x=>x.key===backupB.key&&x.design.model.description==='Unsaved window B'),'saving A keeps B recovery');assert.deepEqual(await snapshot(b),draftB);
  const diskA=await disk();assert.equal(diskA.design.model.description,'Unsaved window A');
  console.log(`${lang}: reloading B`);await b.page.bringToFront();const accept=dialog=>void dialog.accept();b.page.on('dialog',accept);try{await b.page.reload({waitUntil:'domcontentloaded'});await b.wait('.rb');}finally{b.page.off('dialog',accept);}
  await b.wait(`[data-recovery-owner="${backupB.owner}"]`);assert.equal(await b.store((_,m)=>m.s.dirty()),false);assert.equal((await snapshot(b)).model.description,'Unsaved window A','new page reads saved state until explicit recovery');
  const visibleNotice=await b.page.$eval(`[data-recovery-owner="${backupB.owner}"]`,e=>e.textContent);
  const expectedTime=await b.page.evaluate(({at,lang})=>new Date(at).toLocaleString(lang==='tr'?'tr-TR':'en-GB',{dateStyle:'medium',timeStyle:'short'}),{at:backupB.at,lang});
  assert.ok(visibleNotice.includes(expectedTime),'recovery timestamp follows the app language');
  await b.page.screenshot({path:join(out,`recovery-choice-${lang}.png`)});
  console.log(`${lang}: explicitly restoring B`);await b.click('store.restoreBackup',{within:`[data-recovery-owner="${backupB.owner}"]`});await b.waitFor(async()=>(await import('/src/designer/store.ts')).draft.model.description==='Unsaved window B');
  assert.deepEqual(await snapshot(b),draftB);assert.equal(await b.store((_,m)=>m.s.dirty()),true);assert.deepEqual(await disk(),diskA,'Restore changes only current draft');
  await b.page.screenshot({path:join(out,`recovery-restored-${lang}.png`)});
  await b.click('ribbon.tab.home',{sel:'.rb-tab'});await b.click('ribbon.home.undo',{sel:'.rb-btn'});assert.deepEqual(await snapshot(b),diskA.design,'one Undo restores current saved document');
  assert.ok((await backups()).some(x=>x.key===backupB.key),'a clean page still cannot delete another owner backup');
  results.push({lang,owners:before.map(x=>x.owner),saveAPreservesB:true,reloadRequiresChoice:true,restoreExactlyB:true,diskUntouchedByRecovery:true,oneUndoRestoresSaved:true});await context.close();
 }
 await writeFile(join(out,'result.json'),JSON.stringify(results,null,2));console.log(JSON.stringify({out,results},null,2));
}finally{await browser?.close();await stack.stop();}
