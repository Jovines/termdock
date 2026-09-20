import type { AndroidQuality } from './api';

export const AUTO_QUALITY_LEVELS: AndroidQuality[] = [
  { id: 'auto', maxSize: 480, bitRate: 500_000, maxFps: 24 },
  { id: 'auto', maxSize: 720, bitRate: 1_200_000, maxFps: 30 },
  { id: 'auto', maxSize: 1080, bitRate: 3_000_000, maxFps: 30 },
  { id: 'auto', maxSize: 1600, bitRate: 5_000_000, maxFps: 30 },
];
export interface AutoQualitySample {
  rttMs: number | null;
  deliveryDelayMs: number;
  decodeQueue: number;
  frames: number;
}

/** Hysteresis survives stream restarts; quiet screens are not bandwidth probes. */
export class AutoQuality {
  level = 1;
  private bad = 0;
  private good = 0;
  private connectedAt = 0;
  private lastChange = -Infinity;
  private upgradeAfter = 0;
  get quality(): AndroidQuality { return AUTO_QUALITY_LEVELS[this.level]!; }
  connected(now: number): void { this.connectedAt = now; this.bad = 0; this.good = 0; }
  sample(sample: AutoQualitySample, now: number): AndroidQuality | null {
    if (now - this.connectedAt < 5000 || sample.rttMs === null) {
      this.bad = 0; this.good = 0;
      return null;
    }
    const bad = sample.rttMs > 350 || sample.deliveryDelayMs > 250 || sample.decodeQueue >= 4;
    const good = sample.rttMs < 140 && sample.deliveryDelayMs < 80 && sample.decodeQueue <= 1 && sample.frames >= 8;
    this.bad = bad ? this.bad + 1 : 0;
    this.good = good ? this.good + 1 : 0;
    if (now - this.lastChange < 12000) return null;
    if (this.bad >= 3 && this.level > 0) {
      this.level--;
      // A failed upgrade must not cause a recurring up/down cycle.
      this.upgradeAfter = now + 120000;
    } else if (this.good >= 30 && this.level < AUTO_QUALITY_LEVELS.length - 1 && now >= this.upgradeAfter) {
      this.level++;
    } else return null;
    this.lastChange = now;
    this.bad = 0;
    this.good = 0;
    return this.quality;
  }
}
