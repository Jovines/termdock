/**
 * scrcpy 控制协议序列化（对齐 scrcpy 3.x `app/src/control_msg.c`）。
 * 发送端全量走加密 secureSocket；这里只负责字节布局，不做传输。
 */

export const CONTROL_TYPE_INJECT_KEYCODE = 0;
export const CONTROL_TYPE_INJECT_TEXT = 1;
export const CONTROL_TYPE_INJECT_TOUCH_EVENT = 2;
export const CONTROL_TYPE_INJECT_SCROLL_EVENT = 3;
export const CONTROL_TYPE_BACK_OR_SCREEN_ON = 4;
export const CONTROL_TYPE_EXPAND_NOTIFICATION_PANEL = 5;
export const CONTROL_TYPE_EXPAND_SETTINGS_PANEL = 6;
export const CONTROL_TYPE_COLLAPSE_PANELS = 7;
export const CONTROL_TYPE_SET_DISPLAY_POWER = 10;
export const CONTROL_TYPE_ROTATE_DEVICE = 11;
export const CONTROL_TYPE_START_APP = 16;
export const CONTROL_TYPE_RESET_VIDEO = 17;

/** Android MotionEvent action（`android/input.h`）。 */
export const MOTION_ACTION_DOWN = 0;
export const MOTION_ACTION_UP = 1;
export const MOTION_ACTION_MOVE = 2;
export const MOTION_ACTION_CANCEL = 3;

/** Android KeyEvent action。 */
export const KEY_ACTION_DOWN = 0;
export const KEY_ACTION_UP = 1;

export const BUTTON_PRIMARY = 1;

/** scrcpy 约定：-1 表示鼠标指针，-2 表示单指触摸。 */
export const POINTER_ID_MOUSE = 0xffffffffffffffffn;
export const POINTER_ID_FINGER = 0xfffffffffffffffen;

export const ANDROID_KEYCODE = {
  HOME: 3,
  BACK: 4,
  MENU: 82,
  APP_SWITCH: 187,
  POWER: 26,
  VOLUME_UP: 24,
  VOLUME_DOWN: 25,
  ENTER: 66,
  DEL: 67,
} as const;

export interface TouchPoint { x: number; y: number; screenWidth: number; screenHeight: number }

function writePosition(view: DataView, offset: number, point: TouchPoint): void {
  view.setUint32(offset, Math.max(0, Math.round(point.x)) & 0xffffffff);
  view.setUint32(offset + 4, Math.max(0, Math.round(point.y)) & 0xffffffff);
  view.setUint16(offset + 8, Math.min(65535, Math.round(point.screenWidth)));
  view.setUint16(offset + 10, Math.min(65535, Math.round(point.screenHeight)));
}

/** type 2：`action u8 + pointerId u64be + position(12) + pressure u16fp + actionButton u32be + buttons u32be` */
export function serializeTouch(action: number, pointerId: bigint, point: TouchPoint, pressure: number, actionButton: number, buttons: number): Uint8Array {
  const buffer = new Uint8Array(32);
  const view = new DataView(buffer.buffer);
  view.setUint8(0, CONTROL_TYPE_INJECT_TOUCH_EVENT);
  view.setUint8(1, action);
  view.setBigUint64(2, pointerId);
  writePosition(view, 10, point);
  view.setUint16(22, Math.max(0, Math.min(0xffff, Math.round(pressure * 0x10000))));
  view.setUint32(24, actionButton >>> 0);
  view.setUint32(28, buttons >>> 0);
  return buffer;
}

/** type 0：`action u8 + keycode u32be + repeat u32be + metaState u32be` */
export function serializeKeycode(action: number, keycode: number, repeat = 0, metaState = 0): Uint8Array {
  const buffer = new Uint8Array(14);
  const view = new DataView(buffer.buffer);
  view.setUint8(0, CONTROL_TYPE_INJECT_KEYCODE);
  view.setUint8(1, action);
  view.setUint32(2, keycode >>> 0);
  view.setUint32(6, repeat >>> 0);
  view.setUint32(10, metaState >>> 0);
  return buffer;
}

/** type 3：`position(12) + hscroll i16fp + vscroll i16fp + buttons u32be` */
export function serializeScroll(point: TouchPoint, hScroll: number, vScroll: number, buttons = 0): Uint8Array {
  const buffer = new Uint8Array(21);
  const view = new DataView(buffer.buffer);
  view.setUint8(0, CONTROL_TYPE_INJECT_SCROLL_EVENT);
  writePosition(view, 1, point);
  const toFixed = (value: number) => Math.max(-32768, Math.min(32767, Math.round(Math.max(-1, Math.min(1, value / 16)) * 0x8000)));
  view.setInt16(13, toFixed(hScroll));
  view.setInt16(15, toFixed(vScroll));
  view.setUint32(17, buttons >>> 0);
  return buffer;
}

/** type 1：`length u32be + utf8`（上限 300 字节，与 scrcpy 一致）。 */
export function serializeText(text: string): Uint8Array | null {
  const encoded = new TextEncoder().encode(text);
  if (!encoded.length) return null;
  const body = encoded.subarray(0, 300);
  const buffer = new Uint8Array(5 + body.length);
  const view = new DataView(buffer.buffer);
  view.setUint8(0, CONTROL_TYPE_INJECT_TEXT);
  view.setUint32(1, body.length);
  buffer.set(body, 5);
  return buffer;
}

/** type 16：`length u8 + utf8`。 */
export function serializeStartApp(name: string): Uint8Array | null {
  const encoded = new TextEncoder().encode(name);
  if (!encoded.length || encoded.length > 255) return null;
  const buffer = new Uint8Array(2 + encoded.length);
  buffer[0] = CONTROL_TYPE_START_APP;
  buffer[1] = encoded.length;
  buffer.set(encoded, 2);
  return buffer;
}

export function serializeSimple(type: number): Uint8Array {
  return new Uint8Array([type]);
}

/** type 4：返回/亮屏。action 为 KEY_ACTION_DOWN/UP。 */
export function serializeBackOrScreenOn(action: number): Uint8Array {
  return new Uint8Array([CONTROL_TYPE_BACK_OR_SCREEN_ON, action]);
}

/** type 10：`on u8`。 */
export function serializeDisplayPower(on: boolean): Uint8Array {
  return new Uint8Array([CONTROL_TYPE_SET_DISPLAY_POWER, on ? 1 : 0]);
}

export function toBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let index = 0; index < bytes.length; index += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
  }
  return btoa(binary);
}

export function fromBase64(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
  return bytes;
}
