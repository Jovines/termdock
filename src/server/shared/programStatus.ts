import { incompleteOscSuffix } from '../utils/oscBuffer.js';

export interface TerminalProgressReport {
  state: 'remove' | 'set' | 'error' | 'indeterminate' | 'pause' | 'blocked' | 'done';
  progress: number | null;
  source?: 'osc7501';
  app?: string;
  message?: string;
  kind?: 'permission' | 'question' | 'auth';
}
type ProgramState = 'idle' | 'working' | 'blocked' | 'done' | 'error' | 'clear';
interface ProgramRecord {
  id: string;
  state: ProgramState;
  app?: string;
  msg?: string;
  title?: string;
  progress?: number;
  kind?: TerminalProgressReport['kind'];
}
export const PROGRAM_STATUS_REPLY = '\x1b]7501;?:states=idle,working,done,blocked,error:kinds=permission,question,auth\x1b\\';
const STATES = new Set(['idle', 'working', 'blocked', 'done', 'error', 'clear']);
const RANK: Record<ProgramState, number> = { idle: 0, done: 1, working: 2, error: 3, blocked: 4, clear: 0 };

function text(value: string | undefined, encodedLimit: number, decodedLimit: number): string | undefined {
  if (value === undefined) return undefined;
  if (value.length > encodedLimit || !/^[A-Za-z0-9+/]*={0,2}$/.test(value) || value.length % 4 === 1
    || value.includes('=') && value.length % 4 !== 0) throw new Error('invalid text');
  const decoded = Buffer.from(value, 'base64');
  if (decoded.length > decodedLimit || decoded.toString('base64').replace(/=+$/, '') !== value.replace(/=+$/, '')) throw new Error('invalid text');
  const result = new TextDecoder('utf-8', { fatal: true }).decode(decoded);
  if (/[\u0000-\u001f\u007f-\u009f]/.test(result)) throw new Error('invalid text');
  return result.replace(/\p{Cf}/gu, '');
}

/** Independent implementation of the public OSC 7501 protocol, revision 0.4:
 * https://www.superlogical.com/rex/docs/build/program-status */
export function parseProgramStatus(body: string): ProgramRecord | null {
  if (Buffer.byteLength(body) + 9 > 4096) return null;
  const pairs: Record<string, string> = Object.create(null);
  for (const pair of body.split(':')) {
    const index = pair.indexOf('='); if (index < 1) continue;
    const key = pair.slice(0, index).trim(), value = pair.slice(index + 1).trim();
    if (key.length > 16) return null;
    if (/^[a-z]+$/.test(key) && /^[A-Za-z0-9_.,+/=-]*$/.test(value)) pairs[key] = value;
  }
  if (!STATES.has(pairs.state)) return null;
  const id = pairs.id ?? '';
  if (id.length > 128 || (id && (id.split('/').length > 8 || !id.split('/').every(segment => /^[A-Za-z0-9_.+-]{1,32}$/.test(segment))))) return null;
  try {
    const state = pairs.state as ProgramState;
    const progress = /^(?:100|[0-9]{1,2})$/.test(pairs.progress ?? '') ? Number(pairs.progress) : undefined;
    return { id, state, app: /^[A-Za-z0-9_.+-]{1,32}$/.test(pairs.app ?? '') ? pairs.app : undefined,
      msg: text(pairs.msg, 2732, 2048), title: text(pairs.title, 256, 192),
      progress: state === 'working' || state === 'blocked' ? progress : undefined,
      kind: state === 'blocked' && ['permission', 'question', 'auth'].includes(pairs.kind) ? pairs.kind as ProgramRecord['kind'] : undefined };
  } catch { return null; }
}

export function parseLegacyProgress(body: string): TerminalProgressReport | null {
  const match = /^4;([0-4])(?:;([0-9]+))?$/.exec(body);
  if (!match) return null;
  const states = ['remove', 'set', 'error', 'indeterminate', 'pause'] as const;
  const state = states[Number(match[1])];
  const progress = match[2] !== undefined && ['set', 'error', 'pause'].includes(state)
    ? Math.min(100, Number(match[2])) : null;
  return { state, progress };
}

