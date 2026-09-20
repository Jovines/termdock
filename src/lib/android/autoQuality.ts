import type { AndroidQuality } from './api';

export const AUTO_QUALITY_LEVELS: AndroidQuality[] = [
  { id: 'auto', maxSize: 480, bitRate: 700_000, maxFps: 24 },
  { id: 'auto', maxSize: 720, bitRate: 1_800_000, maxFps: 30 },
  { id: 'auto', maxSize: 1080, bitRate: 4_000_000, maxFps: 30 },
  { id: 'auto', maxSize: 1600, bitRate: 8_000_000, maxFps: 30 },
];
export interface AutoQualitySample {
  rttMs: number | null;
  deliveryDelayMs: number;
  decodeQueue: number;
  frames: number;
}

/** Probe for clarity; back off specifically when an upgrade proves too costly. */
export class AutoQuality {
  level = 2;
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
    const targetLevel = Math.max(2, AUTO_QUALITY_LEVELS.findIndex(level => level.maxSize >= Math.min(1600, targetPixels)));
    if (this.badSince !== null && now - this.badSince >= (severe ? 1000 : 2000)
      && now - this.lastChange >= (severe ? 3000 : 6000) && this.level > 0) {
      this.level--;
      const failedProbe = now - this.lastUpgrade < 20000;
      this.failedProbes = failedProbe ? this.failedProbes + 1 : 0;
      this.upgradeAfter = now + (failedProbe ? Math.min(90000, 20000 * 2 ** (this.failedProbes - 1)) : 15000);
      this.lastUpgrade = -Infinity;
    } else if (this.goodSince !== null && now - this.goodSince >= 8000
      && now - this.lastChange >= 10000 && now >= this.upgradeAfter && this.level < targetLevel) {
      this.level++;
      this.lastUpgrade = now;
    } else return null;
    this.lastChange = now;
    this.badSince = this.goodSince = null;
    return this.quality;
  }
}
