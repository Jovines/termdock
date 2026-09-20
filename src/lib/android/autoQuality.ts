import type { AndroidQuality } from './api';

// Fix dimensions/frame rate for the lifetime of the stream. Only bitrate changes.
export const AUTO_QUALITY_LEVELS: AndroidQuality[] = [
  700_000, 1_000_000, 1_400_000, 1_800_000, 2_400_000, 3_200_000,
  4_000_000, 5_000_000, 6_000_000, 8_000_000, 10_000_000, 12_000_000,
].map(bitRate => ({ id: 'auto', maxSize: 1600, bitRate, maxFps: 30 }));
export interface AutoQualitySample {
  rttMs: number | null;
  deliveryDelayMs: number;
  decodeQueue: number;
  frames: number;
}

/** Probe for clarity; back off specifically when an upgrade proves too costly. */
export class AutoQuality {
  level = 6;
  private badSince: number | null = null;
  private goodSince: number | null = null;
  private connectedAt = 0;
  private lastSample = -Infinity;
  private lastChange = -Infinity;
  private lastUpgrade = -Infinity;
  private upgradeAfter = 0;
  private failedProbes = 0;
  private baselineRtt = Infinity;
  get quality(): AndroidQuality { return AUTO_QUALITY_LEVELS[this.level]!; }
  connected(now: number): void {
    this.connectedAt = now;
    this.badSince = this.goodSince = null;
    this.lastSample = -Infinity;
  }
  sample(sample: AutoQualitySample, now: number, targetPixels = 1600): AndroidQuality | null {
    if (now - this.lastSample > 2500) this.badSince = this.goodSince = null;
    this.lastSample = now;
    if (sample.rttMs !== null) this.baselineRtt = Math.min(this.baselineRtt, sample.rttMs);
    if (now - this.connectedAt < 3000) return null;
    const rttGrowth = sample.rttMs !== null && sample.rttMs > this.baselineRtt + 150;
    // High but stable propagation latency is not evidence of insufficient bandwidth.
    const bad = sample.deliveryDelayMs > 250 || sample.decodeQueue >= 4
      || (rttGrowth && sample.frames > 0 && sample.deliveryDelayMs > 100);
    const severe = sample.deliveryDelayMs > 800 || sample.decodeQueue >= 8;
    const good = sample.rttMs !== null && sample.rttMs < this.baselineRtt + 100
      && sample.deliveryDelayMs < 80 && sample.decodeQueue <= 1;
    this.badSince = bad ? this.badSince ?? now : null;
    this.goodSince = good ? this.goodSince ?? now : null;
    const targetLevel = targetPixels <= 1080 ? 7 : targetPixels <= 1600 ? 9 : 11;
    if (this.badSince !== null && now - this.badSince >= (severe ? 1000 : 2000)
      && now - this.lastChange >= (severe ? 2000 : 3000) && this.level > 0) {
      this.level = Math.max(0, this.level - (severe ? 2 : 1));
      const failedProbe = now - this.lastUpgrade < 20000;
      this.failedProbes = failedProbe ? this.failedProbes + 1 : 0;
      this.upgradeAfter = now + (failedProbe ? Math.min(30000, 8000 * 2 ** (this.failedProbes - 1)) : 5000);
      this.lastUpgrade = -Infinity;
    } else if (this.goodSince !== null && now - this.goodSince >= 3000
      && now - this.lastChange >= 4000 && now >= this.upgradeAfter && this.level < targetLevel) {
      this.level++;
      this.lastUpgrade = now;
    } else return null;
    this.lastChange = now;
    this.badSince = this.goodSince = null;
    return this.quality;
  }
}
