#!/usr/bin/env node
import fs from 'fs';
import os from 'os';
import path from 'path';

const logPath = path.join(os.homedir(), '.termdock', 'fs-io.log');
const args = process.argv.slice(2);
const query = args.find((arg) => !arg.startsWith('--')) ?? '';
const sinceMinutesArg = args.find((arg) => arg.startsWith('--since-min='));
const slowMsArg = args.find((arg) => arg.startsWith('--slow-ms='));
const sinceMinutes = sinceMinutesArg ? Number(sinceMinutesArg.split('=')[1]) : 30;
const slowMs = slowMsArg ? Number(slowMsArg.split('=')[1]) : 500;
const sinceTs = Number.isFinite(sinceMinutes) && sinceMinutes > 0
  ? Date.now() - sinceMinutes * 60_000
  : 0;

if (!fs.existsSync(logPath)) {
  console.error(`No fs-io log found at ${logPath}`);
  process.exit(0);
}

const records = [];
for (const line of fs.readFileSync(logPath, 'utf8').trimEnd().split('\n').filter(Boolean)) {
  try {
    const item = JSON.parse(line);
    const ts = Date.parse(item.ts);
    if (sinceTs && Number.isFinite(ts) && ts < sinceTs) continue;
    const haystack = [
      item.op,
      item.action,
      item.event,
      item.status,
      item.path,
      item.cwd,
      item.repoRoot,
      item.code,
      item.error,
      item.requestSlotId,
      item.previousRequestId,
    ].filter(Boolean).join(' ');
    if (query && !haystack.includes(query)) continue;
    records.push({ ...item, _time: Number.isFinite(ts) ? ts : 0 });
  } catch {
    // Ignore malformed lines.
  }
}

if (records.length === 0) {
  console.log(`No fs-io records matched "${query}" in the last ${sinceMinutes} minute(s).`);
  process.exit(0);
}

records.sort((a, b) => a._time - b._time);

function short(value) {
  if (!value || typeof value !== 'string') return '';
  const home = os.homedir();
  const normalized = value.startsWith(home) ? `~${value.slice(home.length)}` : value;
  return normalized.length > 120 ? `...${normalized.slice(-117)}` : normalized;
}

function important(item) {
  const duration = typeof item.durationMs === 'number' ? item.durationMs : 0;
  return (
    item.event === 'slot-cancel-previous'
    || item.event === 'git-child-abort-kill'
    || item.event === 'git-child-timeout-kill'
    || item.event === 'git-child-byte-limit-kill'
    || item.status === 'error'
    || item.code
    || item.error
    || duration >= slowMs
  );
}

const byOp = new Map();
for (const item of records) {
  if (!item.op || item.event) continue;
  const stat = byOp.get(item.op) ?? { count: 0, errors: 0, slow: 0, maxMs: 0 };
  stat.count += 1;
  if (item.status === 'error' || item.code || item.error) stat.errors += 1;
  if ((item.durationMs ?? 0) >= slowMs) stat.slow += 1;
  stat.maxMs = Math.max(stat.maxMs, item.durationMs ?? 0);
  byOp.set(item.op, stat);
}

console.log(`fs-io records: ${records.length}; since=${sinceMinutes}m; slow>=${slowMs}ms`);
if (byOp.size > 0) {
  console.log('\nSummary by op:');
  for (const [op, stat] of [...byOp.entries()].sort((a, b) => b[1].maxMs - a[1].maxMs)) {
    console.log(`  ${op.padEnd(14)} count=${String(stat.count).padStart(3)} slow=${String(stat.slow).padStart(3)} errors=${String(stat.errors).padStart(3)} max=${Math.round(stat.maxMs)}ms`);
  }
}

const notable = records.filter(important);
console.log(`\nNotable events: ${notable.length}`);
for (const item of notable.slice(-200)) {
  const duration = item.durationMs !== undefined ? ` duration=${Math.round(item.durationMs)}ms` : '';
  const count = item.count !== undefined ? ` count=${item.count}` : '';
  const total = item.total !== undefined ? ` total=${item.total}` : '';
  const slot = item.requestSlotId ? ` slot=${item.requestSlotId}` : '';
  const previous = item.previousRequestId !== undefined ? ` previous=${item.previousRequestId}` : '';
  const code = item.code ? ` code=${item.code}` : '';
  const error = item.error ? ` error=${JSON.stringify(item.error)}` : '';
  const target = item.path ? ` path=${short(item.path)}` : item.cwd ? ` cwd=${short(item.cwd)}` : '';
  console.log(`${item.ts} ${String(item.op ?? '').padEnd(14)} ${String(item.event ?? item.status ?? '').padEnd(24)}${duration}${count}${total}${slot}${previous}${code}${error}${target}`);
}
