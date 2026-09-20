import { describe, expect, it } from 'vitest';
import { AutoQuality, AUTO_QUALITY_LEVELS, type AutoQualitySample } from './autoQuality';
import { normalizeAndroidQuality, androidStreamPath } from './api';
const good: AutoQualitySample = { rttMs: 50, deliveryDelayMs: 10, decodeQueue: 0, frames: 30 };
const bad = { ...good, deliveryDelayMs: 400 };
function samples(policy: AutoQuality, sample: AutoQualitySample, from: number, to: number, pixels = 1600) {
  let result = null;
  for (let time = from; time <= to; time += 1000) result = policy.sample(sample, time, pixels) ?? result;
  return result;
}
describe('continuous automatic bitrate', () => {
  it('starts at 4Mbps and keeps dimensions/fps identical across twelve rates', () => {
    const policy = new AutoQuality();
    expect(normalizeAndroidQuality({ id: 'auto' })).toEqual(policy.quality);
    expect(androidStreamPath('device', policy.quality)).toContain('bit_rate=4000000');
    expect(AUTO_QUALITY_LEVELS).toHaveLength(12);
    expect(new Set(AUTO_QUALITY_LEVELS.map(q => q.maxSize)).size).toBe(1);
    expect(new Set(AUTO_QUALITY_LEVELS.map(q => q.maxFps)).size).toBe(1);
  });
  it('ignores startup and isolated spikes, lowers persistent backlog after 2s', () => {
    const policy = new AutoQuality(); policy.connected(0);
    expect(samples(policy, bad, 1000, 2000)).toBeNull();
    policy.sample(bad, 3000); policy.sample(good, 4000);
    expect(samples(policy, bad, 5000, 6000)).toBeNull();
    expect(policy.sample(bad, 7000)?.bitRate).toBe(3_200_000);
  });
  it('raises after three stable seconds, including a static screen', () => {
    const policy = new AutoQuality(); policy.connected(0);
    expect(samples(policy, { ...good, frames: 0 }, 3000, 5000)).toBeNull();
    expect(policy.sample({ ...good, frames: 0 }, 6000)?.bitRate).toBe(5_000_000);
  });
  it('does not lower for high but stable RTT or infer bandwidth from unknown RTT', () => {
    const policy = new AutoQuality(); policy.connected(0);
    samples(policy, { ...good, rttMs: 600 }, 3000, 30000);
    expect(policy.quality.bitRate).toBe(8_000_000);
    const unknown = new AutoQuality();
    expect(samples(unknown, { ...good, rttMs: null }, 3000, 30000)).toBeNull();
    unknown.sample(good, 31000);
    expect(unknown.sample(good, 90000)).toBeNull();
  });
  it('recovers 5s after congestion and backs off a failed upgrade for 8s', () => {
    const policy = new AutoQuality(); policy.connected(0);
    expect(samples(policy, bad, 3000, 5000)?.bitRate).toBe(3_200_000);
    expect(samples(policy, good, 6000, 9000)).toBeNull();
    expect(policy.sample(good, 10000)?.bitRate).toBe(4_000_000);
    expect(samples(policy, bad, 11000, 13000)?.bitRate).toBe(3_200_000);
    expect(samples(policy, good, 14000, 20000)).toBeNull();
    expect(policy.sample(good, 21000)?.bitRate).toBe(4_000_000);
  });
  it('limits bandwidth on small previews while allowing more clarity when zoomed', () => {
    const policy = new AutoQuality(); policy.connected(0);
    samples(policy, good, 3000, 20000, 900);
    expect(policy.quality.bitRate).toBe(5_000_000);
    expect(policy.sample(good, 21000, 1800)?.bitRate).toBe(6_000_000);
  });
  it('drops two steps after 1s of severe congestion, respecting the bitrate floor', () => {
    const policy = new AutoQuality(); policy.connected(0);
    expect(policy.sample({ ...bad, decodeQueue: 10 }, 3000)).toBeNull();
    expect(policy.sample({ ...bad, decodeQueue: 10 }, 4000)?.bitRate).toBe(2_400_000);
    samples(policy, { ...bad, decodeQueue: 10 }, 5000, 30000);
    expect(policy.quality.bitRate).toBe(700_000);
  });
});
