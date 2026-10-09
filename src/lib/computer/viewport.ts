/** Use the visible control area from the first RDP handshake, including servers
 * whose login screen cannot resize dynamically. Preserve aspect on phones. */
export function computerDesktopSize(width: number, height: number) {
  width = Math.max(1, width || 1280); height = Math.max(1, height || 800);
  const factor = Math.max(1, 640 / width, 480 / height);
  return { width: Math.max(640, Math.min(2560, Math.round(width * factor))), height: Math.max(480, Math.min(1600, Math.round(height * factor))) };
}
