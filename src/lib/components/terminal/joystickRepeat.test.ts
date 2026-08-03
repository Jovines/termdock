import { describe, expect, it } from 'vitest';
import {
  JOYSTICK_ENTER_DIST_PX,
  JOYSTICK_EXIT_DIST_PX,
  JOYSTICK_FULL_SPEED_DIST_PX,
  JOYSTICK_REPEAT_MAX_INTERVAL_MS,
  JOYSTICK_REPEAT_MIN_INTERVAL_MS,
  computeJoystickRepeatIntervalMs,
  resolveJoystickDirection,
} from './joystickRepeat';

describe('resolveJoystickDirection', () => {
  it('死区内不激活', () => {
    expect(resolveJoystickDirection(JOYSTICK_ENTER_DIST_PX - 1, 0, '')).toBe('');
    expect(resolveJoystickDirection(0, 0, '')).toBe('');
  });

  it('超过进入阈值且主轴明确时激活', () => {
    expect(resolveJoystickDirection(JOYSTICK_ENTER_DIST_PX + 1, 0, '')).toBe('right');
    expect(resolveJoystickDirection(-(JOYSTICK_ENTER_DIST_PX + 1), 0, '')).toBe('left');
    expect(resolveJoystickDirection(0, JOYSTICK_ENTER_DIST_PX + 1, '')).toBe('down');
    expect(resolveJoystickDirection(0, -(JOYSTICK_ENTER_DIST_PX + 1), '')).toBe('up');
  });

  it('斜向模糊（主轴优势不足 1.5×）不激活', () => {
    // dist > 16 但 dx/dy 接近 1:1
    expect(resolveJoystickDirection(12, 11, '')).toBe('');
  });

  it('滞回带内（EXIT~ENTER）保持原方向', () => {
    const mid = (JOYSTICK_ENTER_DIST_PX + JOYSTICK_EXIT_DIST_PX) / 2;
    expect(resolveJoystickDirection(mid, 0, 'right')).toBe('right');
  });

  it('回到退出阈值以内才停止', () => {
    expect(resolveJoystickDirection(JOYSTICK_EXIT_DIST_PX - 1, 0, 'right')).toBe('');
    expect(resolveJoystickDirection(0, 0, 'right')).toBe('');
  });

  it('斜向微抖不换向（另一轴未达 1.8× 当前主轴）', () => {
    // right 激活中，dy 增大但不足 1.8× absDx
    expect(resolveJoystickDirection(40, 20, 'right')).toBe('right');
  });

  it('另一轴明显压过（≥1.8×）才垂直换向', () => {
    expect(resolveJoystickDirection(10, 30, 'right')).toBe('down');
    expect(resolveJoystickDirection(30, -10, 'up')).toBe('right');
  });

  it('同轴回拉过中心直接换向（跟手）', () => {
    expect(resolveJoystickDirection(-(JOYSTICK_ENTER_DIST_PX + 1), 0, 'right')).toBe('left');
    expect(resolveJoystickDirection(0, JOYSTICK_ENTER_DIST_PX + 1, 'up')).toBe('down');
  });

  it('方向不变时保持', () => {
    expect(resolveJoystickDirection(50, 0, 'right')).toBe('right');
  });
});

describe('computeJoystickRepeatIntervalMs', () => {
  it('激活点附近为最慢速', () => {
    expect(computeJoystickRepeatIntervalMs(0)).toBe(JOYSTICK_REPEAT_MAX_INTERVAL_MS);
    expect(computeJoystickRepeatIntervalMs(JOYSTICK_ENTER_DIST_PX)).toBe(
      JOYSTICK_REPEAT_MAX_INTERVAL_MS,
    );
  });

  it('达到全速距离后为最快速', () => {
    expect(computeJoystickRepeatIntervalMs(JOYSTICK_FULL_SPEED_DIST_PX)).toBe(
      JOYSTICK_REPEAT_MIN_INTERVAL_MS,
    );
    expect(computeJoystickRepeatIntervalMs(JOYSTICK_FULL_SPEED_DIST_PX + 50)).toBe(
      JOYSTICK_REPEAT_MIN_INTERVAL_MS,
    );
  });

  it('随距离单调递减', () => {
    const mid = (JOYSTICK_ENTER_DIST_PX + JOYSTICK_FULL_SPEED_DIST_PX) / 2;
    const v = computeJoystickRepeatIntervalMs(mid);
    expect(v).toBeLessThan(JOYSTICK_REPEAT_MAX_INTERVAL_MS);
    expect(v).toBeGreaterThan(JOYSTICK_REPEAT_MIN_INTERVAL_MS);
    expect(v).toBeCloseTo((JOYSTICK_REPEAT_MAX_INTERVAL_MS + JOYSTICK_REPEAT_MIN_INTERVAL_MS) / 2);
  });

  it('最快速刻意大于 120ms 触觉节流，保证每步都有震动', () => {
    expect(JOYSTICK_REPEAT_MIN_INTERVAL_MS).toBeGreaterThan(120);
  });
});
