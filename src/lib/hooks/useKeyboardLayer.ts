import { useLayoutEffect, useRef, useSyncExternalStore, type RefObject } from 'react';

interface KeyboardLayer { element: HTMLElement }
const layers: KeyboardLayer[] = [];
const listeners = new Set<() => void>();
const notify = () => listeners.forEach((listener) => listener());

export const isKeyboardLayerOpen = () => layers.length > 0;
export function useKeyboardLayerOpen(): boolean {
  return useSyncExternalStore((listener) => {
    listeners.add(listener);
    return () => { listeners.delete(listener); };
  }, isKeyboardLayerOpen, () => false);
}

function roots(element: HTMLElement): HTMLElement[] {
  const portals = Array.from(document.querySelectorAll<HTMLElement>('[data-sidebar-composer-popover]'))
    .filter((portal) => element.id && portal.dataset.sidebarComposerPopover === element.id);
  return [element, ...portals];
}

function visibleInLayer(control: HTMLElement, layerRoots: HTMLElement[]): boolean {
  for (let node: HTMLElement | null = control; node; node = node.parentElement) {
    const style = getComputedStyle(node);
    if (style.display === 'none' || style.visibility === 'hidden') return false;
    if (layerRoots.includes(node)) break;
  }
  return true;
}

function controls(element: HTMLElement): HTMLElement[] {
  const layerRoots = roots(element);
  return layerRoots.flatMap((root) => Array.from(root.querySelectorAll<HTMLElement>(
    'button:not(:disabled), input:not(:disabled), textarea:not(:disabled), select:not(:disabled), a[href], summary, [tabindex]',
  ))).filter((control) => {
    const closedDetails = control.closest('details:not([open])');
    const summary = closedDetails?.querySelector('summary');
    return control.tabIndex >= 0 && !control.matches(':disabled') && !control.closest('[hidden], [inert], [aria-hidden="true"]')
      && (!closedDetails || !!summary?.contains(control))
      && visibleInLayer(control, layerRoots);
  });
}

/** Temporary tasks own keyboard input until their topmost layer closes. */
export function useKeyboardLayer(ref: RefObject<HTMLElement>, open: boolean, onEscape: () => void, restoreFocus?: () => HTMLElement | null): void {
  const escapeRef = useRef(onEscape);
  escapeRef.current = onEscape;
  const restoreRef = useRef(restoreFocus);
  restoreRef.current = restoreFocus;
  useLayoutEffect(() => {
    const element = ref.current;
    if (!open || !element) return;
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const layer = { element };
    // Child layout effects can register before their parent in the same commit.
    // A containing layer belongs beneath its already registered descendants.
    const descendant = layers.findIndex(candidate => element.contains(candidate.element));
    if (descendant < 0) layers.push(layer); else layers.splice(descendant, 0, layer);
    notify();
    const isTop = () => layers[layers.length - 1] === layer;
    const contains = (target: EventTarget | null) => target instanceof Node && roots(element).some((root) => root.contains(target));
    const focusFirst = () => (controls(element)[0] ?? element).focus({ preventScroll: true });
    if (isTop()) focusFirst();
    const keepFocus = (event: FocusEvent) => {
      if (isTop() && !contains(event.target)) focusFirst();
    };
    const trapTab = (event: KeyboardEvent) => {
      if (!isTop() || event.key !== 'Tab' || event.defaultPrevented) return;
      const items = controls(element);
      const first = items[0];
      const last = items[items.length - 1];
      if (!first || !contains(document.activeElement)
        || (event.shiftKey ? document.activeElement === first : document.activeElement === last)) {
        event.preventDefault();
        (event.shiftKey ? last : first)?.focus({ preventScroll: true });
      }
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (!isTop() || event.key !== 'Escape' || event.defaultPrevented || event.isComposing) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      escapeRef.current();
    };
    document.addEventListener('focusin', keepFocus, true);
    document.addEventListener('keydown', trapTab, true);
    document.addEventListener('keydown', closeOnEscape);
    return () => {
      const wasTop = isTop();
      layers.splice(layers.indexOf(layer), 1);
      notify();
      document.removeEventListener('focusin', keepFocus, true);
      document.removeEventListener('keydown', trapTab, true);
      document.removeEventListener('keydown', closeOnEscape);
      if (wasTop) {
        const remainingTop = layers[layers.length - 1];
        // React can remove the original trigger after layout cleanup. Restore
        // after that commit so recreated launch buttons can receive focus.
        queueMicrotask(() => {
          if (layers[layers.length - 1] !== remainingTop) return;
          const target = previous?.isConnected && previous !== document.body ? previous : restoreRef.current?.();
          target?.focus({ preventScroll: true });
        });
      }
    };
  }, [open, ref]);
}
