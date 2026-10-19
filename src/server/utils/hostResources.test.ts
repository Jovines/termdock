import { expect, it } from 'vitest';
import { assessAgentResourceBudget, configuredAgentResourceBudget, getTermdockOwnedAgentSessionIds, parseHostResourcesForTest } from './hostResources.js';

it('parses Linux memory, pressure, D-state, agent and browser observations', () => {
  const parsed = parseHostResourcesForTest({
    meminfo: 'MemTotal: 32768000 kB\nMemAvailable: 2048000 kB\n',
    pressure: 'some avg10=2.50 avg60=1.00 avg300=0.50 total=42\nfull avg10=0.75 avg60=0.25 avg300=0.10 total=7\n',
    ps: '100 100 S pts/1 1000 codex resume abc\n101 100 D ? 500 kswapd0\n102 102 S ? 250 chrome --type=renderer\n',
  });
  expect(parsed.memAvailableBytes).toBe(2_097_152_000);
  expect(parsed.pressure).toEqual({ someAvg10: 2.5, fullAvg10: 0.75 });
  expect(parsed.processes).toHaveLength(3);
  expect(parsed.processes[0]).toMatchObject({ pid: 100, agent: true, processGroupId: 100 });
  expect(parsed.processes[1]).toMatchObject({ state: 'D', kswapd: true });
  expect(parsed.processes[2]).toMatchObject({ browser: true });
});

it('fails closed at memory and resident-agent admission boundaries', () => {
  const budget = { minAvailableBytes: 2048, estimatedRssBytes: 512, maxResidentAgents: 4, maxAgentsPerGroup: 2, maxMemoryPressureSomeAvg10: 10, maxMemoryPressureFullAvg10: 1 };
  expect(assessAgentResourceBudget({ snapshot: { memoryAvailableBytes: 2559, residentAgentCount: 0 }, budget, residentAgentsInGroup: 0 }))
    .toEqual({ admitted: false, reason: 'MEMORY_BUDGET_LOW' });
  expect(assessAgentResourceBudget({ snapshot: { memoryAvailableBytes: 4096, residentAgentCount: 4 }, budget, residentAgentsInGroup: 0 }))
    .toEqual({ admitted: false, reason: 'MAX_RESIDENT_AGENTS' });
  expect(assessAgentResourceBudget({ snapshot: { memoryAvailableBytes: 4096, residentAgentCount: 2 }, budget, residentAgentsInGroup: 2 }))
    .toEqual({ admitted: false, reason: 'MAX_GROUP_AGENTS' });
  expect(assessAgentResourceBudget({ snapshot: { memoryAvailableBytes: 4096, residentAgentCount: 2 }, budget, residentAgentsInGroup: 1 }))
    .toEqual({ admitted: true });
  expect(assessAgentResourceBudget({ snapshot: { memoryAvailableBytes: 4096, residentAgentCount: 0, processSnapshotAvailable: false }, budget, residentAgentsInGroup: 0 }))
    .toEqual({ admitted: false, reason: 'RESOURCE_SNAPSHOT_UNAVAILABLE' });
});

it('uses Linux memory PSI as an admission gate and fails closed if PSI is unavailable', () => {
  const budget = { minAvailableBytes: 100, estimatedRssBytes: 50, maxResidentAgents: 10, maxAgentsPerGroup: 5,
    maxMemoryPressureSomeAvg10: 10, maxMemoryPressureFullAvg10: 1 };
  const base = { platform: 'linux', memoryAvailableBytes: 1000, residentAgentCount: 0, memorySnapshotAvailable: true, processSnapshotAvailable: true } as const;
  expect(assessAgentResourceBudget({ snapshot: { ...base, memoryPressure: { someAvg10: 12, fullAvg10: 0 } }, budget, residentAgentsInGroup: 0 }))
    .toEqual({ admitted: false, reason: 'MEMORY_PSI_HIGH' });
  expect(assessAgentResourceBudget({ snapshot: { ...base, memoryPressure: { someAvg10: 2, fullAvg10: 1.2 } }, budget, residentAgentsInGroup: 0 }))
    .toEqual({ admitted: false, reason: 'MEMORY_PSI_HIGH' });
  expect(assessAgentResourceBudget({ snapshot: base, budget, residentAgentsInGroup: 0 }))
    .toEqual({ admitted: false, reason: 'MEMORY_PSI_UNAVAILABLE' });
  expect(assessAgentResourceBudget({ snapshot: { ...base, memoryPressure: { someAvg10: 1, fullAvg10: 0.1 } }, budget, residentAgentsInGroup: 0 }))
    .toEqual({ admitted: true });
  expect(assessAgentResourceBudget({ snapshot: { ...base, platform: 'darwin' }, budget, residentAgentsInGroup: 0 }))
    .toEqual({ admitted: true });
});

it('exposes bounded PSI thresholds as environment configuration', () => {
  expect(configuredAgentResourceBudget({} as NodeJS.ProcessEnv)).toMatchObject({ maxMemoryPressureSomeAvg10: 10, maxMemoryPressureFullAvg10: 1 });
  expect(configuredAgentResourceBudget({ TD_AGENT_MAX_MEMORY_PSI_SOME_AVG10: '25', TD_AGENT_MAX_MEMORY_PSI_FULL_AVG10: '2.5' } as NodeJS.ProcessEnv))
    .toMatchObject({ maxMemoryPressureSomeAvg10: 25, maxMemoryPressureFullAvg10: 2.5 });
  expect(() => configuredAgentResourceBudget({ TD_AGENT_MAX_MEMORY_PSI_FULL_AVG10: '101' } as NodeJS.ProcessEnv)).toThrow();
});

it('counts only live Agent sessions owned by Termdock records plus active recovery reservations', () => {
  const owned = getTermdockOwnedAgentSessionIds({
    managedSessions: [
      { sessionId: 'td-1', tmuxSessionName: 'managed-one' },
      { sessionId: 'td-2', tmuxSessionName: 'managed-two' },
      { sessionId: 'missing', tmuxSessionName: 'not-running' },
    ],
    liveAgentSessions: [
      { name: 'managed-one' },
      { name: 'managed-two' },
      { name: 'external' },
    ],
    activeRecoverySessionIds: ['pending-launch', 'td-1'],
  });
  expect([...owned].sort()).toEqual(['td-1', 'td-2']);
});
