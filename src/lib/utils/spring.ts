/**
 * Apple-style spring physics for gesture-driven UI.
 *
 * Implements the motion model from WWDC 2018 «Designing Fluid Interfaces»:
 *  - Springs parameterized by **damping ratio** (overshoot) + **response**
 *    (seconds to roughly settle) — Apple's designer-facing pair, not the
 *    mass/stiffness/damping triplet. A spring has no fixed "duration".
 *  - **Interruptibility**: every retarget starts from the live presentation
 *    value and carries the current velocity — no jumps, no brick walls.
 *  - **Velocity handoff**: a gesture's release velocity becomes the spring's
 *    initial velocity, so drag → animation is seamless.
 *  - **Momentum projection**: exponential-decay projection (the exact formula
 *    Apple ships, not the textbook v²/2a) picks the snap target a flick is
 *    *heading* toward.
 *  - **Rubber-banding**: progressive resistance at boundaries.
 *
 * The solver is the closed-form (analytic) solution of the damped harmonic
 * oscillator, so sampling any timestamp is exact and allocation-free.
 */

export interface SpringParameters {
  /**
   * Damping ratio ζ. `1.0` = critically damped (graceful, no overshoot).
   * `< 1.0` = under-damped (bounces). Apple's house style: 1.0 everywhere,
   * ~0.8 only when the gesture itself carried momentum (a flick or throw).
   */
  dampingRatio: number;
  /**
   * Response — how quickly the value reaches the target, in seconds.
   * Lower = snappier. This is NOT a duration; settle time emerges from the
   * parameters.
   */
  response: number;
}

/** Default UI spring — critically damped, no overshoot. */
export const SPRING_DEFAULT: SpringParameters = { dampingRatio: 1.0, response: 0.35 };

/** Drawer / sheet spring (Apple's shipped value). Use damping 1.0 instead when no momentum preceded it. */
export const SPRING_SHEET: SpringParameters = { dampingRatio: 0.8, response: 0.3 };

/** UIScrollView's default deceleration rate (per millisecond retention). */
export const SCROLL_DECELERATION_RATE = 0.998;

export interface SpringSolver {
  /** Position (any unit) `t` seconds after the segment started. */
  value: (t: number) => number;
  /** Velocity (units/second) `t` seconds after the segment started. */
  velocity: (t: number) => number;
}

/**
 * Closed-form solution of the damped harmonic oscillator
 *   ü + 2ζω₀u̇ + ω₀²u = 0,  u = x − target,
 * with ω₀ = 2π / response.
 */
export function solveSpring(
  params: SpringParameters,
  from: number,
  initialVelocity: number,
  target: number,
): SpringSolver {
  const w0 = (2 * Math.PI) / Math.max(params.response, 1e-3);
  const u0 = from - target;
  const v0 = initialVelocity;
  const z = params.dampingRatio;

  if (Math.abs(z - 1) < 1e-4) {
    // Critically damped: u(t) = (A + Bt)·e^(−ω₀t)
    const A = u0;
    const B = v0 + w0 * u0;
    return {
      value: (t) => target + (A + B * t) * Math.exp(-w0 * t),
      velocity: (t) => (B - w0 * (A + B * t)) * Math.exp(-w0 * t),
    };
  }

  if (z < 1) {
    // Under-damped: u(t) = e^(−ζω₀t)·(A·cos ωd t + B·sin ωd t), ωd = ω₀√(1−ζ²)
    const wd = w0 * Math.sqrt(1 - z * z);
    const A = u0;
    const B = (v0 + z * w0 * u0) / wd;
    return {
      value: (t) => target + Math.exp(-z * w0 * t) * (A * Math.cos(wd * t) + B * Math.sin(wd * t)),
      velocity: (t) =>
        Math.exp(-z * w0 * t) *
        ((B * wd - z * w0 * A) * Math.cos(wd * t) - (A * wd + z * w0 * B) * Math.sin(wd * t)),
    };
  }

  // Over-damped: u(t) = A·e^(r₁t) + B·e^(r₂t)
  const s = w0 * Math.sqrt(z * z - 1);
  const r1 = -z * w0 + s;
  const r2 = -z * w0 - s;
  const A = (v0 - r2 * u0) / (r1 - r2);
  const B = u0 - A;
  return {
    value: (t) => target + A * Math.exp(r1 * t) + B * Math.exp(r2 * t),
    velocity: (t) => A * r1 * Math.exp(r1 * t) + B * r2 * Math.exp(r2 * t),
  };
}

