// 长按方向摇杆的纯逻辑：方向判定 + 重复发送间隔。
// 从 TerminalViewport 抽出以便单测；所有手感参数集中在这一处调整。
//
// 手感设计（修「想停不停 / 挪过 / 没到位」）：
// 1. 死区滞回：进入需拖过 ENTER_DIST，退出需回到 EXIT_DIST 以内，
//    阈值带内保持原状态——指尖在死区边缘抖动不会反复触发「激活即发送」。
// 2. 换向滞回：斜向拖动时，换向要求另一轴 ≥ 1.8× 当前主轴（比激活的
//    1.5× 更苛刻），防止手指微抖在两个方向间跳变、每次跳变多发一键；
//    但同轴回拉（如 right 中向左拉回）直接换向，保持跟手。
// 3. 最高速限制在 125ms/步（≈8 步/秒）：松手时网络/渲染管道里在途的
//    按键更少，不冲过头；且刻意大于触觉节流 120ms，保证每一步都有一次
//    震动反馈，可以凭震感数步子。

export type JoystickDirection = 'up' | 'down' | 'left' | 'right';

export const JOYSTICK_ENTER_DIST_PX = 16;
export const JOYSTICK_EXIT_DIST_PX = 10;

export const JOYSTICK_ACTIVATE_AXIS_RATIO = 1.5;
export const JOYSTICK_SWITCH_AXIS_RATIO = 1.8;

export const JOYSTICK_REPEAT_MAX_INTERVAL_MS = 240;
export const JOYSTICK_REPEAT_MIN_INTERVAL_MS = 125;
// 偏移达到该距离（相对本次方向激活点）即全速。
export const JOYSTICK_FULL_SPEED_DIST_PX = 92;

// dx/dy 相对长按起点。currentDir 为当前已激活方向（'' 表示未激活）。
// 返回新方向；'' 表示停止重复。
export function resolveJoystickDirection(
  dx: number,
  dy: number,
  currentDir: JoystickDirection | '',
): JoystickDirection | '' {
  const dist = Math.hypot(dx, dy);
  const absDx = Math.abs(dx);
  const absDy = Math.abs(dy);

  const dominant = (): JoystickDirection | '' => {
    if (absDx >= absDy * JOYSTICK_ACTIVATE_AXIS_RATIO) return dx > 0 ? 'right' : 'left';
    if (absDy >= absDx * JOYSTICK_ACTIVATE_AXIS_RATIO) return dy > 0 ? 'down' : 'up';
    return '';
  };

  if (currentDir === '') {
    return dist > JOYSTICK_ENTER_DIST_PX ? dominant() : '';
  }

  // 滞回带：EXIT ~ ENTER 之间保持原方向不变
  if (dist < JOYSTICK_EXIT_DIST_PX) return '';
  if (dist <= JOYSTICK_ENTER_DIST_PX) return currentDir;

  const candidate = dominant();
  // 斜向模糊（无明确主轴）或未变向：保持
  if (candidate === '' || candidate === currentDir) return currentDir;

  // 同轴反向（回拉过中心）→ 直接换向，跟手
  const isReversal =
    (currentDir === 'left' && candidate === 'right') ||
    (currentDir === 'right' && candidate === 'left') ||
    (currentDir === 'up' && candidate === 'down') ||
    (currentDir === 'down' && candidate === 'up');
  if (isReversal) return candidate;

  // 垂直换向：要求新主轴明显压过当前轴，防止斜向微抖跳变
  const currentIsHorizontal = currentDir === 'left' || currentDir === 'right';
  const currentAxis = currentIsHorizontal ? absDx : absDy;
  const otherAxis = currentIsHorizontal ? absDy : absDx;
  return otherAxis >= currentAxis * JOYSTICK_SWITCH_AXIS_RATIO ? candidate : currentDir;
}

// distFromActivationPx：指尖相对「本次方向激活点」的距离（换向时原点重置）。
// 距离越近越慢，便于微调；达到 FULL_SPEED_DIST 后恒为全速。
export function computeJoystickRepeatIntervalMs(distFromActivationPx: number): number {
  const span = JOYSTICK_FULL_SPEED_DIST_PX - JOYSTICK_ENTER_DIST_PX;
  const ratio = Math.min(Math.max((distFromActivationPx - JOYSTICK_ENTER_DIST_PX) / span, 0), 1);
  return (
    JOYSTICK_REPEAT_MAX_INTERVAL_MS -
    ratio * (JOYSTICK_REPEAT_MAX_INTERVAL_MS - JOYSTICK_REPEAT_MIN_INTERVAL_MS)
  );
}
