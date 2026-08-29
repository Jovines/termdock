import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { normalizePersistedAgentResumeInfo, type PersistedAgentResumeInfo } from './resumePersistence.js';

export type AgentResumeHistoryReason = 'closed' | 'exited';

export interface AgentResumeHistoryEntry {
  id: string;
  title: string;
  titleSource: 'custom' | 'auto' | 'default';
  agent: PersistedAgentResumeInfo;
  cwd: string;
  closedAt: number;
  reason: AgentResumeHistoryReason;
}

interface AgentResumeHistoryDocument {
  version: 1;
  entries: AgentResumeHistoryEntry[];
}

const MAX_TITLE_LENGTH = 240;
const MAX_CWD_LENGTH = 8_192;

function normalizeEntry(input: unknown): AgentResumeHistoryEntry | null {
  if (!input || typeof input !== 'object') return null;
  const candidate = input as Partial<AgentResumeHistoryEntry>;
  const id = typeof candidate.id === 'string' ? candidate.id.trim() : '';
  const title = typeof candidate.title === 'string' ? candidate.title.trim().slice(0, MAX_TITLE_LENGTH) : '';
  const cwd = typeof candidate.cwd === 'string' ? candidate.cwd.trim().slice(0, MAX_CWD_LENGTH) : '';
  const agent = normalizePersistedAgentResumeInfo(candidate.agent);
  if (!id || !title || !cwd || !agent) return null;
  return {
    id,
    title,
    titleSource: candidate.titleSource === 'custom' || candidate.titleSource === 'auto'
      ? candidate.titleSource
      : 'default',
    agent,
    cwd,
    closedAt: typeof candidate.closedAt === 'number' && Number.isFinite(candidate.closedAt)
      ? Math.floor(candidate.closedAt)
      : Date.now(),
    reason: candidate.reason === 'exited' ? 'exited' : 'closed',
  };
}

export class AgentResumeHistoryStore {
  private entries: AgentResumeHistoryEntry[] = [];

  constructor(private readonly filePath: string, private readonly maxEntries = 30) {
    this.load();
  }

  list(): AgentResumeHistoryEntry[] {
    return this.entries.map((entry) => ({
      ...entry,
      agent: { ...entry.agent, launchArgv: entry.agent.launchArgv ? [...entry.agent.launchArgv] : null },
    }));
  }

  get(id: string): AgentResumeHistoryEntry | null {
    return this.entries.find((entry) => entry.id === id) ?? null;
  }

  archive(input: Omit<AgentResumeHistoryEntry, 'id' | 'closedAt'> & { closedAt?: number }): AgentResumeHistoryEntry | null {
    const normalized = normalizeEntry({ ...input, id: randomUUID(), closedAt: input.closedAt ?? Date.now() });
    if (!normalized) return null;
    const sameConversation = (entry: AgentResumeHistoryEntry) => entry.agent.slug === normalized.agent.slug
      && entry.agent.sessionId === normalized.agent.sessionId;
    const previous = this.entries.find(sameConversation);
    const next = previous ? { ...normalized, id: previous.id } : normalized;
    this.entries = [next, ...this.entries.filter((entry) => !sameConversation(entry))]
      .sort((a, b) => b.closedAt - a.closedAt)
      .slice(0, this.maxEntries);
    this.persist();
    return next;
  }

  remove(id: string): boolean {
    const next = this.entries.filter((entry) => entry.id !== id);
    if (next.length === this.entries.length) return false;
    this.entries = next;
    this.persist();
    return true;
  }

  clear(): void {
    if (this.entries.length === 0) return;
    this.entries = [];
    this.persist();
  }

  private load(): void {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.filePath, 'utf8')) as Partial<AgentResumeHistoryDocument>;
      this.entries = Array.isArray(parsed.entries)
        ? parsed.entries.map(normalizeEntry).filter((entry): entry is AgentResumeHistoryEntry => entry !== null)
          .sort((a, b) => b.closedAt - a.closedAt)
          .slice(0, this.maxEntries)
        : [];
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        console.warn('[agent-resume-history] failed to load:', (error as Error).message);
      }
      this.entries = [];
    }
  }

  private persist(): void {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    const tempPath = `${this.filePath}.tmp-${process.pid}`;
    const document: AgentResumeHistoryDocument = { version: 1, entries: this.entries };
    fs.writeFileSync(tempPath, JSON.stringify(document, null, 2), { encoding: 'utf8', mode: 0o600 });
    fs.renameSync(tempPath, this.filePath);
  }
}
