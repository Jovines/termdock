import fs from 'node:fs/promises';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { detectAgentFromCommand } from '../agent/registry.js';

const execFileAsync = promisify(execFile);

export interface ProcessResourceRow {
  pid: number;
  processGroupId: number;
  tty: string;
  state: string;
  command: string;
  rssBytes: number;
  agent: boolean;
  browser: boolean;
  kswapd: boolean;
}

export interface HostResourceSnapshot {
  sampledAt: number;
  platform: string;
  memoryAvailableBytes: number;
  memoryTotalBytes: number;
  memoryPressure: { someAvg10: number | null; fullAvg10: number | null } | null;
  dStateProcessCount: number;
  kswapd: Array<{ pid: number; state: string }>;
  residentAgentCount: number;
  residentAgentRssBytes: number;
  browserProcessCount: number;
  memorySnapshotAvailable: boolean;
  processSnapshotAvailable: boolean;
  processRows: ProcessResourceRow[];
}

export interface AgentResourceBudget {
  minAvailableBytes: number;
  estimatedRssBytes: number;
  maxResidentAgents: number;
  maxAgentsPerGroup: number;
}

function parseMemAvailable(contents: string): number | null {
  const match = contents.match(/^MemAvailable:\s+(\d+)\s+kB$/m);
  return match ? Number(match[1]) * 1024 : null;
}

function parsePressure(contents: string): HostResourceSnapshot['memoryPressure'] {
  const parse = (kind: 'some' | 'full') => {
    const line = contents.split('\n').find(item => item.startsWith(`${kind} `));
    const value = line?.match(/\bavg10=([\d.]+)/)?.[1];
    return value === undefined ? null : Number(value);
  };
  const someAvg10 = parse('some');
  const fullAvg10 = parse('full');
  return someAvg10 === null && fullAvg10 === null ? null : { someAvg10, fullAvg10 };
}

function parseProcesses(contents: string, customCommands: Record<string, string> = {}): ProcessResourceRow[] {
  return contents.split('\n').flatMap(line => {
    const match = line.trim().match(/^(\d+)\s+(\d+)\s+(\S+)\s+(\S+)\s+(\d+)\s+(.*)$/);
    if (!match) return [];
    const [, pidRaw, pgidRaw, state, ttyRaw, rssRaw, commandRaw] = match;
    const pid = Number(pidRaw), processGroupId = Number(pgidRaw), rssKb = Number(rssRaw);
    if (!Number.isSafeInteger(pid) || pid <= 0 || !Number.isSafeInteger(processGroupId) || processGroupId <= 0 || !Number.isFinite(rssKb)) return [];
    const command = commandRaw ?? '';
    const comm = (command.split(/\s+/, 1)[0] ?? '').toLowerCase().split('/').at(-1) ?? '';
    return [{
      pid, processGroupId, state: state ?? '?', tty: ttyRaw === '?' ? '' : ttyRaw, command,
      rssBytes: Math.max(0, rssKb) * 1024,
      agent: Boolean(detectAgentFromCommand(command, customCommands)),
      browser: /^(chrome|chromium|firefox|webkit|agent-browser)(-|$)/.test(comm),
      kswapd: /^\[?kswapd\d*\]?$/.test(comm),
    }];
  });
}