/**
 * Apple's momentum projection (from the WWDC 2018 sample code): where a
 * flick released at `velocityPxPerSec` would come to rest under
 * exponential decay. `d ≈ 0.998` is the normal scroll feel.
 */
export function projectMomentum(
  velocityPxPerSec: number,
  decelerationRate: number = SCROLL_DECELERATION_RATE,
): number {
  return (velocityPxPerSec / 1000) * (decelerationRate / (1 - decelerationRate));
}

/**
 * Progressive boundary resistance. The further past the bound, the less the
 * element follows — reads as "responsive, but there's nothing more here"
 * instead of a frozen hard stop. Result asymptotically approaches
 * `dimension`.
 */
export function rubberband(overshoot: number, dimension: number, constant = 0.55): number {
  return (overshoot * dimension * constant) / (dimension + constant * Math.abs(overshoot));
}

/** Whether the user asked for non-vestibular motion (cross-fades, no springs). */
export function prefersReducedMotion(): boolean {
  return (
    typeof window !== 'undefined' &&
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches
  );
}

const SETTLE_DISTANCE = 0.1;
const SETTLE_VELOCITY = 5; // units/sec

/**
 * Sample a spring segment into per-frame positions for a WAAPI
 * (`element.animate`) keyframe track.
 *
 * Why WAAPI: transform/opacity animations created this way run on the
 * compositor, so the motion stays smooth even when React (or anything else)
 * blocks the main thread mid-animation — a rAF-driven spring visibly freezes
 * in that situation. The solver is kept alongside so an interruption can
 * still read the exact live value/velocity analytically (wall-clock based,
 * immune to dropped frames).
 */
export function sampleSpringKeyframes(
  params: SpringParameters,
  from: number,
  initialVelocity: number,
  target: number,
  clamp?: (x: number) => number,
): { frames: number[]; durationMs: number; solver: SpringSolver } {
  const solver = solveSpring(params, from, initialVelocity, target);
  const FRAME_MS = 1000 / 60;
  const MAX_FRAMES = 240; // 4s cap
  const frames: number[] = [];

  for (let i = 0; i < MAX_FRAMES; i++) {
    const t = (i * FRAME_MS) / 1000;
    const x = solver.value(t);
    const v = solver.velocity(t);
    frames.push(clamp ? clamp(x) : x);
    if (i > 0 && Math.abs(x - target) < SETTLE_DISTANCE && Math.abs(v) < SETTLE_VELOCITY) {
      break;
    }
  }
  frames.push(clamp ? clamp(target) : target);

  return { frames, durationMs: (frames.length - 1) * FRAME_MS, solver };
}

export interface SpringValueOptions extends Partial<SpringParameters> {
  onUpdate: (value: number) => void;
  onRest?: () => void;
  /** Test hooks — inject a manual clock / scheduler. */
  now?: () => number;
  schedule?: (cb: (time: number) => void) => number;
  unschedule?: (id: number) => void;
}

export interface SpringTargetOptions extends Partial<SpringParameters> {
  /**
   * Initial velocity (units/sec) for this segment — pass the gesture's
   * release velocity here for a seamless handoff. When omitted, the spring's
   * own live velocity is carried through (smooth retarget on interruption).
   */
  velocity?: number;
}

/**
 * A single animatable value driven by a spring. Always animates from the
 * live presentation value; retargeting mid-flight blends velocity instead of
 * hard-cutting, which is what makes the motion interruptible and reversible
 * at any instant.
 */
export class SpringValue {
  private params: SpringParameters;
  private solver: SpringSolver | null = null;
  private segmentStartTime = 0;
  private targetValue: number;
  private currentValue: number;
  private currentVelocity = 0;
  private frameId: number | null = null;

  private readonly onUpdate: (value: number) => void;
  private readonly onRest?: () => void;
  private readonly now: () => number;
  private readonly schedule: (cb: (time: number) => void) => number;
  private readonly unschedule: (id: number) => void;

