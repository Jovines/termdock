#!/usr/bin/env node
import fs from 'fs';
import os from 'os';
import path from 'path';

const logPath = path.join(os.homedir(), '.termdock', 'diff-trace.log');
const args = process.argv.slice(2);
const query = args.find((arg) => !arg.startsWith('--')) ?? '';
const sinceMinutesArg = args.find((arg) => arg.startsWith('--since-min='));
const sinceMinutes = sinceMinutesArg ? Number(sinceMinutesArg.split('=')[1]) : 30;
const sinceTs = Number.isFinite(sinceMinutes) && sinceMinutes > 0
  ? Date.now() - sinceMinutes * 60_000
  : 0;

if (!fs.existsSync(logPath)) {
  console.error(`No diff trace log found at ${logPath}`);
  process.exit(0);
}

const rawLines = fs.readFileSync(logPath, 'utf8').trimEnd().split('\n').filter(Boolean);
const records = [];
for (const line of rawLines) {
  try {
    const item = JSON.parse(line);
    const ts = Date.parse(item.ts);
    if (sinceTs && Number.isFinite(ts) && ts < sinceTs) continue;
    const haystack = [
      item.traceId,
      item.interactionId,
      item.filePath,
      item.requestPath,
      item.cwd,
      item.gitRoot,
      item.requestSlotId,
      item.previousRequestId,
      item.code,
      item.error,
      item.event,
      item.source,
      JSON.stringify(item.data ?? {}),
    ].filter(Boolean).join(' ');
    if (query && !haystack.includes(query)) continue;
    records.push({ ...item, _time: Number.isFinite(ts) ? ts : 0 });
  } catch {
    // Ignore malformed old lines.
  }
}

if (records.length === 0) {
  console.log(`No diff trace records matched "${query}" in the last ${sinceMinutes} minute(s).`);
  process.exit(0);
}

records.sort((a, b) => a._time - b._time);

const groups = new Map();
for (const record of records) {
  const key = record.interactionId || record.traceId || `unlinked:${record.filePath ?? record.requestPath ?? 'unknown'}`;
  const group = groups.get(key) ?? [];
  group.push(record);
  groups.set(key, group);
}

const expectedOrder = [
  'global_change_row_event',
  'change_row_pointer_down',
  'change_row_click_handler_enter',
  'change_row_click',
  'select_diff_file',
  'select_diff_file_after',
  'selected_file_state',
  'start',
  'effect_start',
  'visible_start',
  'request_start',
  'slot-cancel-previous',
  'request-start',
  'git-root-resolved',
  'response-ok',
  'response-exception',
  'response_headers',
  'response_body_start',
  'response_body',
  'visible_result',
  'state_set_result',
  'end',
  'load_text_finally',
  'parse_done',
  'tokenize_done',
];

function hasEvent(group, event) {
  return group.some((item) => item.event === event);
}

function isCancelledByNewerRequest(group) {
  return group.some((item) => (
    item.code === 'GIT_DIFF_CANCELLED'
    || item.data?.code === 'GIT_DIFF_CANCELLED'
    || item.error === 'Git diff request was cancelled because a newer file was selected.'
  ));
}

function inferStatus(group) {
  const last = group[group.length - 1];
  if (hasEvent(group, 'state_set_result') && hasEvent(group, 'end')) return 'OK';
  if (isCancelledByNewerRequest(group)) return 'CANCELLED_BY_NEWER_REQUEST';
  if (hasEvent(group, 'client_watchdog_timeout')) return 'CLIENT_WATCHDOG_TIMEOUT';
  if (hasEvent(group, 'response_body_timeout')) return 'BODY_TIMEOUT';
  if (hasEvent(group, 'response-exception') || hasEvent(group, 'response-error')) return 'SERVER_ERROR';
  if (hasEvent(group, 'response-ok') && !hasEvent(group, 'response_headers')) return 'CLIENT_DID_NOT_OBSERVE_RESPONSE';
  if (hasEvent(group, 'response_headers') && !hasEvent(group, 'response_body')) return 'CLIENT_BODY_NOT_FINISHED';
  if (hasEvent(group, 'request_start') && !hasEvent(group, 'request-start')) return 'REQUEST_NOT_REACHED_SERVER';
  if (hasEvent(group, 'select_diff_file') && !hasEvent(group, 'effect_start')) return 'VIEWER_NOT_STARTED';
  return `INCOMPLETE_AFTER_${last?.source ?? 'unknown'}:${last?.event ?? 'unknown'}`;
}

function shortPath(item) {
  const value = item.filePath ?? item.requestPath ?? item.data?.filePath ?? item.data?.requestedPath ?? '';
  if (!value || typeof value !== 'string') return '';
  const parts = value.split('/');
  return parts.length > 4 ? `.../${parts.slice(-4).join('/')}` : value;
}

for (const [key, group] of groups) {
  const first = group[0];
  const last = group[group.length - 1];
  const status = inferStatus(group);
  console.log(`\n=== ${status} ${key} ===`);
  console.log(`time: ${first.ts} -> ${last.ts}`);
  console.log(`file: ${shortPath(group.find((item) => item.filePath || item.requestPath) ?? first)}`);
  const present = expectedOrder.filter((event) => hasEvent(group, event));
  const missingAfterFirstGap = expectedOrder.filter((event) => !hasEvent(group, event));
  console.log(`seen: ${present.join(' -> ') || '(none)'}`);
  if (status !== 'OK' && status !== 'CANCELLED_BY_NEWER_REQUEST') console.log(`missing: ${missingAfterFirstGap.slice(0, 8).join(', ')}`);
  for (const item of group) {
    const rel = `${String(item.source ?? '').padEnd(20)} ${String(item.event ?? '').padEnd(26)}`;
    const duration = item.durationMs !== undefined ? ` duration=${item.durationMs}ms` : '';
    const bytes = item.bytes !== undefined ? ` bytes=${item.bytes}` : '';
    const trace = item.traceId ? ` trace=${item.traceId}` : '';
    const interaction = item.interactionId ? ` interaction=${item.interactionId}` : '';
    const slot = item.requestSlotId ? ` slot=${item.requestSlotId}` : '';
    const previous = item.previousRequestId !== undefined ? ` previous=${item.previousRequestId}` : '';
    const code = item.code ? ` code=${item.code}` : '';
    const err = item.error ? ` error=${JSON.stringify(item.error)}` : '';
    console.log(`  ${item.ts} ${rel}${duration}${bytes}${trace}${interaction}${slot}${previous}${code}${err}`);
  }
}
