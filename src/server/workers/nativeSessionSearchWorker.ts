import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createInterface } from 'node:readline';
import { once } from 'node:events';
import { parentPort, threadId, workerData } from 'node:worker_threads';
import type { NativeSessionRecord, NativeSessionMatch, NativeSearchStatus } from '../agent/nativeSessionSearch.js';

interface Entry extends NativeSessionRecord {
  file: string;
  size: number;
  mtime: number;
  indexedSize?: number;
  indexedMtime?: number;
  indexedOffset?: number;
  named?: boolean;
}
type Json = Record<string, unknown>;
const { directory, codexHome, claudeHome } = workerData as { directory: string; codexHome: string; claudeHome: string };
const entries = new Map<string, Entry>();
const failures = new Set<string>();
let warning: string | null = null;
let building = false;
let refreshedAt = 0;
let refreshPromise: Promise<void> | null = null;
const manifest = path.join(directory, 'manifest.json');
const temporarySuffix = `.tmp-${process.pid}-${threadId}`;
const uuid = /([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})\.jsonl$/i;
const asJson = (value: unknown): Json => value && typeof value === 'object' ? value as Json : {};
const text = (value: unknown): string => typeof value === 'string' ? value : '';
const indexed = (entry: Entry) => entry.size === entry.indexedSize && entry.mtime === entry.indexedMtime;
const textPath = (entry: Entry) => path.join(directory, `${entry.key}.txt`);
const status = (): NativeSearchStatus => ({ total: entries.size, indexed: [...entries.values()].filter(indexed).length, building, failed: failures.size, warning });
const publicRecord = (entry: Entry): NativeSessionRecord => ({ key: entry.key, agentSlug: entry.agentSlug, agentNativeSessionId: entry.agentNativeSessionId, title: entry.title, cwd: entry.cwd, updatedAt: entry.updatedAt });

async function save(): Promise<void> {
  const temporary = `${manifest}${temporarySuffix}`;
  await fs.promises.writeFile(temporary, JSON.stringify({ version: 2, entries: [...entries.values()] }), { mode: 0o600 });
  await fs.promises.rename(temporary, manifest);
}

async function* lines(file: string): AsyncGenerator<string> {
  const stream = fs.createReadStream(file, { encoding: 'utf8' });
  const reader = createInterface({ input: stream, crlfDelay: Infinity });
  try { for await (const line of reader) yield line; }
  finally { reader.close(); stream.destroy(); }
}

async function discover(root: string, recursive: boolean, depth = 0): Promise<string[]> {
  let children: fs.Dirent[];
  try { children = await fs.promises.readdir(root, { withFileTypes: true }); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') warning = '部分历史目录无法读取，请检查当前服务账户的文件权限';
    return [];
  }
  const found: string[] = [];
  for (const child of children) {
    const file = path.join(root, child.name);
    if (child.isDirectory() && child.name !== 'subagents' && (recursive || depth === 0)) found.push(...await discover(file, recursive, depth + 1));
    else if (child.isFile() && uuid.test(child.name)) found.push(file);
  }
  return found;
}

