import { describe, expect, it } from 'vitest';
import { AutoQuality, type AutoQualitySample } from './autoQuality';
import { normalizeAndroidQuality, androidStreamPath } from './api';
import { normalizeAndroidPanel } from '../../server/utils/settings';

const good: AutoQualitySample = { rttMs: 50, deliveryDelayMs: 10, decodeQueue: 0, frames: 30 };
const bad = { ...good, rttMs: 600 };

describe('automatic mirror quality', () => {
  it('persists auto selection but starts every new connection conservatively', () => {
    const quality = normalizeAndroidQuality({ id: 'auto', maxSize: 1600 });
    expect(quality.maxSize).toBe(720);
    expect(normalizeAndroidPanel({ quality }).quality?.id).toBe('auto');
    expect(androidStreamPath('device', quality)).toContain('bit_rate=1200000');
  });
  it('ignores warmup and isolated spikes, then lowers after sustained congestion', () => {
    const policy = new AutoQuality();
    policy.connected(0);
    for (let t = 1000; t < 5000; t += 1000) expect(policy.sample(bad, t)).toBeNull();
    expect(policy.sample(bad, 5000)).toBeNull();
    policy.sample(good, 6000);
    expect(policy.sample(bad, 7000)).toBeNull();
    expect(policy.sample(bad, 8000)).toBeNull();
    expect(policy.sample(bad, 9000)?.maxSize).toBe(480);
  });
  it('does not mistake static screens or unknown RTT for spare bandwidth', () => {
    const policy = new AutoQuality();
    policy.connected(0);
    for (let t = 5000; t < 120000; t += 1000) {
      expect(policy.sample({ ...good, frames: 0 }, t)).toBeNull();
      expect(policy.sample({ ...good, rttMs: null }, t)).toBeNull();
    }
    expect(policy.quality.maxSize).toBe(720);
  });
  it('upgrades slowly and retains cooldown through reconnection', () => {
    const policy = new AutoQuality();
    policy.connected(0);
    for (let t = 5000; t < 34000; t += 1000) expect(policy.sample(good, t)).toBeNull();
    expect(policy.sample(good, 34000)?.maxSize).toBe(1080);
    policy.connected(34000);
    for (let t = 39000; t < 46000; t += 1000) expect(policy.sample(bad, t)).toBeNull();
    expect(policy.sample(bad, 46000)?.maxSize).toBe(720);
    policy.connected(46000);
    for (let t = 51000; t < 166000; t += 1000) expect(policy.sample(good, t)).toBeNull();
    expect(policy.sample(good, 166000)?.maxSize).toBe(1080);
  });
  it.each([{ ...good, decodeQueue: 5 }, { ...good, deliveryDelayMs: 400 }])('also lowers for decoder or video backlog', sample => {
    const policy = new AutoQuality();
    policy.connected(0);
    policy.sample(sample, 5000);
    policy.sample(sample, 6000);
    expect(policy.sample(sample, 7000)?.maxSize).toBe(480);
  });
});
