// Isolated real-UI regression: empty design, export menu keyboard order and offline recovery.
// No solver or user workspace. FAIRBEAM_TEST_ARTIFACTS selects persistent evidence output.
import assert from 'node:assert/strict';
import {mkdir,writeFile} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import puppeteer from 'puppeteer-core';
import {startStack,chromePath} from './scenarios/stack.mjs';
import {Session} from './scenarios/harness.mjs';
import {addBrick} from './scenarios/s1-build-patch.mjs';
const out=resolve(process.env.FAIRBEAM_TEST_ARTIFACTS || join(tmpdir(),`fairbeam-new-design-export-${Date.now()}`));await mkdir(out,{recursive:true});
const stack=await startStack({log:console.log});let browser;const results=[];
try {
 browser=await puppeteer.launch({headless:true,executablePath:await chromePath(),args:['--no-sandbox','--enable-unsafe-swiftshader','--use-angle=swiftshader']});
 for(const lang of ['en','tr']) {
  const context=await browser.createBrowserContext(),page=await context.newPage();await page.setViewport({width:1280,height:900});
  await page.evaluateOnNewDocument(language=>{localStorage.setItem('fairbeam.generalSettings',JSON.stringify({language}));window.__downloads=[];const click=HTMLAnchorElement.prototype.click;HTMLAnchorElement.prototype.click=function(){window.__downloads.push({name:this.download,url:this.href});return click.call(this);};},lang);
  const s=new Session(page,{lang,scenario:'new-export',url:stack.url});
  await page.goto(stack.url,{waitUntil:'domcontentloaded'});await s.wait('.home');
  await s.fill(await s.field(await s.T('home.newProject.name')),`New export ${lang}`,{blur:false});await s.click('home.newProject.create');await s.wait('.rb');
  const camera=await s.wait('.header-secondary button',await s.T('header.screenshot.aria'),{attr:'aria-label'});assert.equal(await camera.evaluate(e=>e.disabled),true);
  const focus=()=>page.evaluate(()=>({tag:document.activeElement?.tagName,cls:document.activeElement?.className,text:document.activeElement?.textContent?.slice(0,120)}));
  await page.focus('.header-cst');await page.keyboard.press('Tab');const normalNext=await focus();
  await page.focus('.header-cst');await page.keyboard.press('ArrowDown');await s.wait('.context-export-menu');
  const emptyActions=await page.$$eval('[data-export-action]',es=>es.map(e=>({id:e.dataset.exportAction,disabled:e.disabled,title:e.title})));
  await page.keyboard.press('Tab');await s.gone('.context-export-menu');const menuNext=await focus();assert.deepEqual(menuNext,normalNext,'Tab continues from the menu trigger');
  await page.focus('.header-cst');await page.keyboard.down('Shift');await page.keyboard.press('Tab');await page.keyboard.up('Shift');const normalPrevious=await focus();
  await page.focus('.header-cst');await page.keyboard.press('ArrowDown');await s.wait('.context-export-menu');await page.keyboard.down('Shift');await page.keyboard.press('Tab');await page.keyboard.up('Shift');await s.gone('.context-export-menu');const menuPrevious=await focus();assert.deepEqual(menuPrevious,normalPrevious,'Shift+Tab continues backwards from the trigger');
  assert.equal(emptyActions.find(a=>a.id==='geometry').disabled,true);assert.equal(emptyActions.find(a=>a.id==='design-json').disabled,false);
  await page.locator('.header-cst').click();await s.wait('.context-export-menu');await page.keyboard.press('Escape');assert.equal(await page.$eval('.header-cst',e=>e===document.activeElement),true);
  await addBrick(s,{name:'Test solid',min:[0,0,0],max:[10,20,1]});await page.waitForFunction(()=>!document.querySelector('.header-secondary button[aria-label]')?.disabled);
  await camera.click();await page.waitForFunction(()=>window.__downloads.some(d=>d.url.startsWith('data:image/png')));
  await page.locator('.header-cst').click();await s.wait('.context-export-menu');await page.locator('[data-export-action="design-json"]').click();await page.waitForFunction(()=>window.__downloads.some(d=>d.name.endsWith('.design.json')));
  await s.click('ribbon.tab.post',{sel:'.rb-tab'});const noResults=await page.$$eval('.rb-toolbar .rb-btn',es=>es.filter(e=>e.getClientRects().length).map(e=>({text:e.textContent,disabled:e.disabled,title:e.title})));
  assert.ok(noResults.filter(a=>!['Python'].includes(a.text)).every(a=>a.disabled),'unavailable result actions are disabled');
  let offline=true;await page.setRequestInterception(true);page.on('request',r=>offline&&new URL(r.url()).pathname.startsWith('/api/')?r.abort('connectionfailed'):r.continue());
  await page.locator('.header-cst').click();await s.wait('.context-export-menu');await page.locator('[data-export-action="geometry"]').click();await s.wait('[role=dialog] [role=alert]');
  const offlineAlert=await page.$eval('[role=dialog] [role=alert]',e=>e.textContent);assert.ok(offlineAlert);assert.equal(await page.$eval('[role=dialog] .btn-primary',e=>e.disabled),true,'failed geometry build cannot export stale data');await page.screenshot({path:join(out,`offline-${lang}.png`)});
  offline=false;await s.click('common.retry',{within:'[role=dialog]'});await s.gone('[role=dialog] [role=alert]');await page.waitForFunction(()=>!document.querySelector('[role=dialog] .btn-primary')?.disabled);await s.click('common.close',{within:'[role=dialog]',attr:'aria-label'}).catch(()=>page.keyboard.press('Escape'));
  results.push({lang,normalNext,menuNext,normalPrevious,menuPrevious,emptyActions,noResults,offlineAlert});await context.close();
 }
 await writeFile(join(out,'result.json'),JSON.stringify(results,null,2));console.log(JSON.stringify(results,null,2));
} finally {await browser?.close();await stack.stop();}