async function codexNames(): Promise<Map<string, string>> {
  const names = new Map<string, string>();
  try {
    for await (const line of lines(path.join(codexHome, 'session_index.jsonl'))) {
      try {
        const record = JSON.parse(line) as Json;
        const id = text(record.id);
        const name = text(record.thread_name).trim();
        if (id && name) names.set(id, name);
      } catch { /* Ignore a trailing partial record while Codex writes. */ }
    }
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') warning = 'Codex 会话名称索引无法读取，暂用对话内容作为名称'; }
  return names;
}

function content(value: unknown): string {
  if (typeof value === 'string') return value;
  if (!Array.isArray(value)) return '';
  return value.map(block => {
    const item = asJson(block);
    if (['text', 'input_text', 'output_text'].includes(text(item.type))) return text(item.text);
    return item.type === 'tool_result' ? content(item.content) : '';
  }).filter(Boolean).join('\n');
}

function parse(entry: Entry, line: string): string {
  // Codex world_state and tool snapshots dominate transcript size. These
  // records contain no user/assistant dialogue; avoid parsing their payloads.
  if (entry.agentSlug === 'codex') {
    const type = /^\{[^\n]{0,200}?"type"\s*:\s*"([^"]+)"/.exec(line)?.[1];
    if (type && !['session_meta', 'response_item', 'event_msg'].includes(type)) return '';
  }
  let record: Json;
  try { record = JSON.parse(line) as Json; } catch { return ''; }
  let value = '';
  let user = false;
  if (entry.agentSlug === 'codex') {
    const payload = asJson(record.payload);
    if (record.type === 'session_meta') {
      const id = text(payload.id) || text(payload.session_id);
      if (id && id !== entry.agentNativeSessionId) return '';
      entry.cwd = text(payload.cwd) || entry.cwd;
    } else if (record.type === 'response_item' && payload.type === 'message' && ['user', 'assistant'].includes(text(payload.role))) {
      value = content(payload.content);
      user = payload.role === 'user';
    } else if (record.type === 'response_item' && ['function_call_output', 'custom_tool_call_output'].includes(text(payload.type))) {
      value = content(payload.output);
    } else if (record.type === 'event_msg' && ['user_message', 'agent_message'].includes(text(payload.type))) {
      value = text(payload.message);
      user = payload.type === 'user_message';
    }
  } else {
    if (record.isSidechain) return '';
    const id = text(record.sessionId);
    if (id && id !== entry.agentNativeSessionId) return '';
    entry.cwd = text(record.cwd) || entry.cwd;
    const name = text(record.customTitle) || text(record.aiTitle);
    if (name) { entry.title = name; entry.named = true; }
    if (['user', 'assistant'].includes(text(record.type)) && !record.isMeta) {
      const message = asJson(record.message);
      value = content(message.content);
      user = record.type === 'user' && (typeof message.content === 'string' || Array.isArray(message.content) && message.content.some(block => asJson(block).type === 'text'));
    }
  }
  value = value.replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, '').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').replace(/\s+/g, ' ').trim();
  if (user && !entry.named && value && !/^(?:# AGENTS\.md|<environment_context>|<INSTRUCTIONS>|<system-reminder>|\[Request interrupted)/.test(value)) {
    entry.title = value.slice(0, 100);
    entry.named = true;
  }
  return value;
}

async function readHead(entry: Entry): Promise<void> {
  const handle = await fs.promises.open(entry.file, 'r');
  try {
    const buffer = Buffer.alloc(256 * 1024);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    const head = buffer.subarray(0, bytesRead).toString('utf8');
    const complete = bytesRead < buffer.length ? head : head.slice(0, head.lastIndexOf('\n'));
    for (const line of complete.split('\n')) if (line) parse(entry, line);
  } finally { await handle.close(); }
}

async function refresh(): Promise<void> {
  if (building || Date.now() - refreshedAt < 30_000) return;
  if (refreshPromise) return refreshPromise;
  refreshPromise = (async () => {
    warning = null;
    const names = await codexNames();
    const sources = [
      { slug: 'codex' as const, files: await discover(path.join(codexHome, 'sessions'), true) },
      { slug: 'codex' as const, files: await discover(path.join(codexHome, 'archived_sessions'), true) },
      { slug: 'claude' as const, files: await discover(path.join(claudeHome, 'projects'), false) },
    ];
    const seen = new Set<string>();
    for (const source of sources) for (const file of source.files) {
      const id = uuid.exec(path.basename(file))![1];
      const key = createHash('sha256').update(file).digest('hex');
      seen.add(key);
      try {
        const stat = await fs.promises.stat(file);
        const previous = entries.get(key);
        const entry: Entry = { ...previous, key, file, agentSlug: source.slug, agentNativeSessionId: id,
          title: previous?.title || `${source.slug === 'codex' ? 'Codex' : 'Claude'} · ${id.slice(0, 8)}`,
          cwd: previous?.cwd || '', updatedAt: stat.mtimeMs, mtime: stat.mtimeMs, size: stat.size };
        const name = source.slug === 'codex' ? names.get(id) : null;
        if (name) { entry.title = name; entry.named = true; }
        if (!previous || !entry.cwd) await readHead(entry);
        // A cache is disposable: missing text must be rebuilt, not counted ready.
        if (indexed(entry) && !fs.existsSync(textPath(entry))) { entry.indexedMtime = undefined; entry.indexedSize = undefined; }
        entries.set(key, entry);
      } catch { warning = '部分历史文件暂时无法读取，其余会话仍可搜索'; }
    }
    for (const [key, entry] of entries) if (!seen.has(key)) {
      entries.delete(key);
      failures.delete(key);
      await fs.promises.rm(textPath(entry), { force: true });
    }
    refreshedAt = Date.now();
    failures.clear();
    void build().catch(() => { warning = '历史索引写入失败，请检查当前服务账户的磁盘空间与文件权限'; });
  })();
  try { await refreshPromise; } finally { refreshPromise = null; }
}

