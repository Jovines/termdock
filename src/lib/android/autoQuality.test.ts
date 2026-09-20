import { describe, expect, it } from 'vitest';
import { AutoQuality, type AutoQualitySample } from './autoQuality';
import { normalizeAndroidQuality, androidStreamPath } from './api';
import { normalizeAndroidPanel } from '../../server/utils/settings';
const good: AutoQualitySample = { rttMs: 50, deliveryDelayMs: 10, decodeQueue: 0, frames: 30 };
const bad = { ...good, deliveryDelayMs: 400 };
function samples(policy: AutoQuality, sample: AutoQualitySample, from: number, to: number) {
  let result = null;
  for (let time = from; time <= to; time += 1000) result = policy.sample(sample, time) ?? result;
  return result;
}
describe('automatic mirror quality', () => {
  it('starts at a readable 1080 with the same persisted auto selection', () => {
    const quality = normalizeAndroidQuality({ id: 'auto', maxSize: 1600 });
    expect(quality.maxSize).toBe(1080);
    expect(normalizeAndroidPanel({ quality }).quality?.id).toBe('auto');
    expect(androidStreamPath('device', quality)).toContain('bit_rate=4000000');
  });
  it('ignores startup and isolated spikes, lowers for persistent backlog', () => {
    const policy = new AutoQuality(); policy.connected(0);
    expect(samples(policy, bad, 1000, 2000)).toBeNull();
    policy.sample(bad, 3000); policy.sample(good, 4000);
    expect(samples(policy, bad, 5000, 6000)).toBeNull();
    expect(policy.sample(bad, 7000)?.maxSize).toBe(720);
  });
  it('allows a static screen to probe higher clarity after eight stable seconds', () => {
    const policy = new AutoQuality(); policy.connected(0);
    expect(samples(policy, { ...good, frames: 0 }, 3000, 10000)).toBeNull();
    expect(policy.sample({ ...good, frames: 0 }, 11000)?.maxSize).toBe(1600);
  });
  it('does not lower for high but stable RTT', () => {
    const policy = new AutoQuality(); policy.connected(0);
    samples(policy, { ...good, rttMs: 600 }, 3000, 30000);
    expect(policy.quality.maxSize).toBe(1600);
  });
  it('does not infer bandwidth from unknown RTT or gaps between observations', () => {
    const policy = new AutoQuality(); policy.connected(0);
    expect(samples(policy, { ...good, rttMs: null }, 3000, 30000)).toBeNull();
    policy.sample(good, 31000);
    expect(policy.sample(good, 90000)).toBeNull();
  });
  it('recovers after congestion without an unconditional two-minute lockout', () => {
    const policy = new AutoQuality(); policy.connected(0);
    expect(samples(policy, bad, 3000, 5000)?.maxSize).toBe(720);
    policy.connected(5000);
    expect(samples(policy, good, 8000, 19000)).toBeNull();
    expect(policy.sample(good, 20000)?.maxSize).toBe(1080);
  });
  it('backs off failed upgrade probes across reconnects', () => {
    const policy = new AutoQuality(); policy.connected(0);
    expect(samples(policy, good, 3000, 11000)?.maxSize).toBe(1600);
    policy.connected(11000);
    expect(samples(policy, bad, 14000, 16000)).toBeNull();
    expect(policy.sample(bad, 17000)?.maxSize).toBe(1080);
    policy.connected(17000);
    expect(samples(policy, good, 20000, 36000)).toBeNull();
    expect(policy.sample(good, 37000)?.maxSize).toBe(1600);
    policy.connected(37000);
    samples(policy, bad, 40000, 43000);
    policy.connected(43000);
    expect(samples(policy, good, 46000, 82000)).toBeNull();
    expect(policy.sample(good, 83000)?.maxSize).toBe(1600);
  });
  it('avoids needless resolution upgrades for a small display, but allows zooming in', () => {
    const policy = new AutoQuality(); policy.connected(0);
    for (let now = 3000; now <= 20000; now += 1000) expect(policy.sample(good, now, 900)).toBeNull();
    expect(policy.sample(good, 21000, 1800)?.maxSize).toBe(1600);
  });
  it('responds faster to severe decoder pressure', () => {
    const policy = new AutoQuality(); policy.connected(0);
    expect(policy.sample({ ...good, decodeQueue: 10 }, 3000)).toBeNull();
    expect(policy.sample({ ...good, decodeQueue: 10 }, 4000)?.maxSize).toBe(720);
  });
});