/** State belongs to a PTY, not a browser. Native progress never mutates an
 * Agent lifecycle, activity counter, permission decision, or notification. */
export class ProgramStatusTracker {
  private remaining = '';
  private native = false;
  private records = new Map<string, ProgramRecord>();
  private legacy: TerminalProgressReport | null = null;
  private current: TerminalProgressReport | null = null;

  feed(data: string): { changed: boolean; query: boolean; progress: TerminalProgressReport | null; endedApps: string[] } {
    const previouslyActive = this.activeApps();
    const explicitEnd = new Set<string>();
    const buffer = this.remaining + data;
    const pattern = /\x1bc|\x1b\](7501|133|9);([^\x07\x1b]*)(?:\x07|\x1b\\)/g;
    let match: RegExpExecArray | null, consumed = 0, query = false;
    while ((match = pattern.exec(buffer))) {
      consumed = pattern.lastIndex;
      if (match[0] === '\x1bc') {
        this.records.clear(); this.native = false; this.legacy = null; continue;
      }
      if (match[1] === '7501') {
        if (match[2] === '?') { query = true; continue; }
        const record = parseProgramStatus(match[2]); if (!record) continue;
        this.native = true;
        if (record.app && ['idle', 'done', 'error', 'clear'].includes(record.state)) explicitEnd.add(record.app);
        if (record.state === 'clear') {
          for (const id of this.records.keys()) if (!record.id || id === record.id || id.startsWith(`${record.id}/`)) this.records.delete(id);
        } else {
          this.records.delete(record.id); this.records.set(record.id, record);
          if (this.records.size > 256) this.records.delete(this.records.keys().next().value!);
        }
      } else if (match[1] === '133' && /^(?:A|P)(?:;|$)/.test(match[2])) {
        this.legacy = null;
        this.dropActive();
      } else if (match[1] === '9' && !this.native) {
        const progress = parseLegacyProgress(match[2]);
        if (progress) this.legacy = progress.state === 'remove' ? null : progress;
      }
    }
    this.remaining = incompleteOscSuffix(buffer, consumed, 4096);
    const active = this.activeApps();
    return { ...this.update(), query, endedApps: [...new Set([...previouslyActive, ...explicitEnd])].filter(app => !active.includes(app)) };
  }

  activeApps(): string[] {
    const apps = new Set<string>();
    for (const record of this.records.values()) {
      if (!['working', 'blocked'].includes(record.state)) continue;
      const app = this.appFor(record); if (app) apps.add(app);
    }
    return [...apps];
  }

  private appFor(record: ProgramRecord): string | undefined {
    let app = record.app, parent = record.id;
    while (!app && parent) { parent = parent.includes('/') ? parent.slice(0, parent.lastIndexOf('/')) : ''; app = this.records.get(parent)?.app; }
    return app;
  }

  exit(): { changed: boolean; progress: TerminalProgressReport | null } {
    this.dropActive(); this.legacy = null; return this.update();
  }

  private dropActive(): void {
    for (const [id, record] of this.records) if (['working', 'blocked', 'idle'].includes(record.state)) this.records.delete(id);
  }

  private update(): { changed: boolean; progress: TerminalProgressReport | null } {
    let selected: ProgramRecord | undefined;
    for (const record of this.records.values()) if (RANK[record.state] > 0 && (!selected || RANK[record.state] >= RANK[selected.state])) selected = record;
    let progress: TerminalProgressReport | null = this.native ? null : this.legacy;
    if (selected) {
      const app = this.appFor(selected);
      progress = { source: 'osc7501', state: selected.state === 'working' ? selected.progress === undefined ? 'indeterminate' : 'set' : selected.state as 'blocked' | 'done' | 'error',
        progress: selected.progress ?? null, app, message: selected.msg ?? selected.title, kind: selected.kind };
    }
    const changed = JSON.stringify(progress) !== JSON.stringify(this.current);
    this.current = progress; return { changed, progress };
  }
}

const trackers = new WeakMap<object, ProgramStatusTracker>();
export function terminalProgramStatus(terminal: object): ProgramStatusTracker {
  let tracker = trackers.get(terminal);
  if (!tracker) { tracker = new ProgramStatusTracker(); trackers.set(terminal, tracker); }
  return tracker;
}