async function indexEntry(entry: Entry): Promise<void> {
  const temporary = `${textPath(entry)}${temporarySuffix}`;
  // Native transcripts are append-only. Reuse extracted dialogue and read only
  // newly appended source bytes; atomic replacement keeps searches consistent.
  const append = entry.indexedOffset !== undefined && entry.indexedSize !== undefined && entry.size > entry.indexedSize && fs.existsSync(textPath(entry));
  if (append) await fs.promises.copyFile(textPath(entry), temporary);
  const start = append ? entry.indexedOffset! : 0;
  const output = fs.createWriteStream(temporary, { mode: 0o600, flags: append ? 'a' : 'w' });
  let outputError: Error | null = null;
  output.on('error', error => { outputError = error; });
  const recent = new Set<string>();
  let offset = start;
  let fragments: string[] = [];
  let fragmentBytes = 0;
  const stream = fs.createReadStream(entry.file, { encoding: 'utf8', start, ...(entry.size > start ? { end: entry.size - 1 } : {}) });
  try {
    for await (const chunk of stream) {
      if (outputError) throw outputError;
      const valueChunk = chunk as string;
      let cursor = 0;
      let newline: number;
      // Scan each incoming chunk once. Re-scanning a growing multi-megabyte
      // world_state line on every chunk makes first-time indexing quadratic.
      while ((newline = valueChunk.indexOf('\n', cursor)) >= 0) {
        const piece = valueChunk.slice(cursor, newline);
        const line = fragments.length ? fragments.join('') + piece : piece;
        offset += fragmentBytes + Buffer.byteLength(piece) + 1;
        fragments = [];
        fragmentBytes = 0;
        cursor = newline + 1;
        const value = parse(entry, line);
        if (!value) continue;
        const hash = createHash('sha256').update(value).digest('hex');
        if (recent.has(hash)) continue;
        recent.add(hash);
        if (recent.size > 64) recent.delete(recent.values().next().value!);
        if (!output.write(`${value}\n`)) await once(output, 'drain');
      }
      if (cursor < valueChunk.length) {
        const remainder = valueChunk.slice(cursor);
        fragments.push(remainder);
        fragmentBytes += Buffer.byteLength(remainder);
      }
    }
    output.end();
    await once(output, 'finish');
    if (outputError) throw outputError;
    await fs.promises.rename(temporary, textPath(entry));
    // A file appended during indexing will be picked up on the next refresh.
    entry.indexedSize = entry.size;
    entry.indexedMtime = entry.mtime;
    entry.indexedOffset = offset;
  } catch (error) {
    output.destroy();
    await fs.promises.rm(temporary, { force: true }).catch(() => {});
    throw error;
  } finally { stream.destroy(); }
}

async function build(): Promise<void> {
  if (building) return;
  building = true;
  try {
    const pending = [...entries.values()].filter(entry => !indexed(entry)).sort((a, b) => b.updatedAt - a.updatedAt);
    let count = 0;
    for (const entry of pending) {
      try { await indexEntry(entry); } catch { failures.add(entry.key); }
      if (++count % 10 === 0) await save();
    }
    await save();
  } finally { building = false; }
}

