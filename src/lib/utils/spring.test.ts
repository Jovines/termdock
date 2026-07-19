import { describe, expect, it } from 'vitest';
import {
  projectMomentum,
  rubberband,
  solveSpring,
  SpringValue,
} from './spring';

describe('solveSpring', () => {
  it('critically damped: approaches target monotonically without overshoot', () => {
    const s = solveSpring({ dampingRatio: 1.0, response: 0.3 }, 0, 0, 100);
    let prev = 0;
    for (let t = 0.016; t < 0.8; t += 0.016) {
      const x = s.value(t);
      expect(x).toBeGreaterThanOrEqual(prev);
      expect(x).toBeLessThanOrEqual(100);
      prev = x;
    }
    expect(s.value(0.8)).toBeGreaterThan(99.9);
  });

  it('under-damped with flick velocity: overshoots, then settles', () => {
    const s = solveSpring({ dampingRatio: 0.8, response: 0.3 }, 0, 2000, 100);
    let max = -Infinity;
    for (let t = 0; t < 1.5; t += 0.004) {
      max = Math.max(max, s.value(t));
    }
    expect(max).toBeGreaterThan(100); // overshoot happened
    expect(Math.abs(s.value(1.5) - 100)).toBeLessThan(0.5); // settled
  });

  it('velocity at t=0 equals the handed-off initial velocity', () => {
    const s = solveSpring({ dampingRatio: 1.0, response: 0.3 }, 10, 345, 90);
    expect(s.velocity(0)).toBeCloseTo(345, 6);
    expect(s.value(0)).toBeCloseTo(10, 9);
  });

  it('over-damped: settles without oscillating', () => {
    const s = solveSpring({ dampingRatio: 1.5, response: 0.3 }, 0, 0, 50);
    let prev = 0;
    for (let t = 0.016; t < 1.5; t += 0.016) {
      const x = s.value(t);
      expect(x).toBeGreaterThanOrEqual(prev - 1e-9);
      expect(x).toBeLessThanOrEqual(50 + 1e-9);
      prev = x;
    }
    expect(s.value(1.5)).toBeGreaterThan(49.9);
  });
});

describe('projectMomentum', () => {
  it('matches Apple’s WWDC formula: (v/1000)·d/(1−d)', () => {
    expect(projectMomentum(1000)).toBeCloseTo(499, 6);
    expect(projectMomentum(-500)).toBeCloseTo(-249.5, 6);
    expect(projectMomentum(0)).toBe(0);
  });

  it('a fast flick projects far beyond the release point', () => {
    // 2000 px/s flick projects ~1m of travel — this is what makes a flick
    // "throw" the element to the far snap point.
    expect(projectMomentum(2000)).toBeCloseTo(998, 6);
  });
});

describe('rubberband', () => {
  it('is zero at the boundary and preserves sign', () => {
    expect(rubberband(0, 300)).toBe(0);
    expect(rubberband(50, 300)).toBeGreaterThan(0);
    expect(rubberband(-50, 300)).toBeLessThan(0);
  });

  it('resists progressively: output grows slower than input and stays bounded', () => {
    const d = 300;
    const near = rubberband(30, d);
    const far = rubberband(300, d);
    const veryFar = rubberband(3000, d);
    expect(near).toBeLessThan(30); // some resistance immediately
    expect(far).toBeLessThan(300); // strong resistance deep in
    expect(veryFar).toBeLessThan(d); // asymptote = dimension
    expect(veryFar).toBeGreaterThan(far);
  });
});

describe('SpringValue', () => {
  function makeRig() {
    let time = 0;
    let queued: ((t: number) => void) | null = null;
    const rig = {
      now: () => time,
      schedule: (cb: (t: number) => void) => {
        queued = cb;
        return 1;
      },
      unschedule: () => {
        queued = null;
      },
      /** Advance the manual clock by frames (16ms each) until no frame is queued. */
      run(frames = 200) {
        for (let i = 0; i < frames && queued; i++) {
          time += 16;
          const cb = queued;
          queued = null;
          cb(time);
        }
      },
      step(frames = 1) {
        for (let i = 0; i < frames && queued; i++) {
          time += 16;
          const cb = queued;
          queued = null;
          cb(time);
        }
      },
    };
    return rig;
  }

  it('springs to the target and rests exactly on it', () => {
    const rig = makeRig();
    const values: number[] = [];
    let rested = false;
    const s = new SpringValue(0, {
      response: 0.3,
      dampingRatio: 1.0,
      onUpdate: (v) => values.push(v),
      onRest: () => {
        rested = true;
      },
      now: rig.now,
      schedule: rig.schedule,
      unschedule: rig.unschedule,
    });
    s.setTarget(100);
    rig.run();
    expect(rested).toBe(true);
    expect(s.value()).toBe(100);
    expect(s.isRunning()).toBe(false);
    expect(values[values.length - 1]).toBe(100);
  });

  it('carries velocity through a mid-flight retarget (no brick wall)', () => {
    const rig = makeRig();
    const s = new SpringValue(0, {
      response: 0.3,
      dampingRatio: 1.0,
      onUpdate: () => {},
      now: rig.now,
      schedule: rig.schedule,
      unschedule: rig.unschedule,
    });
    s.setTarget(100, { velocity: 1500 });
    rig.step(6); // let it pick up speed
    const vBefore = s.velocity();
    expect(vBefore).toBeGreaterThan(0);
    s.setTarget(-50); // reverse mid-flight without explicit velocity
    expect(s.velocity()).toBeCloseTo(vBefore, 6); // velocity carried, not cut
    rig.run();
    expect(s.value()).toBe(-50);
  });

  it('uses the explicit handoff velocity when provided', () => {
    const rig = makeRig();
    const s = new SpringValue(0, {
      onUpdate: () => {},
      now: rig.now,
      schedule: rig.schedule,
      unschedule: rig.unschedule,
    });
    s.setTarget(300, { velocity: 800 });
    expect(s.velocity()).toBeCloseTo(800, 6);
    rig.run();
    expect(s.value()).toBe(300);
  });

  it('stop() halts at the live value', () => {
    const rig = makeRig();
    const s = new SpringValue(0, {
      response: 0.3,
      onUpdate: () => {},
      now: rig.now,
      schedule: rig.schedule,
      unschedule: rig.unschedule,
    });
    s.setTarget(100);
    rig.step(4);
    const stoppedAt = s.stop();
    expect(stoppedAt).toBeGreaterThan(0);
    expect(stoppedAt).toBeLessThan(100);
    expect(s.isRunning()).toBe(false);
    rig.run(10);
    expect(s.value()).toBe(stoppedAt);
  });

  it('jumpTo() re-syncs with an externally-driven value (no teleport on next setTarget)', () => {
    const rig = makeRig();
    const values: number[] = [];
    const s = new SpringValue(0, {
      response: 0.3,
      onUpdate: (v) => values.push(v),
      now: rig.now,
      schedule: rig.schedule,
      unschedule: rig.unschedule,
    });
    // Simulate: spring settled at 0 long ago; a drag moved the DOM to 80 directly.
    s.jumpTo(80);
    expect(s.value()).toBe(80);
    expect(s.velocity()).toBe(0);
    s.setTarget(300);
    rig.step(3);
    // The motion must start near 80 — never jump back toward the stale 0.
    expect(values[values.length - 1]).toBeGreaterThan(79);
    rig.run();
    expect(s.value()).toBe(300);
  });
});
