/** Replace the grid without RIS: xterm's full reset rebuilds the renderer
 * synchronously, exposing blank rows even inside synchronized output.
 * DECSTR resets attributes, origin and margins without rebuilding the surface.
 * It also resets DEC modes, so begin synchronized output immediately after it.
 */
export function buildTmuxScreenReplacement(chunks: readonly string[]): string[] {
  return [`\x1b[!p\x1b[?2026h\x1b[H\x1b[2J\x1b[3J${chunks.join('')}\x1b[?2026l`];
}