async function initialize(): Promise<void> {
  await fs.promises.mkdir(directory, { recursive: true, mode: 0o700 });
  try {
    const cached = JSON.parse(await fs.promises.readFile(manifest, 'utf8')) as { version: number; entries: Entry[] };
    if (cached.version === 2 && Array.isArray(cached.entries)) for (const entry of cached.entries) {
      if (/^[a-f0-9]{64}$/.test(entry.key)) entries.set(entry.key, entry);
    }
  } catch { /* First use or an interrupted cache write: derive from originals. */ }
  await refresh();
}
const ready = initialize();

async function search(query: string, limit: number, titles: Array<{ agentSlug: string; agentNativeSessionId: string; title: string }>, signal: AbortSignal) {
  await ready;
  await refresh();
  const startedBuilding = building;
  const needle = query.trim().toLocaleLowerCase();
  const results: NativeSessionMatch[] = [];
  const matchedSessions = new Set<string>();
  const names = new Map(titles.map(entry => [`${entry.agentSlug}:${entry.agentNativeSessionId}`, entry.title]));
  const ordered = [...entries.values()].sort((a, b) => b.updatedAt - a.updatedAt);
  let total = 0;
  for (const entry of ordered) {
    if (signal.aborted) throw new Error('搜索已取消');
    const identity = `${entry.agentSlug}:${entry.agentNativeSessionId}`;
    if (matchedSessions.has(identity)) continue;
    const title = names.get(identity) || entry.title;
    let matchCount = 0;
    let snippet = '';
    const consider = (value: string) => {
      const lower = value.toLocaleLowerCase();
      let cursor = 0;
      let first = -1;
      while ((cursor = lower.indexOf(needle, cursor)) >= 0) {
        if (first < 0) first = cursor;
        matchCount = Math.min(999, matchCount + 1);
        cursor += needle.length;
      }
      if (first >= 0 && !snippet) snippet = value.slice(Math.max(0, first - 90), first + needle.length + 170);
    };
    if (needle) {
      consider(`${title}${title !== entry.title ? `\n${entry.title}` : ''}\n${entry.cwd}\n${entry.agentSlug}\n${entry.agentNativeSessionId}`);
      const metadataSnippet = snippet;
      snippet = '';
      try {
        if (entry.indexedSize !== undefined) for await (const line of lines(textPath(entry))) {
          if (signal.aborted) throw new Error('搜索已取消');
          consider(line);
        }
      }
      catch (error) {
        if (signal.aborted) throw error;
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') warning = '部分历史索引无法读取，请检查文件权限';
      }
      snippet ||= metadataSnippet;
      if (!matchCount) continue;
    }
    total += 1;
    matchedSessions.add(identity);
    if (results.length < limit) results.push({ ...publicRecord(entry), title, snippet: snippet.replace(/\s+/g, ' ').trim(), matchCount });
  }
  // A scan begun during indexing may have read an older snapshot. Keep one
  // more automatic refresh even if the background build finished meanwhile.
  return { results, matchedSessions: [...matchedSessions], total, index: { ...status(), building: building || startedBuilding } };
}

const requests = new Map<number, AbortController>();
parentPort!.on('message', (input: { id: number; type: string; query?: string; limit?: number; key?: string; titles?: Array<{ agentSlug: string; agentNativeSessionId: string; title: string }> }) => {
  if (input.type === 'cancel') { requests.get(input.id)?.abort(); return; }
  const controller = new AbortController();
  requests.set(input.id, controller);
  void (async () => {
    await ready;
    if (input.type === 'search') return search(input.query || '', Math.max(1, Math.min(input.limit || 50, 5100)), input.titles || [], controller.signal);
    const entry = entries.get(input.key || '');
    if (!entry) return null;
    await fs.promises.access(entry.file, fs.constants.R_OK);
    return publicRecord(entry);
  })().then(value => parentPort!.postMessage({ id: input.id, value }), error => parentPort!.postMessage({ id: input.id, error: error instanceof Error ? error.message : '历史会话搜索失败' })).finally(() => requests.delete(input.id));
});
