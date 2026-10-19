import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

test('systemd drop-in preserves Termdock-managed tmux workloads across service restarts', async () => {
  const unit = await readFile(new URL('../packaging/systemd/termdock.service.d/10-preserve-tmux.conf', import.meta.url), 'utf8');
  const documentation = await readFile(new URL('../docs/systemd.md', import.meta.url), 'utf8');
  assert.match(unit, /^\[Service\]\s*$/m);
  assert.match(unit, /^KillMode=process\s*$/m);
  assert.match(documentation, /KillMode=control-group/);
  assert.match(documentation, /systemd stops the\s+Termdock main process/);
});
