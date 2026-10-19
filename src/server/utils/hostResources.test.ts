import { expect, it } from 'vitest';
import { assessAgentResourceBudget, parseHostResourcesForTest } from './hostResources.js';

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
  const budget = { minAvailableBytes: 2048, estimatedRssBytes: 512, maxResidentAgents: 4, maxAgentsPerGroup: 2 };
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
