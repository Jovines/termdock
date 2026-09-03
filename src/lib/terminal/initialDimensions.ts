export interface TerminalTextHeightMetrics {
  actualBoundingBoxAscent?: number;
  actualBoundingBoxDescent?: number;
  fontBoundingBoxAscent?: number;
  fontBoundingBoxDescent?: number;
}

function positiveMetric(value: number | undefined): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0;
}

/**
 * Match xterm's line-box measurement closely enough for the pre-open row count.
 * `actualBoundingBox*` only measures painted pixels (for example an uppercase M
 * has no descent), so using it as a line height can almost double the initial
 * number of rows. Prefer the font em box and retain the old glyph-box path only
 * for browsers that do not expose `fontBoundingBox*`.
 */
export function estimateTerminalCellHeight(
  metrics: TerminalTextHeightMetrics,
  fontSize: number,
  lineHeight: number,
): number {
  const fontBoxHeight = positiveMetric(metrics.fontBoundingBoxAscent)
    + positiveMetric(metrics.fontBoundingBoxDescent);
  const glyphBoxHeight = positiveMetric(metrics.actualBoundingBoxAscent)
    + positiveMetric(metrics.actualBoundingBoxDescent);
  const measuredHeight = fontBoxHeight || glyphBoxHeight || fontSize;
  return Math.max(1, Math.floor(Math.ceil(measuredHeight) * lineHeight));
}
