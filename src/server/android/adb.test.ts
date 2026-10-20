import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { androidStreamPath } from '../../lib/android/api';
import { isValidAndroidSerial } from '../routes/android';

const serial = '[fdbd:ff1:ce00:580:10:76:222:117]:33265';
let directory: string;
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'td-adb-'));
  const binary = join(directory, 'adb');
  writeFileSync(binary, `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args[0] === 'devices') {
  console.log('List of devices attached\\n${serial} device product:PTP-AN00 model:PTP_AN00 device:HNPLP transport_id:6');
} else if (args[0] === '-s' && args[1] === '${serial}' && args.slice(2).join(' ') === 'shell getprop') {
  if (process.env.TD_TEST_PROP_MODE === 'failure') process.exit(1);
  if (process.env.TD_TEST_PROP_MODE === 'diagnostic') console.log('getprop: Max 2 arguments');
  else console.log('[ro.build.version.sdk]: [35]\\n[unrelated]: [ignore]\\n[ro.product.model]: [PTP-AN00]\\n[ro.build.version.release]: [15]');
  if (process.env.TD_TEST_PROP_MODE === 'identity') console.log('[ro.serialno]: [test-hardware-serial]');
  if (process.env.TD_TEST_PROP_MODE === 'fallback') console.log('[ro.serialno]: [unknown]\\n[ro.boot.serialno]: [test-hardware-serial]');
  if (process.env.TD_TEST_PROP_MODE === 'placeholder') console.log('[ro.serialno]: [unknown]\\n[ro.boot.serialno]: [00000000]');
} else if (['connect', 'disconnect'].includes(args[0]) && args[1] === '${serial}') {
  console.log(args.join(' '));
} else { console.error('unexpected adb arguments: ' + JSON.stringify(args)); process.exit(1); }
`, { mode: 0o755 });
  vi.stubEnv('TERMDOCK_ADB_BIN', binary);
  vi.resetModules();
});
afterEach(() => { vi.unstubAllEnvs(); rmSync(directory, { recursive: true, force: true }); });

describe('Android IPv6 devices', () => {
  it.each([serial, '192.168.1.2:5555', 'ab3ef532', 'adb-device._adb-tls-connect._tcp'])('accepts serial on both ends: %s', value => {
    expect(isValidAndroidSerial(value)).toBe(true);
    expect(androidStreamPath(value)).toBe(`/api/android/${value}/ws`);
  });
  it.each(['', '../bad', 'a?b', 'a#b', 'a%b', '[::1]/ws', 'a;id', 'a b', 'a'.repeat(129)])('rejects unsafe serial on both ends: %s', value => {
    expect(isValidAndroidSerial(value)).toBe(false);
    expect(() => androidStreamPath(value)).toThrow('INVALID_SERIAL');
  });
  it('reads named properties and recognizes IPv6 as a network device', async () => {
    const { listDevices } = await import('./adb');
    expect(await listDevices()).toEqual([expect.objectContaining({ serial, isNetwork: true, model: 'PTP-AN00', androidVersion: '15', sdk: 35 })]);
  });
  it.each(['failure', 'diagnostic'])('keeps the adb model when getprop returns %s', async mode => {
    vi.stubEnv('TD_TEST_PROP_MODE', mode);
    const { listDevices } = await import('./adb');
    expect(await listDevices()).toEqual([expect.objectContaining({ model: 'PTP AN00' })]);
  });
  it.each(['identity', 'fallback'])('provides a private physical grouping key from %s', async mode => {
    vi.stubEnv('TD_TEST_PROP_MODE', mode);
    const { listDevices } = await import('./adb');
    const devices = await listDevices();
    expect(devices[0].physicalId).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.stringify(devices)).not.toContain('test-hardware-serial');
  });
  it('does not assign a shared identity for placeholder hardware properties', async () => {
    vi.stubEnv('TD_TEST_PROP_MODE', 'placeholder');
    const { listDevices } = await import('./adb');
    expect((await listDevices())[0].physicalId).toBeUndefined();
  });
  it('preserves bracketed IPv6 for connect and disconnect', async () => {
    const { normalizeAddress, connectDevice, disconnectDevice } = await import('./adb');
    expect(normalizeAddress('[::1]')).toBe('[::1]:5555');
    expect(normalizeAddress(`tcp://${serial}/`)).toBe(serial);
    expect(normalizeAddress('[bad]:5555')).toBeNull();
    expect(normalizeAddress('[::1]:65536')).toBeNull();
    expect(await connectDevice(serial)).toEqual({ serial, output: `connect ${serial}` });
    expect(await disconnectDevice(serial)).toBe(`disconnect ${serial}`);
  });
});
