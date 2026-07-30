export const MOBILE_ATTENTION_SIZE_PX = 42;
export const MOBILE_ATTENTION_EDGE_GAP_PX = 20;

export interface MobileAttentionViewport {
  width: number;
  height: number;
  safeTop?: number;
  safeRight?: number;
  safeBottom?: number;
  safeLeft?: number;
}

export interface MobileAttentionPreference {
  side: 'left' | 'right';
  yRatio: number;
}

export interface MobileAttentionPosition {
  x: number;
  y: number;
}

interface MobileAttentionLimits {
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function getLimits(viewport: MobileAttentionViewport): MobileAttentionLimits {
  const safeTop = Math.max(0, viewport.safeTop ?? 0);
  const safeRight = Math.max(0, viewport.safeRight ?? 0);
  const safeBottom = Math.max(0, viewport.safeBottom ?? 0);
  const safeLeft = Math.max(0, viewport.safeLeft ?? 0);
  const minX = safeLeft + MOBILE_ATTENTION_EDGE_GAP_PX;
  const maxX = Math.max(
    minX,
    viewport.width - safeRight - MOBILE_ATTENTION_EDGE_GAP_PX - MOBILE_ATTENTION_SIZE_PX,
  );
  // Keep clear of the top tab bar and the persistent mobile keyboard toolbar.
  const minY = Math.max(safeTop + 12, 52);
  const maxY = Math.max(
    minY,
    viewport.height - safeBottom - 72 - MOBILE_ATTENTION_SIZE_PX,
  );
  return { minX, maxX, minY, maxY };
}

export function resolveMobileAttentionPosition(
  viewport: MobileAttentionViewport,
  preference: MobileAttentionPreference,
): MobileAttentionPosition {
  const limits = getLimits(viewport);
  const ratio = clamp(preference.yRatio, 0, 1);
  return {
    x: preference.side === 'left' ? limits.minX : limits.maxX,
    y: limits.minY + ((limits.maxY - limits.minY) * ratio),
  };
}

export function clampMobileAttentionDrag(
  viewport: MobileAttentionViewport,
  position: MobileAttentionPosition,
): MobileAttentionPosition {
  const limits = getLimits(viewport);
  return {
    x: clamp(position.x, limits.minX, limits.maxX),
    y: clamp(position.y, limits.minY, limits.maxY),
  };
}

export function snapMobileAttentionPosition(
  viewport: MobileAttentionViewport,
  position: MobileAttentionPosition,
): {
  position: MobileAttentionPosition;
  preference: MobileAttentionPreference;
} {
  const limits = getLimits(viewport);
  const clamped = clampMobileAttentionDrag(viewport, position);
  const side = clamped.x + (MOBILE_ATTENTION_SIZE_PX / 2) < viewport.width / 2
    ? 'left'
    : 'right';
  const verticalRange = limits.maxY - limits.minY;
  return {
    position: {
      x: side === 'left' ? limits.minX : limits.maxX,
      y: clamped.y,
    },
    preference: {
      side,
      yRatio: verticalRange > 0 ? (clamped.y - limits.minY) / verticalRange : 0,
    },
  };
}
