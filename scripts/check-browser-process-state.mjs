// Bounded owned-browser process-tree checks: mock Windows/POSIX helpers plus owned Node children; no browser started.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  inspectOwnedBrowserState,
  parsePosixDurationMs,
  parsePosixPsOutput,
  probeSignalZero,
  sanitizeNodeChildState,
  sanitizeOwnedBrowserSnapshot,
  sanitizeProcessName,
} from './scenarios/browser-process-state.mjs';

async function realOwnedTreeSelfTest() {
  if (process.platform !== 'darwin' && process.platform !== 'linux' && process.platform !== 'win32') return;
  const root = await mkdtemp(join(tmpdir(), 'fairbeam-process-state-test-'));
  const script = join(root, 'owned-tree-fixture.mjs');
  await writeFile(script, `
import { spawn } from 'node:child_process';
setTimeout(() => process.exit(73), 10000).unref();
if (process.argv[2] === 'leaf') {
  process.send({ leafPid: process.pid });
  process.once('message', () => process.exit(0));
} else {
  const leaf = spawn(process.execPath, [process.argv[1], 'leaf'], { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
  leaf.once('message', ({ leafPid }) => process.send({ childPid: process.pid, leafPid }));
  process.once('message', () => {
    try { leaf.send('stop'); } catch { try { leaf.kill(); } catch {} }
    leaf.once('close', () => process.exit(0));
  });
}
`);
  let child;
  let closed;
  try {
    child = spawn(process.execPath, [script, 'root'], { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
    closed = new Promise(resolveClose => child.once('close', resolveClose));
    const { childPid, leafPid } = await new Promise((resolveReady, rejectReady) => {
      child.once('error', rejectReady);
      child.once('message', payload => {
        child.removeListener('error', rejectReady);
        resolveReady(payload);
      });
    });
    assert.equal(childPid, child.pid);
    assert.equal(probeSignalZero(child.pid), 'alive');
    assert.equal(probeSignalZero(leafPid), 'alive');

    const snapshot = inspectOwnedBrowserState(child.pid, { expectedParentPid: process.pid, trigger: 'before-kill' });
    assert.equal(snapshot.status, 'inspected');
    assert.equal(snapshot.signalZero, 'alive');
    assert.equal(snapshot.trigger, 'before-kill');
    assert.equal(snapshot.ownedPid, child.pid);
    assert.equal(snapshot.expectedParentPid, process.pid);
    assert.equal(snapshot.root.pid, child.pid);
    assert.equal(snapshot.root.ppid, process.pid);
    assert.equal(snapshot.root.depth, 0);
    assert.equal(snapshot.root.name, sanitizeProcessName(process.execPath));
    assert(snapshot.root.workingSetBytes > 0);
    assert(snapshot.children.some(entry => entry.pid === leafPid && entry.ppid === child.pid && entry.depth === 1));
    assert.doesNotMatch(JSON.stringify(snapshot), /owned-tree-fixture|fairbeam-process-state-test/);

    const mismatch = inspectOwnedBrowserState(child.pid, { expectedParentPid: child.pid + 99999, trigger: 'launch-catch' });
    assert.equal(mismatch.status, 'parent-mismatch');
    assert.equal(mismatch.root, null);
    assert.deepEqual(mismatch.children, []);

    child.send('stop');
    await closed;
    assert.equal(probeSignalZero(child.pid), 'esrch');
    const exited = inspectOwnedBrowserState(child.pid, { expectedParentPid: process.pid });
    assert.equal(exited.status, 'not-running');
    assert.equal(exited.signalZero, 'esrch');
  } finally {
    if (child && child.exitCode === null && child.signalCode === null) {
      try { child.kill(); } catch { /* already gone */ }
    }
    if (closed) await closed;
    assert.equal(resolve(dirname(root)), resolve(tmpdir()));
    assert(basename(root).startsWith('fairbeam-process-state-test-'));
    await rm(root, { recursive: true, force: true });
  }
}

export async function browserProcessStateSelfTest() {
  let killCalls = 0;
  for (const invalid of [0, -1, 1.5, NaN, null, undefined, '123']) {
    assert.equal(probeSignalZero(invalid, () => { killCalls++; }), 'invalid');
  }
  assert.equal(killCalls, 0);
  assert.equal(probeSignalZero(42, (target, sig) => { assert.equal(target, 42); assert.equal(sig, 0); }), 'alive');
  assert.equal(probeSignalZero(42, () => { throw Object.assign(new Error('secret'), { code: 'ESRCH' }); }), 'esrch');
  assert.equal(probeSignalZero(42, () => { throw Object.assign(new Error('secret'), { code: 'EPERM' }); }), 'eperm');
  assert.equal(probeSignalZero(42, () => { throw new Error('token=secret'); }), 'error');

  assert.equal(sanitizeProcessName('chrome.exe'), 'chrome.exe');
  assert.equal(sanitizeProcessName('chrome_crashpad_handler.exe'), 'chrome_crashpad_handler.exe');
  assert.equal(sanitizeProcessName('C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'), 'chrome.exe');
  assert.equal(sanitizeProcessName('/usr/local/bin/chromium'), 'chromium');
  for (const unsafe of [
    '', null, 42, 'x'.repeat(65),
    'chrome.exe --user-data-dir=C:\\Users\\alice',
    'https://user:pass@example.test/chrome.exe',
    'ws://127.0.0.1:9222/devtools/browser/secret-id',
    'blob:private-id',
    '\\\\server\\share\\chrome.exe',
    'vite password=secret',
    'Bearer secret-token',
    'Google Chrome --headless',
  ]) {
    assert.equal(sanitizeProcessName(unsafe), null, `Must reject ${String(unsafe)}`);
  }

  assert.equal(parsePosixDurationMs('00:00'), 0);
  assert.equal(parsePosixDurationMs('0:00.05'), 50);
  assert.equal(parsePosixDurationMs('01:02:03'), ((60 + 2) * 60 + 3) * 1000);
  assert.equal(parsePosixDurationMs('2-03:04:05.25'), (((2 * 24 + 3) * 60 + 4) * 60 + 5) * 1000 + 250);
  assert.equal(parsePosixDurationMs('invalid'), null);

  assert.deepEqual(sanitizeNodeChildState({ exitCode: 21, signalCode: 'SIGTERM', killed: true, secret: 'token=x' }),
    { exitCode: 21, signalCode: 'SIGTERM', killed: true });
  assert.deepEqual(sanitizeNodeChildState({ exitCode: '21', signalCode: 'bad signal!', killed: 'yes' }),
    { exitCode: null, signalCode: null, killed: false });

  const dirtySnapshot = sanitizeOwnedBrowserSnapshot({
    scope: 'tampered',
    trigger: 'before-kill',
    platform: 'win32',
    status: 'inspected',
    ownedPid: 500,
    expectedParentPid: 100,
    signalZero: 'alive',
    inspectionMs: 37,
    commandLine: '--user-data-dir=C:\\Users\\secret',
    wsEndpoint: 'ws://127.0.0.1:9222/devtools/browser/secret',
    env: { TOKEN: 'secret-env' },
    root: {
      pid: 500, ppid: 100, depth: 0,
      name: 'C:\\Users\\secret-profile\\chrome.exe',
      commandLine: '--remote-debugging-port=0',
      threadCount: 24, handleCount: 512, workingSetBytes: 65536, userCpuMs: 40, kernelCpuMs: 20, ageMs: 29990,
    },
    children: Array.from({ length: 20 }, (_, index) => ({
      pid: 600 + index, ppid: 500, depth: 1,
      name: index === 0 ? 'chrome_crashpad_handler.exe' : 'chrome.exe --type=renderer',
      args: ['--secret'], threadCount: 8, handleCount: 120, workingSetBytes: 32768, userCpuMs: 10, kernelCpuMs: 5, ageMs: 29900,
    })),
  }, { atMs: 30001, nodeChild: { exitCode: null, signalCode: null, killed: false, raw: 'secret' } });
  assert.equal(dirtySnapshot.scope, 'owned-browser-process-tree');
  assert.equal(dirtySnapshot.root.name, 'chrome.exe');
  assert.equal(dirtySnapshot.root.totalCpuMs, 60);
  assert.equal(dirtySnapshot.children.length, 16);
  assert.equal(dirtySnapshot.childCount, 20);
  assert.equal(dirtySnapshot.omittedChildren, 4);
  assert.equal(dirtySnapshot.children[0].name, 'chrome_crashpad_handler.exe');
  assert.equal(dirtySnapshot.children[1].name, null);
  assert.doesNotMatch(JSON.stringify(dirtySnapshot), /secret|commandLine|wsEndpoint|user-data-dir|remote-debugging|9222|TOKEN/);

  // Windows PowerShell execution contract: bounded timeout, literal env PID, no CommandLine/ExecutablePath query.
  let winCalls = 0;
  const winChildren = Array.from({ length: 18 }, (_, i) => ({
    pid: 2000 + i, ppid: i === 17 ? 2000 : 1500,
    name: i === 0 ? 'chrome_crashpad_handler.exe' : 'chrome.exe',
    threadCount: 6 + i, handleCount: 100 + i, workingSetBytes: 1048576 * (i + 1),
    userCpuMs: 15, kernelCpuMs: 5, ageMs: 29500,
  }));
  const winSpawn = (executable, args, options) => {
    winCalls++;
    assert.match(executable, /WindowsPowerShell[\\/]v1\.0[\\/]powershell\.exe$/);
    assert.equal(options.windowsHide, true);
    assert.equal(options.timeout, 2000, 'Clamp excessive timeoutMs to <= 2000 ms');
    assert.equal(options.maxBuffer, 32768);
    assert.equal(options.env.FAIRBEAM_OWNED_BROWSER_PID, '1500');
    assert.equal(args.join(' ').includes('1500'), false, 'Never interpolate PID into PowerShell source');
    assert.doesNotMatch(args.at(-1), /CommandLine|ExecutablePath/i);
    return {
      status: 0,
      stdout: JSON.stringify({
        found: true,
        processes: [
          { pid: 1500, ppid: 900, name: 'chrome.exe', threadCount: 31, handleCount: 740, workingSetBytes: 52428800, userCpuMs: 110, kernelCpuMs: 70, ageMs: 29995 },
          { pid: 7777, ppid: 1, name: 'unrelated-secret-host.exe', threadCount: 4, handleCount: 50, workingSetBytes: 4096, userCpuMs: 1, kernelCpuMs: 1, ageMs: 99999 },
          ...winChildren,
        ],
      }),
    };
  };
  const winResult = inspectOwnedBrowserState(1500, {
    platform: 'win32', expectedParentPid: 900, trigger: 'before-kill', timeoutMs: 99999,
    killImpl: () => true, spawnSyncImpl: winSpawn, env: { SystemRoot: 'C:\\Windows', SECRET_TOKEN: 'never-serialize' },
  });
  assert.equal(winCalls, 1);
  assert.equal(winResult.status, 'inspected');
  assert.equal(winResult.root.pid, 1500);
  assert.equal(winResult.root.totalCpuMs, 180);
  assert.equal(winResult.children.length, 16);
  assert.equal(winResult.childCount, 18);
  assert.equal(winResult.omittedChildren, 2);
  assert(winResult.children.every(child => child.pid !== 7777));
  assert.doesNotMatch(JSON.stringify(winResult), /unrelated-secret-host|never-serialize/);

  // PowerShell 5.1 single-object unwrap quirk + parent-mismatch fail-closed behavior.
  const unwrapped = inspectOwnedBrowserState(1500, {
    platform: 'win32', expectedParentPid: 900, killImpl: () => true,
    spawnSyncImpl: () => ({ status: 0, stdout: JSON.stringify({ found: true, processes: { pid: 1500, ppid: 900, name: 'chrome.exe', threadCount: 12, handleCount: 210, workingSetBytes: 8192, userCpuMs: 0, kernelCpuMs: 10, ageMs: 30000 } }) }),
  });
  assert.equal(unwrapped.status, 'inspected');
  assert.equal(unwrapped.children.length, 0);

  const parentMismatch = inspectOwnedBrowserState(1500, {
    platform: 'win32', expectedParentPid: 900, killImpl: () => true,
    spawnSyncImpl: () => ({ status: 0, stdout: JSON.stringify({ found: true, processes: [{ pid: 1500, ppid: 4, name: 'recycled.exe' }] }) }),
  });
  assert.equal(parentMismatch.status, 'parent-mismatch');
  assert.equal(parentMismatch.root, null);
  assert.doesNotMatch(JSON.stringify(parentMismatch), /recycled/);

  assert.equal(inspectOwnedBrowserState(1500, {
    platform: 'win32', expectedParentPid: 900, killImpl: () => true,
    spawnSyncImpl: () => ({ status: 0, stdout: '{"found":false,"processes":[]}' }),
  }).status, 'not-running');
  assert.equal(inspectOwnedBrowserState(1500, {
    platform: 'win32', expectedParentPid: 900, killImpl: () => true,
    spawnSyncImpl: () => ({ error: Object.assign(new Error('timed out secret'), { code: 'ETIMEDOUT' }) }),
  }).status, 'timeout');
  const parseFailed = inspectOwnedBrowserState(1500, {
    platform: 'win32', expectedParentPid: 900, killImpl: () => true,
    spawnSyncImpl: () => ({ status: 0, stdout: 'not-json Bearer secret-shell-output' }),
  });
  assert.equal(parseFailed.status, 'parse-error');
  assert.doesNotMatch(JSON.stringify(parseFailed), /secret-shell-output/);
  assert.equal(inspectOwnedBrowserState(1500, {
    platform: 'win32', expectedParentPid: 900, killImpl: () => true,
    spawnSyncImpl: () => { throw new Error('spawnSync secret'); },
  }).status, 'unavailable');

  // Linux ps parser with thread counts.
  const linuxRows = parsePosixPsOutput(
    '  100    50   19  40960 00:30 00:00:01 /opt/google/chrome/chrome\n' +
    '  101   100    6  12288 00:29 00:00:00 /opt/google/chrome/chrome_crashpad_handler\n',
    { hasThreadCount: true },
  );
  assert.equal(linuxRows.length, 2);
  assert.equal(linuxRows[0].threadCount, 19);
  assert.equal(linuxRows[0].workingSetBytes, 40960 * 1024);

  await realOwnedTreeSelfTest();
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await browserProcessStateSelfTest();
  console.log('Browser process state: signal-zero liveness, parent verification, bounded tree snapshot and allowlist checks passed; no browser launched.');
}
