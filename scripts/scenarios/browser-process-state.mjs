// Bounded, read-only OS metadata for an owned browser PID. Never retain command lines, paths, URLs or env vars.
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';

const MAX_TIMEOUT_MS = 2000;
const DEFAULT_TIMEOUT_MS = 1500;
const MAX_CHILDREN_CAP = 16;
const MAX_SCAN_ROWS = 4096;
const MAX_TREE_DEPTH = 3;

const SNAPSHOT_STATUSES = new Set([
  'inspected', 'not-running', 'not-found', 'parent-mismatch', 'invalid-pid',
  'timeout', 'command-failed', 'parse-error', 'unsupported-platform', 'unavailable',
]);
const SIGNAL_ZERO_STATES = new Set(['alive', 'esrch', 'eperm', 'invalid', 'error']);
const TRIGGERS = new Set(['before-kill', 'launch-catch', 'manual']);

const WINDOWS_PROCESS_TREE_SCRIPT = [
  '$ErrorActionPreference="Stop";',
  '$target=[int]$env:FAIRBEAM_OWNED_BROWSER_PID;',
  '$now=Get-Date;',
  '$all=@(Get-CimInstance -ClassName Win32_Process -Property ProcessId,ParentProcessId,Name,ThreadCount,HandleCount,WorkingSetSize,KernelModeTime,UserModeTime,CreationDate);',
  '$root=$all|Where-Object{[int]$_.ProcessId -eq $target}|Select-Object -First 1;',
  'if($null -eq $root){ConvertTo-Json -InputObject @{found=$false;processes=@()} -Compress -Depth 4;exit 0}',
  '$selected=@($root);$seen=@{$target=$true};$frontier=@($target);',
  'for($d=1;$d -le 3 -and $frontier.Count -gt 0 -and $selected.Count -lt 65;$d++){',
  '$next=@();foreach($p in $all){$id=[int]$p.ProcessId;$ppid=$(if($null -ne $p.ParentProcessId){[int]$p.ParentProcessId}else{-1});',
  'if(-not $seen.ContainsKey($id) -and ($frontier -contains $ppid)){$seen[$id]=$true;$selected+=$p;$next+=$id;if($selected.Count -ge 65){break}}}',
  '$frontier=$next}',
  '$rows=@(foreach($p in $selected){@{',
  'pid=[int]$p.ProcessId;',
  'ppid=$(if($null -ne $p.ParentProcessId){[int]$p.ParentProcessId}else{$null});',
  'name=[string]$p.Name;',
  'threadCount=$(if($null -ne $p.ThreadCount){[int]$p.ThreadCount}else{$null});',
  'handleCount=$(if($null -ne $p.HandleCount){[int]$p.HandleCount}else{$null});',
  'workingSetBytes=$(if($null -ne $p.WorkingSetSize){[int64]$p.WorkingSetSize}else{$null});',
  'userCpuMs=$(if($null -ne $p.UserModeTime){[int64][math]::Floor([double]$p.UserModeTime/10000)}else{$null});',
  'kernelCpuMs=$(if($null -ne $p.KernelModeTime){[int64][math]::Floor([double]$p.KernelModeTime/10000)}else{$null});',
  'ageMs=$(if($null -ne $p.CreationDate){[math]::Max([int64]0,[int64][math]::Floor(($now-[datetime]$p.CreationDate).TotalMilliseconds))}else{$null})',
  '}});',
  'ConvertTo-Json -InputObject @{found=$true;processes=$rows} -Compress -Depth 4',
].join(' ');

const positiveInt = value => Number.isSafeInteger(value) && value > 0 ? value : null;
const nonNegativeInt = value => Number.isSafeInteger(value) && value >= 0 ? value : null;

export function probeSignalZero(targetPid, killImpl = process.kill) {
  if (!positiveInt(targetPid)) return 'invalid';
  try {
    killImpl(targetPid, 0);
    return 'alive';
  } catch (error) {
    if (error?.code === 'ESRCH') return 'esrch';
    if (error?.code === 'EPERM') return 'eperm';
    return 'error';
  }
}

