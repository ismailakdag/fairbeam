// Production bundle + browser regression for the on-demand simulation-settings dialog.
// Isolated copied workspace; no solver. Set FAIRBEAM_PYTHON and optionally FAIRBEAM_TEST_ARTIFACTS.
import assert from 'node:assert/strict';
import { build } from 'vite';
import { gzipSync } from 'node:zlib';
import { createServer } from 'node:http';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import puppeteer from 'puppeteer-core';
import { chromePath, root, startStack } from './scenarios/stack.mjs';
import { Session } from './scenarios/harness.mjs';

const artifacts = resolve(process.env.FAIRBEAM_TEST_ARTIFACTS || join(tmpdir(), `fairbeam-sim-settings-${Date.now()}`));
await mkdir(artifacts, { recursive: true });
delete process.env.FAIRBEAM_REPORT;
const result = await build({ build: { write: false }, logLevel: 'silent' });
const output = (Array.isArray(result) ? result : [result]).flatMap(r => r.output);
const chunks = new Map(output.filter(c => c.type === 'chunk').map(c => [c.fileName, c]));
const closure = new Set();
function walk(name) {
  if (closure.has(name)) return;
  closure.add(name);
  for (const dependency of chunks.get(name).imports) walk(dependency);
}
// Include both the entry and the immediately imported app, and each static dependency once.
for (const c of chunks.values()) if (c.isEntry || c.fileName.includes('/start-')) walk(c.fileName);
const initial = [...closure].map(file => ({ file, bytes: Buffer.byteLength(chunks.get(file).code), gzip: gzipSync(chunks.get(file).code).length }));
const metrics = { chunks: initial, bytes: initial.reduce((s, c) => s + c.bytes, 0), gzip: initial.reduce((s, c) => s + c.gzip, 0) };
const dialog = [...chunks.values()].find(c => Object.keys(c.modules).some(id => id.endsWith('/SimSettingsDialog.tsx')));
assert.ok(dialog, 'production output contains simulation settings');
assert.ok(!closure.has(dialog.fileName), 'simulation settings is outside the initial static closure');
await writeFile(join(artifacts, 'bundle.json'), JSON.stringify(metrics, null, 2));
const assets = new Map(output.map(c => [c.fileName, c.type === 'chunk' ? c.code : c.source]));
const stack = await startStack({ log: console.log });
let browser;
const outcomes = [];
const server = createServer(async (req, res) => {
  try {
    const path = new URL(req.url, 'http://localhost').pathname.slice(1) || 'index.html';
    const body = assets.get(path);
    if (body !== undefined) {
      const type = path.endsWith('.js') ? 'text/javascript' : path.endsWith('.css') ? 'text/css' : path.endsWith('.html') ? 'text/html' : 'application/octet-stream';
      res.writeHead(200, { 'Content-Type': type }); res.end(body); return;
    }
    const received = [];
    for await (const part of req) received.push(part);
    const upstream = await fetch(new URL(req.url, stack.url), { method: req.method, ...(req.method !== 'GET' && req.method !== 'HEAD' ? { body: Buffer.concat(received) } : {}), headers: { 'content-type': req.headers['content-type'] || 'application/json' } });
    res.writeHead(upstream.status, { 'Content-Type': upstream.headers.get('content-type') || 'application/octet-stream' });
    res.end(Buffer.from(await upstream.arrayBuffer()));
  } catch (error) { res.writeHead(500); res.end(String(error)); }
});
try {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${server.address().port}/`;
  browser = await puppeteer.launch({ headless: true, executablePath: await chromePath(), args: ['--no-sandbox', '--enable-unsafe-swiftshader', '--use-angle=swiftshader'] });
  for (const { lang, fault = false, slow } of [
    { lang: 'en' }, { lang: 'tr' }, { lang: 'en', fault: true },
    { lang: 'en', slow: 'cancel' }, { lang: 'tr', slow: 'escape' },
    { lang: 'en', slow: 'transition' }, { lang: 'tr', slow: 'transition' },
  ]) {
    const context = await browser.createBrowserContext();
    const page = await context.newPage();
    let releaseChunk;
    const chunkGate = new Promise(resolve => { releaseChunk = resolve; });
    if (fault || slow) {
      // A one-shot render error checks the incumbent panel recovery path, not network retries.
      const exported = dialog.code.match(/export\{([\w$]+) as default\}/);
      assert.ok(exported, 'fixture locates the production default export');
      const fixture = fault ? dialog.code.replace(exported[0], `let __failed=false;function __fixture(p){if(!__failed){__failed=true;throw new Error("sim-settings-render-fixture")}return ${exported[1]}(p)}export{__fixture as default}`) : dialog.code;
      await page.setRequestInterception(true);
      page.on('request', async request => {
        if (new URL(request.url()).pathname === `/${dialog.fileName}`) {
          if (slow) await chunkGate;
          await request.respond({ status: 200, contentType: 'text/javascript', body: fixture });
        } else await request.continue();
      });
    }
    await page.setViewport({ width: 1440, height: 1000 });
    await page.evaluateOnNewDocument(language => localStorage.setItem('fairbeam.generalSettings', JSON.stringify({ language })), lang);
    const s = new Session(page, { lang, scenario: 'sim-settings-lazy', url });
    const table = JSON.parse(await readFile(join(root, `src/i18n/${lang}.json`), 'utf8'));
    s.T = async key => table[key]; // Production UI must not import dev source modules.
    let requests = 0;
    page.on('request', request => { if (new URL(request.url()).pathname === `/${dialog.fileName}`) requests++; });
    await page.goto(url, { waitUntil: 'networkidle0' });
    await s.wait('.home');
    assert.equal(requests, 0, 'home does not download settings');
    await s.fill(await s.field(await s.T('home.newProject.name')), `Lazy settings ${lang}${fault ? ' retry' : ''}${slow ? ` ${slow}` : ''}`, { blur: false });
    await s.click('home.newProject.create'); await s.wait('.rb');
    assert.equal(requests, 0, 'entering the designer does not download settings');
    await s.click('ribbon.tab.sim', { sel: '.rb-tab' });
    await s.click('ribbon.sim.mesh', { sel: '.rb-group-toggle' }).catch(() => {});
    const trigger = await s.wait('button', await s.T('ribbon.sim.meshSettings'));
    let retried = false;
    let checkedSlow = false;
    const open = async () => {
      const toggle = await s.find('.rb-group-toggle', await s.T('ribbon.sim.mesh'));
      if (toggle && await toggle.evaluate(e => e.getAttribute('aria-expanded') !== 'true')) await toggle.click();
      await trigger.click();
      if (slow && !checkedSlow) {
        checkedSlow = true;
        await s.wait('#sim-settings-loading-title');
        assert.ok(await s.find('[role=status]', await s.T('common.loading')), 'loading has a visible localized status');
        for (let i = 0; i < 4; i++) {
          await page.keyboard.press('Tab');
          assert.ok(await page.evaluate(() => document.querySelector('[aria-labelledby="sim-settings-loading-title"]')?.contains(document.activeElement)), 'loading modal traps Tab');
        }
        await page.screenshot({ path: join(artifacts, `loading-${lang}-${slow}.png`) });
        if (slow !== 'transition') {
          if (slow === 'escape') await page.keyboard.press('Escape');
          else await s.click('common.cancel', { within: '[aria-labelledby="sim-settings-loading-title"]' });
          await s.gone('[role=dialog]');
          assert.ok(await focusRestored(), 'cancelled import restores ribbon focus');
          releaseChunk();
          await page.waitForNetworkIdle({ idleTime: 500 });
          assert.equal(await page.$('[role=dialog]'), null, 'late chunk does not reopen a cancelled dialog');
          await open();
          return;
        }
        releaseChunk();
      }
      if (fault && !retried) {
        await s.wait('[role=alertdialog]');
        assert.ok(await page.$('.rb'), 'dialog failure leaves ribbon mounted');
        await s.click('panel.reload', { within: '[role=alertdialog]' });
        retried = true;
      }
      await s.wait('#ss-title');
      await page.waitForFunction(() => document.querySelector('[aria-labelledby="ss-title"]')?.contains(document.activeElement));
      assert.equal(await page.$$eval('[role=dialog]', items => items.length), 1, 'fallback is replaced by exactly one real modal');
      await page.keyboard.press('Tab');
      assert.ok(await page.evaluate(() => document.querySelector('[aria-labelledby="ss-title"]')?.contains(document.activeElement)), 'real dialog retains focus after loading cleanup');
    };
    // A collapsed ribbon command returns focus to its visible group button.
    const focusRestored = () => trigger.evaluate(e => document.activeElement === e || document.activeElement === e.closest('.rb-group')?.querySelector('.rb-group-toggle'));
    await open();
    assert.equal(requests, 1, 'first open downloads settings exactly once');
    assert.ok(await page.$('.rb'), 'ribbon remains mounted');
    assert.ok(await page.$('.viewport'), 'scene remains mounted');
    const fmax = await s.field('f max', { within: '[role=dialog]' });
    const initialMax = await fmax.evaluate(e => e.value);
    await s.fill(fmax, String(Number(initialMax) + 0.1));
    await s.click('sim.discard', { within: '[role=dialog]' }); await s.gone('[role=dialog]');
    assert.ok(await focusRestored(), `discard restores ribbon focus (${lang}/${slow || fault || 'normal'}): ${await page.evaluate(() => document.activeElement?.outerHTML.slice(0, 600))}`);
    await open();
    assert.equal(await (await s.field('f max', { within: '[role=dialog]' })).evaluate(e => e.value), initialMax, 'discard restores frequency');
    assert.equal(requests, 1, 'reopening uses the loaded module');
    for (const key of ['sim.profile.title', 'sim.section.freq', 'sim.section.bounds', 'sim.section.mesh', 'sim.section.monitors', 'sim.section.solver']) {
      await s.click(key, { sel: '[role=tab]', within: '.ss-nav' });
      assert.ok(await page.$('.ss-nav [aria-selected=true]'), `${key} remains navigable`);
    }
    await s.click('common.ok', { within: '[role=dialog]' }); await s.gone('[role=dialog]');
    assert.ok(await focusRestored(), 'OK restores ribbon focus');
    await open();
    await page.screenshot({ path: join(artifacts, `sim-settings-${lang}${fault ? '-retry' : ''}${slow ? `-${slow}` : ''}.png`) });
    await page.keyboard.press('Escape'); await s.gone('[role=dialog]');
    assert.ok(await focusRestored(), 'Escape restores ribbon focus');
    assert.deepEqual(s.consoleIssues.filter(message => !fault || !message.includes('sim-settings-render-fixture')), [], 'no unexpected application console errors');
    outcomes.push({ language: lang, homeRequests: 0, designerRequests: 0, dialogChunkRequests: requests, discardAndFocus: 'passed', sections: 6, renderErrorRetry: fault ? 'passed' : 'not injected', slowImport: slow || 'not injected' });
    await context.close();
  }
  await writeFile(join(artifacts, 'result.json'), JSON.stringify({ metrics, dialog: dialog.fileName, outcomes }, null, 2));
  console.log(JSON.stringify({ metrics, outcomes }, null, 2));
} finally {
  await browser?.close();
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
  await stack.stop();
}
