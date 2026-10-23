import { useEffect, useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from 'react';
/** Keep offscreen prose as a measured spacer; a screen of overscan prepares it
 * before it enters view. Interactive replies keep their mounted form state. */
export function ChatMessageViewport({ id, root, heights, estimate, eager, preserve, nearby, children }: {
  id: string; root?: RefObject<HTMLDivElement>; heights?: Map<string, number>;
  estimate: number; eager: boolean; nearby?: Set<string>; preserve?: boolean; children: ReactNode;
}) {
  const [visible, setVisible] = useState(() => !root || typeof IntersectionObserver === 'undefined' || eager);
  const node = useRef<HTMLDivElement>(null), measured = useRef(heights?.get(id) ?? estimate);
  useEffect(() => {
    const container = root?.current, element = node.current;
    if (!container || !element || typeof IntersectionObserver === 'undefined') return;
    const observer = new IntersectionObserver(entries => {
      if (!container.clientHeight) return;
      const entry = entries.find(item => item.target === element);
      if (!entry) return;
      if (entry.isIntersecting) nearby?.add(id); else nearby?.delete(id);
      if (entry.isIntersecting) setVisible(true);
      else if (!preserve && !element.contains(document.activeElement)) {
        const selection = window.getSelection();
        if (!selection?.toString() || !element.contains(selection.anchorNode) && !element.contains(selection.focusNode)) setVisible(false);
      }
    }, { root: container, rootMargin: `${container.clientHeight}px 0px` });
    observer.observe(element);
    return () => observer.disconnect();
  }, [root, preserve, nearby, id]);
  useLayoutEffect(() => {
    const element = node.current;
    if (!visible || !element) return;
    const measure = () => {
      const height = element.getBoundingClientRect().height;
      if (height <= 0) return;
      const previous = measured.current, container = root?.current;
      // Rendering an overscanned row above the viewport must not push the text
      // currently being read down as its measured height replaces the estimate.
      if (container?.clientHeight && element.getBoundingClientRect().top + previous <= container.getBoundingClientRect().top + 1) container.scrollTop += height - previous;
      measured.current = height; heights?.set(id, height);
    };
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(measure); observer.observe(element);
    return () => observer.disconnect();
  }, [visible, children, id, root, heights]);
  return <div ref={node} data-chat-viewport-row={id} style={visible ? undefined : { height: measured.current }}>
    {visible ? children : <div aria-hidden="true" className="space-y-3 py-3"><div className="chat-loading-skeleton h-3 w-3/4 rounded bg-surface-2" /><div className="chat-loading-skeleton h-3 w-1/2 rounded bg-surface-2" /></div>}
  </div>;
}