export function sanitizeProcessName(value) {
  if (typeof value !== 'string' || !value || value.length > 260) return null;
  const withoutDrive = /^[A-Za-z]:[\\/]/.test(value) ? value.slice(2) : value;
  if (/[\r\n\0="'`?#@;:()]|--|=|\/\/|\\\\/.test(withoutDrive)) return null;
  const base = withoutDrive.slice(Math.max(withoutDrive.lastIndexOf('/'), withoutDrive.lastIndexOf('\\')) + 1);
  return /^[A-Za-z0-9._-]{1,64}$/.test(base) ? base : null;
}

export function parsePosixDurationMs(value) {
  if (typeof value !== 'string') return null;
  const match = /^(?:(\d{1,5})-)?(?:(\d{1,3}):)?(\d{1,2}):(\d{2})(?:\.(\d{1,3}))?$/.exec(value.trim());
  if (!match) return null;
  const days = match[1] ? Number(match[1]) : 0;
  const hours = match[2] ? Number(match[2]) : 0;
  const minutes = Number(match[3]);
  const seconds = Number(match[4]);
  const fraction = match[5] ? Number(match[5].padEnd(3, '0')) : 0;
  const total = (((days * 24 + hours) * 60 + minutes) * 60 + seconds) * 1000 + fraction;
  return nonNegativeInt(total);
}

export function sanitizeProcessNode(node, defaultDepth = 0) {
  if (!node || typeof node !== 'object') return null;
  const processId = positiveInt(node.pid);
  if (!processId) return null;
  const depth = nonNegativeInt(node.depth) ?? nonNegativeInt(defaultDepth) ?? 0;
  if (depth > MAX_TREE_DEPTH) return null;
  const userCpuMs = nonNegativeInt(node.userCpuMs);
  const kernelCpuMs = nonNegativeInt(node.kernelCpuMs);
  const explicitTotal = nonNegativeInt(node.totalCpuMs);
  const summedCpu = userCpuMs !== null && kernelCpuMs !== null ? nonNegativeInt(userCpuMs + kernelCpuMs) : null;
  return {
    pid: processId,
    ppid: nonNegativeInt(node.ppid),
    depth,
    name: sanitizeProcessName(node.name),
    threadCount: nonNegativeInt(node.threadCount),
    handleCount: nonNegativeInt(node.handleCount),
    workingSetBytes: nonNegativeInt(node.workingSetBytes),
    userCpuMs,
    kernelCpuMs,
    totalCpuMs: explicitTotal ?? summedCpu,
    ageMs: nonNegativeInt(node.ageMs),
  };
}

export function sanitizeNodeChildState(value) {
  if (!value || typeof value !== 'object') return null;
  return {
    exitCode: Number.isInteger(value.exitCode) ? value.exitCode : null,
    signalCode: typeof value.signalCode === 'string' && /^[A-Z0-9]{1,16}$/.test(value.signalCode) ? value.signalCode : null,
    killed: value.killed === true,
  };
}

export function sanitizeOwnedBrowserSnapshot(snapshot, { atMs = null, nodeChild = null, maxChildren = MAX_CHILDREN_CAP } = {}) {
  if (!snapshot || typeof snapshot !== 'object') return null;
  const boundedMax = Number.isSafeInteger(maxChildren) ? Math.min(Math.max(1, maxChildren), MAX_CHILDREN_CAP) : MAX_CHILDREN_CAP;
  const rawChildren = Array.isArray(snapshot.children) ? snapshot.children.slice(0, MAX_SCAN_ROWS) : [];
  const validChildren = [];
  for (const entry of rawChildren) {
    const sanitized = sanitizeProcessNode(entry, 1);
    if (sanitized && sanitized.depth >= 1) validChildren.push(sanitized);
  }
  const children = validChildren.slice(0, boundedMax);
  const reportedChildCount = nonNegativeInt(snapshot.childCount);
  const childCount = reportedChildCount !== null && reportedChildCount >= validChildren.length ? reportedChildCount : validChildren.length;
  const omittedChildren = Math.max(nonNegativeInt(snapshot.omittedChildren) ?? 0, childCount - children.length);
  const resolvedNodeChild = sanitizeNodeChildState(nodeChild ?? snapshot.nodeChild);
  const resolvedAtMs = nonNegativeInt(atMs ?? snapshot.atMs);
  const result = {
    scope: 'owned-browser-process-tree',
    trigger: TRIGGERS.has(snapshot.trigger) ? snapshot.trigger : 'manual',
    platform: typeof snapshot.platform === 'string' && /^[a-z0-9_-]{1,20}$/i.test(snapshot.platform) ? snapshot.platform : 'unknown',
    status: SNAPSHOT_STATUSES.has(snapshot.status) ? snapshot.status : 'unavailable',
    ownedPid: positiveInt(snapshot.ownedPid),
    expectedParentPid: positiveInt(snapshot.expectedParentPid),
    signalZero: SIGNAL_ZERO_STATES.has(snapshot.signalZero) ? snapshot.signalZero : 'error',
    inspectionMs: nonNegativeInt(snapshot.inspectionMs),
    root: sanitizeProcessNode(snapshot.root, 0),
    children,
    childCount,
    omittedChildren,
  };
  if (resolvedAtMs !== null) result.atMs = resolvedAtMs;
  if (resolvedNodeChild !== null || Object.hasOwn(snapshot, 'nodeChild') || nodeChild !== null) result.nodeChild = resolvedNodeChild;
  return result;
}

function buildOwnedProcessTree(rawRows, ownedPid, expectedParentPid, maxChildren) {
  const byPid = new Map();
  for (const row of rawRows.slice(0, MAX_SCAN_ROWS)) {
    if (!row || typeof row !== 'object') continue;
    const processId = positiveInt(row.pid);
    if (!processId || byPid.has(processId)) continue;
    byPid.set(processId, row);
  }
  const rootRow = byPid.get(ownedPid);
  if (!rootRow) return { status: 'not-found', root: null, children: [], childCount: 0, omittedChildren: 0 };
  const rootPpid = nonNegativeInt(rootRow.ppid);
  if (expectedParentPid !== null && rootPpid !== expectedParentPid) {
    return { status: 'parent-mismatch', root: null, children: [], childCount: 0, omittedChildren: 0 };
  }
  const root = sanitizeProcessNode({ ...rootRow, depth: 0 }, 0);
  if (!root) return { status: 'parse-error', root: null, children: [], childCount: 0, omittedChildren: 0 };
  const visited = new Set([ownedPid]);
  let frontier = [ownedPid];
  const descendants = [];
  for (let depth = 1; depth <= MAX_TREE_DEPTH && frontier.length > 0 && visited.size < 256; depth++) {
    const parentSet = new Set(frontier);
    const level = [];
    for (const [candidatePid, row] of byPid) {
      if (visited.has(candidatePid)) continue;
      if (parentSet.has(nonNegativeInt(row.ppid))) level.push(row);
    }
    level.sort((a, b) => a.pid - b.pid);
    const nextFrontier = [];
    for (const row of level) {
      if (visited.size >= 256) break;
      visited.add(row.pid);
      const node = sanitizeProcessNode({ ...row, depth }, depth);
      if (node) {
        descendants.push(node);
        nextFrontier.push(node.pid);
      }
    }
    frontier = nextFrontier;
  }
  const children = descendants.slice(0, maxChildren);
  return {
    status: 'inspected',
    root,
    children,
    childCount: descendants.length,
    omittedChildren: Math.max(0, descendants.length - children.length),
  };
}

export function parsePosixPsOutput(stdout, { hasThreadCount = false } = {}) {
  if (typeof stdout !== 'string') return null;
  const rows = [];
  const pattern = hasThreadCount
    ? /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(\S+)\s+(.+)$/
    : /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(\S+)\s+(.+)$/;
  for (const line of stdout.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const match = pattern.exec(line);
    if (!match) continue;
    const rssKiB = nonNegativeInt(Number(hasThreadCount ? match[4] : match[3]));
    rows.push({
      pid: Number(match[1]),
      ppid: Number(match[2]),
      threadCount: hasThreadCount ? Number(match[3]) : null,
      handleCount: null,
      workingSetBytes: rssKiB !== null ? nonNegativeInt(rssKiB * 1024) : null,
      userCpuMs: null,
      kernelCpuMs: null,
      totalCpuMs: parsePosixDurationMs(hasThreadCount ? match[6] : match[5]),
      ageMs: parsePosixDurationMs(hasThreadCount ? match[5] : match[4]),
      name: (hasThreadCount ? match[7] : match[6]).trim(),
    });
    if (rows.length >= MAX_SCAN_ROWS) break;
  }
  return rows.length ? rows : null;
}

export function inspectOwnedBrowserState(ownedPid, {
  platform = process.platform,
  expectedParentPid = process.pid,
  trigger = 'manual',
  timeoutMs = DEFAULT_TIMEOUT_MS,
  maxChildren = MAX_CHILDREN_CAP,
  spawnSyncImpl = spawnSync,
  killImpl = process.kill,
  env = process.env,
} = {}) {
  const started = Date.now();
  const boundedTimeout = Number.isSafeInteger(timeoutMs) ? Math.min(Math.max(100, timeoutMs), MAX_TIMEOUT_MS) : DEFAULT_TIMEOUT_MS;
  const boundedChildren = Number.isSafeInteger(maxChildren) ? Math.min(Math.max(1, maxChildren), MAX_CHILDREN_CAP) : MAX_CHILDREN_CAP;
  const validOwnedPid = positiveInt(ownedPid);
  const validParentPid = expectedParentPid === null ? null : positiveInt(expectedParentPid);
  const signalZero = probeSignalZero(validOwnedPid, killImpl);
  const snapshot = {
    scope: 'owned-browser-process-tree',
    trigger: TRIGGERS.has(trigger) ? trigger : 'manual',
    platform: typeof platform === 'string' && /^[a-z0-9_-]{1,20}$/i.test(platform) ? platform : 'unknown',
    status: 'unavailable',
    ownedPid: validOwnedPid,
    expectedParentPid: validParentPid,
    signalZero,
    inspectionMs: 0,
    root: null,
    children: [],
    childCount: 0,
    omittedChildren: 0,
  };
  try {
    if (!validOwnedPid || (expectedParentPid !== null && !validParentPid)) {
      snapshot.status = 'invalid-pid';
    } else if (signalZero === 'esrch') {
      snapshot.status = 'not-running';
    } else if (platform === 'win32') {
      const executable = join(env?.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
      const response = spawnSyncImpl(executable, ['-NoProfile', '-NonInteractive', '-Command', WINDOWS_PROCESS_TREE_SCRIPT], {
        windowsHide: true,
        timeout: boundedTimeout,
        maxBuffer: 32768,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
        env: { ...env, FAIRBEAM_OWNED_BROWSER_PID: String(validOwnedPid) },
      });
      if (response?.error) {
        snapshot.status = response.error.code === 'ETIMEDOUT' ? 'timeout' : 'command-failed';
      } else if (response?.status !== 0 || typeof response.stdout !== 'string') {
        snapshot.status = 'command-failed';
      } else {
        let parsed;
        try { parsed = JSON.parse(response.stdout); } catch { parsed = null; }
        if (!parsed || typeof parsed !== 'object') {
          snapshot.status = 'parse-error';
        } else if (parsed.found === false) {
          snapshot.status = 'not-running';
        } else {
          const rawList = Array.isArray(parsed.processes) ? parsed.processes : parsed.processes ? [parsed.processes] : [];
          Object.assign(snapshot, buildOwnedProcessTree(rawList, validOwnedPid, validParentPid, boundedChildren));
        }
      }
    } else if (platform === 'linux' || platform === 'darwin') {
      const hasThreadCount = platform === 'linux';
      const args = hasThreadCount
        ? ['-ax', '-o', 'pid=,ppid=,nlwp=,rss=,etime=,time=,comm=']
        : ['-ax', '-o', 'pid=,ppid=,rss=,etime=,time=,comm='];
      const response = spawnSyncImpl('ps', args, {
        windowsHide: true,
        timeout: boundedTimeout,
        maxBuffer: 512 * 1024,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      });
      if (response?.error) {
        snapshot.status = response.error.code === 'ETIMEDOUT' ? 'timeout' : 'command-failed';
      } else if (response?.status !== 0 || typeof response.stdout !== 'string') {
        snapshot.status = 'command-failed';
      } else {
        const rows = parsePosixPsOutput(response.stdout, { hasThreadCount });
        if (!rows) snapshot.status = 'parse-error';
        else Object.assign(snapshot, buildOwnedProcessTree(rows, validOwnedPid, validParentPid, boundedChildren));
      }
    } else {
      snapshot.status = 'unsupported-platform';
    }
  } catch {
    snapshot.status = 'unavailable';
    snapshot.root = null;
    snapshot.children = [];
    snapshot.childCount = 0;
    snapshot.omittedChildren = 0;
  }
  snapshot.inspectionMs = Math.max(0, Date.now() - started);
  return sanitizeOwnedBrowserSnapshot(snapshot, { maxChildren: boundedChildren });
}
