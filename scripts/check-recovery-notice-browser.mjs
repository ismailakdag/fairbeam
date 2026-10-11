// Recovery UI at realistic history depth, in an isolated workspace. No solver.
import assert from 'node:assert/strict';
import {mkdir,writeFile} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {tmpdir} from 'node:os';
import puppeteer from 'puppeteer-core';
import {startStack,chromePath} from './scenarios/stack.mjs';
import {Session} from './scenarios/harness.mjs';
const out=resolve(process.env.FAIRBEAM_TEST_ARTIFACTS||join(tmpdir(),`fairbeam-recovery-notice-${Date.now()}`));await mkdir(out,{recursive:true});
const stack=await startStack({log:console.log});let browser;const results=[];
try {
 browser=await puppeteer.launch({headless:true,executablePath:await chromePath(),args:['--no-sandbox','--enable-unsafe-swiftshader','--use-angle=swiftshader']});console.log('Owned PIDs',stack.pids,browser.process().pid);
 for(const lang of ['en','tr']) {
  const context=await browser.createBrowserContext(),page=await context.newPage();await page.setViewport({width:1280,height:900});
  await page.evaluateOnNewDocument(language=>localStorage.setItem('fairbeam.generalSettings',JSON.stringify({language})),lang);
  const s=new Session(page,{lang,scenario:'recovery-notice',url:stack.url});await page.goto(stack.url,{waitUntil:'domcontentloaded'});await s.wait('.home');
  await s.fill(await s.field(await s.T('home.newProject.name')),`Recovery audit ${lang}`,{blur:false});await s.click('home.newProject.create');await s.wait('.rb');
  const seed=async count=>page.evaluate(async count=>{
   const {file}=await import('/src/designer/store.ts'),f=file();
   for(let i=0;i<count;i++) {
    const version=i<16?3:2,owner=version===3?`audit-owner-${String(i).padStart(8,'0')}`:undefined,base=i%3===0?f.hash:`previous-saved-revision-${i}`,at=Date.now()-i*7200000;
    const design=JSON.parse(JSON.stringify(f.design));design.model.name=i===1?'WidebandFR4PrintedDipoleCoexistenceStudyWithRadomeAndBatteryHousing_Revision_2026_10_11':`Printed dipole — enclosure and matching revision ${i+1}`;design.model.description=`Unique unsaved variant ${i+1}`;
    const key=`fairbeam:draft:v${version}:${f.backup_scope}:${encodeURIComponent(f.id)}:${encodeURIComponent(base)}${owner?':'+encodeURIComponent(owner):''}`;
    localStorage.setItem(key,JSON.stringify({version,scope:f.backup_scope,id:f.id,base,owner,at,design}));
   }
   window.dispatchEvent(new Event('fairbeam:draft-backups-changed'));
  },count);
  await seed(1);await s.wait('.dz-recovery');assert.equal(await page.$eval('.dz-recovery',e=>e.open),true,'one draft remains immediately visible');
  await seed(20);assert.equal(await page.$$eval('[data-recovery-owner]',es=>es.length),20);await page.waitForSelector('canvas');
  for(const width of [1280,768]) {
   await page.setViewport({width,height:900});if(width===768){await page.locator('[data-layout-focus="side-strip"]').click();await s.wait('.dw-right');}
   assert.equal(await page.$eval('.dz-recovery',e=>e.open),false);
   await page.focus('.dz-recovery > summary');await page.keyboard.press('Tab');
   assert.equal(await page.evaluate(()=>document.activeElement.matches('.dw-right input')),true,'collapsed history leaves the next project field reachable in one Tab');
   await page.screenshot({path:join(out,`collapsed-${lang}-${width}.png`)});
   await page.focus('.dz-recovery > summary');await page.keyboard.press('Enter');assert.equal(await page.$eval('.dz-recovery',e=>e.open),true);
   const metrics=await page.evaluate(()=>{
    const list=document.querySelector('.dz-recovery-list'),field=document.querySelector('.dw-right input'),panel=document.querySelector('.dw-right');
    return {listHeight:list.clientHeight,listScrollHeight:list.scrollHeight,fieldY:field.getBoundingClientRect().y,panelBottom:panel.getBoundingClientRect().bottom,overflow:[...list.querySelectorAll('[data-recovery-owner]')].filter(n=>n.scrollWidth>n.clientWidth+1).length,describedButtons:[...list.querySelectorAll('button')].filter(b=>document.getElementById(b.getAttribute('aria-describedby'))).length};
   });
   assert.ok(metrics.listHeight<=360);assert.ok(metrics.listScrollHeight>metrics.listHeight);assert.ok(metrics.fieldY<metrics.panelBottom);assert.equal(metrics.overflow,0);assert.equal(metrics.describedButtons,40);
   await page.keyboard.press('Tab');assert.equal(await page.evaluate(()=>!!document.activeElement.closest('[data-recovery-owner]')),true);
   // A backup update from another page must not remount the focused action.
   assert.equal(await page.evaluate(async()=>{
    const focused=document.activeElement,key=Object.keys(localStorage).find(k=>k.endsWith('audit-owner-00000009')),record=JSON.parse(localStorage.getItem(key));record.at+=1000;
    localStorage.setItem(key,JSON.stringify(record));window.dispatchEvent(new StorageEvent('storage',{key,newValue:JSON.stringify(record),storageArea:localStorage}));await Promise.resolve();return focused===document.activeElement&&focused.isConnected;
   }),true,'unrelated backup update preserves focused action');
   assert.equal(await page.$eval('.dz-recovery',e=>e.open),true,'background update preserves the expanded list');
   await page.screenshot({path:join(out,`expanded-${lang}-${width}.png`)});
   await page.focus('.dz-recovery > summary');await page.keyboard.press('Enter');assert.equal(await page.$eval('.dz-recovery',e=>e.open),false);results.push({lang,width,...metrics});
  }
  await page.setViewport({width:1280,height:900});await page.focus('.dz-recovery > summary');await page.keyboard.press('Enter');
  await s.click('store.restoreBackup',{within:'[data-recovery-owner="audit-owner-00000009"]'});assert.equal(await s.store((_,m)=>m.s.draft.model.description),'Unique unsaved variant 10');
  await s.store((_,m)=>m.s.undo());assert.equal(await s.store((_,m)=>m.s.dirty()),false);
  assert.equal(await page.evaluate(()=>Object.keys(localStorage).filter(k=>k.startsWith('fairbeam:draft:')).length),20,'recovery/undo leaves every old record intact');
  const saved=await page.evaluate(async()=>{const f=(await import('/src/designer/store.ts')).file();return(await fetch(`/api/designs/${f.id}`)).json()});
  for(const failure of ['quota','unavailable']) {
   await page.evaluate(kind=>{
    const storageDescriptor=Object.getOwnPropertyDescriptor(window,'localStorage'),original=Storage.prototype.setItem;
    window.__restoreAuditStorage=()=>{Storage.prototype.setItem=original;Object.defineProperty(window,'localStorage',storageDescriptor)};
    if(kind==='quota')Storage.prototype.setItem=function(k,v){if(k.startsWith('fairbeam:draft:'))throw new DOMException('Private audit details','QuotaExceededError');return original.call(this,k,v)};
    else Object.defineProperty(window,'localStorage',{configurable:true,get(){throw new DOMException('Private audit details','SecurityError')}});
   },failure);
   await s.fill(await s.field(await s.T('props.description')),`Unbacked ${failure} edits`);
   await s.wait(`[data-backup-write-failure="${failure}"]`);
   const warning=await page.$eval('[data-backup-write-failure]',e=>e.textContent.trim());assert.equal(warning,await s.T(failure==='quota'?'store.backupStorageFull':'store.backupStorageUnavailable'));
   assert.ok(!warning.includes('Private audit details'));assert.equal(await s.store((_,m)=>m.s.dirty()),true);
   await page.evaluate(()=>document.querySelector('.dw-right').scrollTop=0);await page.screenshot({path:join(out,`storage-${failure}-${lang}.png`)});
   await page.evaluate(()=>{window.__restoreAuditStorage();delete window.__restoreAuditStorage});
   await s.fill(await s.field(await s.T('props.description')),`Recovered ${failure} edits`);
   await s.waitFor(async()=>{const s=await import('/src/designer/store.ts'),b=await import('/src/designer/draftBackup.ts'),f=s.file();return b.readBackup(f.id,f.hash,f.backup_scope)?.design.model.description===s.draft.model.description&&!document.querySelector('[data-backup-write-failure]')});
   assert.equal(await s.store((_,m)=>m.s.dirty()),true,'successful local backup does not pretend the project was saved');
   assert.equal(await page.evaluate(()=>Object.keys(localStorage).filter(k=>k.startsWith('fairbeam:draft:')).length),21,'all 20 old drafts survive and own latest draft is added');
   results.push({lang,failure,warningShown:true,successfulWriteClearsWarning:true,existingDraftsPreserved:true});
  }
  const after=await page.evaluate(async()=>{const f=(await import('/src/designer/store.ts')).file();return(await fetch(`/api/designs/${f.id}`)).json()});assert.deepEqual(after,saved,'local backup failure/retry does not save to disk');await context.close();
 }
 await writeFile(join(out,'result.json'),JSON.stringify(results,null,2));console.log('Recovery history EN/TR, narrow layout, keyboard, stable focus and exact undo passed:',out);
}finally{await browser?.close();await stack.stop();}
