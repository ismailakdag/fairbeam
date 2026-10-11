// Real Home UI against an isolated server/workspace. No simulation or user's projects.
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import puppeteer from 'puppeteer-core';
import { startStack, chromePath } from './scenarios/stack.mjs';
import { Session, auditInPage } from './scenarios/harness.mjs';

const artifacts = resolve(process.env.FAIRBEAM_TEST_ARTIFACTS || join(tmpdir(), `fairbeam-home-actions-${Date.now()}`));
await mkdir(artifacts, { recursive: true });
const baseline = process.env.FAIRBEAM_EXPECT_HOME_DEFECTS === '1';
const stack = await startStack({ log: console.log });
let browser;
const results = [];
try {
  browser = await puppeteer.launch({ headless: true, executablePath: await chromePath(), args: ['--no-sandbox', '--enable-unsafe-swiftshader', '--use-angle=swiftshader'] });
  for (const [lang, width] of [['en', 1280], ['tr', 768]]) {
    const context = await browser.createBrowserContext(), page = await context.newPage();
    await page.setViewport({ width, height: 900 });
    await page.evaluateOnNewDocument(language => localStorage.setItem('fairbeam.generalSettings', JSON.stringify({ language })), lang);
    const s = new Session(page, { lang, scenario: 'home-project-actions', url: stack.url });
    const a = `home_a_${lang}`, b = `home_b_${lang}`;
    const names = [`Alpha ${lang} ${'long design name '.repeat(4)}`.slice(0, 80).trim(), `Beta ${lang}`];
    for (const [id, name] of [[a, names[0]], [b, names[1]]]) {
      const r = await fetch(`${stack.apiUrl}/api/designs`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id, name, template: 'empty' }) });
      assert.ok(r.ok, await r.text());
    }
    await page.goto(stack.url, { waitUntil: 'domcontentloaded' });
    const row = id => `[data-home-design="${id}"]`;
    await s.wait(row(a));
    const search = '.home-design-search input';
    await s.fill(search, 'no-such-design-unique');
    assert.equal(await page.$('#home-design-list'), null);
    assert.ok(await s.find('[role=status]', await s.T('home.designs.noMatches')));
    await s.fill(search, '');
    await page.select('.home-design-sort select', 'name');
    const sorted = await page.$$eval('[data-home-design]', rows => rows.map(r => r.dataset.homeDesign));
    assert.ok(sorted.indexOf(a) < sorted.indexOf(b));
    await page.locator(`#home-delete-${a}`).click();
    await s.wait(`#home-keep-${a}`);
    await page.waitForFunction(id => document.activeElement?.id === `home-keep-${id}`, {}, a);
    await page.keyboard.press('Escape');
    await page.waitForFunction(id => document.activeElement?.id === `home-delete-${id}`, {}, a);
    assert.ok((await fetch(`${stack.apiUrl}/api/designs/${a}`)).ok, 'cancel preserves the saved project');
    const visual = await page.evaluate(auditInPage, '.home');
    await page.screenshot({ path: join(artifacts, `home-${lang}-${width}.png`), fullPage: true });

    // Removing a focused favorite from the filtered list must leave keyboard focus useful.
    await page.locator(`[data-home-favorite="${a}"]`).click();
    await page.locator(`[data-home-favorite="${b}"]`).click();
    await page.locator('.home-favorites-only').click();
    await page.focus(`[data-home-favorite="${a}"]`);
    await page.keyboard.press('Enter');
    await s.gone(row(a));
    if (!baseline) await page.waitForFunction(id => document.activeElement?.id === `home-favorite-${id}`, {}, b);
    await page.focus(`[data-home-favorite="${b}"]`);
    await page.keyboard.press('Enter');
    await s.gone(row(b));
    if (!baseline) await page.waitForFunction(() => document.activeElement?.id === 'home-favorites-only');
    const favoriteFocus = await page.evaluate(() => ({ tag: document.activeElement?.tagName, cls: document.activeElement?.className }));
    if (baseline) assert.equal(favoriteFocus.tag, 'BODY', 'reproduce lost keyboard focus');
    else assert.ok(await page.$eval('.home-favorites-only', e => e === document.activeElement), 'empty favorites returns focus to filter');
    await page.locator('.home-favorites-only').click();

    // Hold the first real design read while a later rename dialog opens and receives typing.
    let held, failSave = false;
    await page.setRequestInterception(true);
    const intercept = async request => {
      const path = new URL(request.url()).pathname;
      if (!held && path === `/api/designs/${a}` && request.method() === 'GET') { held = request; return; }
      if (failSave && path === `/api/designs/${b}/rename`) { await request.respond({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'Temporary test server failure' }) }); return; }
      await request.continue();
    };
    page.on('request', intercept);
    await page.locator(`[data-home-rename="${a}"]`).click();
    for (let i = 0; !held && i < 100; i++) await new Promise(r => setTimeout(r, 30));
    assert.ok(held);
    await page.locator(`[data-home-rename="${b}"]`).click();
    await s.wait('#home-rename-name');
    const typed = `Unsubmitted name ${lang}`;
    await s.fill('#home-rename-name', typed, { blur: false });
    await held.continue();
    await page.waitForNetworkIdle({ idleTime: 400 });
    const afterLateRead = await page.$eval('#home-rename-name', e => e.value);
    if (baseline) assert.equal(afterLateRead, names[0], 'reproduce stale request replacing typed rename');
    else {
      assert.equal(afterLateRead, typed, 'late earlier read cannot replace newer typed name');
      assert.ok(await page.$eval('#home-rename-name', e => e === document.activeElement), 'late read cannot steal editing focus');
    }
    await page.screenshot({ path: join(artifacts, `rename-${lang}-${width}.png`) });
    if (baseline) {
      await s.click('common.cancel', { within: '.home-rename-dialog' });
      await page.locator(`[data-home-rename="${b}"]`).click();
      await s.wait('#home-rename-name');
      await s.fill('#home-rename-name', typed);
    }
    failSave = true;
    await s.click('home.designs.renameSave', { within: '.home-rename-dialog' });
    await s.wait('.home-rename-dialog .rp-error', 'Temporary test server failure');
    assert.equal(await page.$eval('#home-rename-name', e => e.value), typed, 'failed save keeps typed name');
    failSave = false;
    await s.click('home.designs.renameSave', { within: '.home-rename-dialog' });
    await s.gone('.home-rename-dialog');
    const saved = await (await fetch(`${stack.apiUrl}/api/designs/${b}`)).json();
    assert.equal(saved.design.model.name, typed, 'retry persists name');
    await s.click('ribbon.home.undo', { within: '.home-design-action-note' });
    await s.waitFor(async id => (await (await fetch(`/api/designs/${id}`)).json()).design.model.name.startsWith('Beta'), b);
    results.push({ lang, width, visual, favoriteFocus, afterLateRead, failedSavePreservesInput: true, retryAndUndo: true });
    await context.close();
  }
  await writeFile(join(artifacts, 'result.json'), JSON.stringify({ baseline, results }, null, 2));
  console.log(JSON.stringify({ baseline, results, artifacts }, null, 2));
} finally { await browser?.close(); await stack.stop(); }