export async function collectHostResourceSnapshot(customCommands: Record<string, string> = {}): Promise<HostResourceSnapshot> {
  let memoryAvailableBytes = os.freemem();
  let memorySnapshotAvailable = false;
  let memoryPressure: HostResourceSnapshot['memoryPressure'] = null;
  if (process.platform === 'linux') {
    const [meminfo, pressure] = await Promise.all([
      fs.readFile('/proc/meminfo', 'utf8').catch(() => ''),
      fs.readFile('/proc/pressure/memory', 'utf8').catch(() => ''),
    ]);
    const parsedAvailable = parseMemAvailable(meminfo);
    if (parsedAvailable !== null) { memoryAvailableBytes = parsedAvailable; memorySnapshotAvailable = true; }
    memoryPressure = parsePressure(pressure);
  } else { memorySnapshotAvailable = Number.isFinite(memoryAvailableBytes); }
  let processRows: ProcessResourceRow[] = [];
  let processSnapshotAvailable = false;
  try {
    const { stdout } = await execFileAsync('ps', ['-e', '-o', 'pid=,pgid=,stat=,tty=,rss=,args='], { timeout: 5000, maxBuffer: 8 * 1024 * 1024 });
    processRows = parseProcesses(stdout, customCommands);
    processSnapshotAvailable = processRows.length > 0;
  } catch { /* process metrics are diagnostic; memory admission remains fail-closed below */ }
  const groupRss = new Map<number, number>();
  const agentGroupIds = new Set<number>();
  for (const row of processRows) {
    groupRss.set(row.processGroupId, (groupRss.get(row.processGroupId) ?? 0) + row.rssBytes);
    if (row.agent) agentGroupIds.add(row.processGroupId);
  }
  const agentRss = [...agentGroupIds].reduce((sum, id) => sum + (groupRss.get(id) ?? 0), 0);
  return {
    sampledAt: Date.now(), platform: process.platform, memoryAvailableBytes, memoryTotalBytes: os.totalmem(), memoryPressure,
    dStateProcessCount: processRows.filter(row => row.state.includes('D')).length,
    kswapd: processRows.filter(row => row.kswapd).map(({ pid, state }) => ({ pid, state })),
    residentAgentCount: agentGroupIds.size,
    residentAgentRssBytes: agentRss,
    browserProcessCount: processRows.filter(row => row.browser).length,
    memorySnapshotAvailable,
    processSnapshotAvailable,
    processRows,
  };
}

export function configuredAgentResourceBudget(env: NodeJS.ProcessEnv = process.env): AgentResourceBudget {
  const readMb = (key: string, fallback: number, min: number, max: number) => {
    const raw = env[key];
    if (raw === undefined || raw.trim() === '') return fallback * 1024 ** 2;
    const value = Number(raw);
    if (!Number.isInteger(value) || value < min || value > max) throw new Error(`${key} must be an integer from ${min} to ${max} MiB`);
    return value * 1024 ** 2;
  };
  const readCount = (key: string, fallback: number, max: number) => {
    const raw = env[key];
    if (raw === undefined || raw.trim() === '') return fallback;
    const value = Number(raw);
    if (!Number.isInteger(value) || value < 1 || value > max) throw new Error(`${key} must be an integer from 1 to ${max}`);
    return value;
  };
  return {
    minAvailableBytes: readMb('TD_AGENT_MIN_AVAILABLE_MB', 2048, 256, 131072),
    estimatedRssBytes: readMb('TD_AGENT_ESTIMATED_RSS_MB', 512, 64, 32768),
    maxResidentAgents: readCount('TD_MAX_RESIDENT_AGENTS', 48, 10000),
    maxAgentsPerGroup: readCount('TD_MAX_AGENTS_PER_GROUP', 32, 1000),
  };
}

export function assessAgentResourceBudget(input: {
  snapshot: Pick<HostResourceSnapshot, 'memoryAvailableBytes' | 'residentAgentCount'> & Partial<Pick<HostResourceSnapshot, 'memorySnapshotAvailable' | 'processSnapshotAvailable'>>;
  budget: AgentResourceBudget;
  residentAgentsInGroup: number;
}): { admitted: boolean; reason?: string } {
  if (input.snapshot.memorySnapshotAvailable === false || input.snapshot.processSnapshotAvailable === false) return { admitted: false, reason: 'RESOURCE_SNAPSHOT_UNAVAILABLE' };
  const required = input.budget.minAvailableBytes + input.budget.estimatedRssBytes;
  if (input.snapshot.memoryAvailableBytes < required) return { admitted: false, reason: 'MEMORY_BUDGET_LOW' };
  if (input.snapshot.residentAgentCount >= input.budget.maxResidentAgents) return { admitted: false, reason: 'MAX_RESIDENT_AGENTS' };
  if (input.residentAgentsInGroup >= input.budget.maxAgentsPerGroup) return { admitted: false, reason: 'MAX_GROUP_AGENTS' };
  return { admitted: true };
}

export function parseHostResourcesForTest(contents: { meminfo: string; pressure: string; ps: string }) {
  return { memAvailableBytes: parseMemAvailable(contents.meminfo), pressure: parsePressure(contents.pressure), processes: parseProcesses(contents.ps) };
}