  constructor(initialValue: number, options: SpringValueOptions) {
    this.currentValue = initialValue;
    this.targetValue = initialValue;
    this.params = {
      dampingRatio: options.dampingRatio ?? SPRING_DEFAULT.dampingRatio,
      response: options.response ?? SPRING_DEFAULT.response,
    };
    this.onUpdate = options.onUpdate;
    this.onRest = options.onRest;
    this.now = options.now ?? (() => performance.now());
    this.schedule =
      options.schedule ??
      ((cb) => (typeof window !== 'undefined' ? window.requestAnimationFrame(cb) : 0));
    this.unschedule =
      options.unschedule ??
      ((id) => {
        if (typeof window !== 'undefined') window.cancelAnimationFrame(id);
      });
  }

  /** Live value — sampled from the in-flight segment if one exists. */
  value(): number {
    if (!this.solver) return this.currentValue;
    return this.solver.value((this.now() - this.segmentStartTime) / 1000);
  }

  /** Live velocity (units/sec) — zero when settled. */
  velocity(): number {
    if (!this.solver) return 0;
    return this.solver.velocity((this.now() - this.segmentStartTime) / 1000);
  }

  target(): number {
    return this.targetValue;
  }

  isRunning(): boolean {
    return this.solver !== null;
  }

  /**
   * Retarget the spring. Starts from the live value; uses `opts.velocity`
   * when given (gesture handoff), otherwise carries the spring's live
   * velocity so a mid-flight reversal has no velocity discontinuity.
   */
  setTarget(target: number, opts?: SpringTargetOptions): void {
    const t = this.now();
    const liveValue = this.value();
    const liveVelocity = this.velocity();

    this.cancelFrame();
    this.params = {
      dampingRatio: opts?.dampingRatio ?? this.params.dampingRatio,
      response: opts?.response ?? this.params.response,
    };
    this.targetValue = target;
    this.currentValue = liveValue;
    this.currentVelocity = opts?.velocity ?? liveVelocity;
    this.solver = solveSpring(this.params, liveValue, this.currentVelocity, target);
    this.segmentStartTime = t;

    // Already at rest at the target — nothing to do.
    if (Math.abs(liveValue - target) < SETTLE_DISTANCE && Math.abs(this.currentVelocity) < SETTLE_VELOCITY) {
      this.solver = null;
      this.currentValue = target;
      this.currentVelocity = 0;
      this.onUpdate(target);
      this.onRest?.();
      return;
    }

    this.frameId = this.schedule(this.tick);
  }

  /** Halt immediately at the live value; returns that value. */
  stop(): number {
    const live = this.value();
    this.cancelFrame();
    this.solver = null;
    this.currentValue = live;
    this.currentVelocity = 0;
    this.targetValue = live;
    return live;
  }

  /**
   * Re-sync with an externally-driven value. Needed when something else
   * (e.g. 1:1 drag tracking) moved the rendered value directly, leaving the
   * spring's internal state stale — without this, the next setTarget would
   * start from wherever the spring last settled instead of the live
   * on-screen position, causing a visible teleport.
   */
  jumpTo(value: number): void {
    this.cancelFrame();
    this.solver = null;
    this.currentValue = value;
    this.currentVelocity = 0;
    this.targetValue = value;
  }

  private cancelFrame(): void {
    if (this.frameId !== null) {
      this.unschedule(this.frameId);
      this.frameId = null;
    }
  }

  private tick = (time: number): void => {
    this.frameId = null;
    if (!this.solver) return;

    const t = (time - this.segmentStartTime) / 1000;
    const x = this.solver.value(t);
    const v = this.solver.velocity(t);
    this.currentValue = x;
    this.currentVelocity = v;

    if (Math.abs(x - this.targetValue) < SETTLE_DISTANCE && Math.abs(v) < SETTLE_VELOCITY) {
      this.solver = null;
      this.currentValue = this.targetValue;
      this.currentVelocity = 0;
      this.onUpdate(this.targetValue);
      this.onRest?.();
      return;
    }

    this.onUpdate(x);
    this.frameId = this.schedule(this.tick);
  };
}
