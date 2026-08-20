export interface ImeAnchorOffset {
  x: number;
  y: number;
}

function createsFixedContainingBlock(style: CSSStyleDeclaration): boolean {
  const willChange = style.willChange
    .split(',')
    .map((value) => value.trim());
  const isApplied = (value: string | undefined, initialValue: string) =>
    Boolean(value && value !== initialValue);

  return isApplied(style.transform, 'none')
    || isApplied(style.perspective, 'none')
    || isApplied(style.filter, 'none')
    || isApplied(style.backdropFilter, 'none')
    || isApplied(style.containerType, 'normal')
    || style.contain.includes('layout')
    || style.contain.includes('paint')
    || style.contain.includes('strict')
    || style.contain.includes('content')
    || willChange.includes('transform')
    || willChange.includes('perspective')
    || willChange.includes('filter');
}

/** Find the ancestor that establishes the coordinate system for a fixed child. */
export function findFixedContainingBlock(element: HTMLElement): HTMLElement | null {
  let ancestor = element.parentElement;
  while (ancestor) {
    if (createsFixedContainingBlock(window.getComputedStyle(ancestor))) {
      return ancestor;
    }
    ancestor = ancestor.parentElement;
  }
  return null;
}

/**
 * Convert a point inside the xterm element into the CSS coordinate system used
 * by a fixed input. A transformed Swiper wrapper commonly becomes that fixed
 * input's containing block, so terminal-local coordinates alone are not enough.
 */
export function resolveImeAnchorOffset(
  terminalElement: HTMLElement,
  containingBlock: HTMLElement | null,
  localX: number,
  localY: number,
): ImeAnchorOffset {
  const terminalRect = terminalElement.getBoundingClientRect();
  let containingLeft = 0;
  let containingTop = 0;
  if (containingBlock) {
    const containingRect = containingBlock.getBoundingClientRect();
    containingLeft = containingRect.left + containingBlock.clientLeft;
    containingTop = containingRect.top + containingBlock.clientTop;
  }

  return {
    x: terminalRect.left - containingLeft + localX,
    y: terminalRect.top - containingTop + localY,
  };
}
