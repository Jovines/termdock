import { useEffect, useRef, useState, type MouseEvent, type ReactNode } from 'react';
import { Trash2 } from 'lucide-react';

const ACTION_WIDTH = 64;
const AXIS_SLOP = 10;
// Leave a stationary press to the existing touch drag sensor (120ms lift).
const DRAG_LIFT_MS = 120;

interface Props {
  children: ReactNode;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onClose: (event: MouseEvent) => void;
  closeLabel: string;
  closeTitle: string;
  compact?: boolean;
}

/** Right swipes reveal a close action, dispatched through the supplied session close handler. */
export function SwipeToCloseSession({ children, open, onOpenChange, onClose, closeLabel, closeTitle, compact }: Props) {
  const rootRef = useRef<HTMLDivElement>(null);
  const gestureRef = useRef<{
    pointerId: number; x: number; y: number; startedAt: number;
    initialOffset: number; offset: number; horizontal: boolean;
  } | null>(null);
  const suppressClickUntilRef = useRef(0);
  const [dragOffset, setDragOffset] = useState<number | null>(null);
  const offset = dragOffset ?? (open ? ACTION_WIDTH : 0);

  useEffect(() => {
    if (!open) return;
    const dismiss = (event: PointerEvent) => {
      if (event.target instanceof Node && !rootRef.current?.contains(event.target)) onOpenChange(false);
    };
    document.addEventListener('pointerdown', dismiss, true);
    return () => document.removeEventListener('pointerdown', dismiss, true);
  }, [open, onOpenChange]);

  return (
    <div
      ref={rootRef}
      data-sidebar-gesture-ignore
      data-session-swipe
      className={`relative flex min-w-0 flex-1 items-center ${compact ? '' : 'gap-1'}`}
      style={{ touchAction: 'pan-y' }}
      onPointerDown={(event) => {
        suppressClickUntilRef.current = 0;
        if (event.pointerType !== 'touch' && event.pointerType !== 'pen') return;
        if (event.isPrimary === false) {
          gestureRef.current = null;
          setDragOffset(null);
          return;
        }
        if (!(event.target instanceof Element) || !event.target.closest('.sidebar-session-primary')) return;
        gestureRef.current = {
          pointerId: event.pointerId, x: event.clientX, y: event.clientY, startedAt: Date.now(),
          initialOffset: open ? ACTION_WIDTH : 0, offset: open ? ACTION_WIDTH : 0, horizontal: false,
        };
      }}
      onPointerMove={(event) => {
        const gesture = gestureRef.current;
        if (!gesture || gesture.pointerId !== event.pointerId) return;
        const dx = event.clientX - gesture.x;
        const dy = event.clientY - gesture.y;
        if (!gesture.horizontal) {
          if (event.defaultPrevented || Date.now() - gesture.startedAt >= DRAG_LIFT_MS || Math.abs(dy) > AXIS_SLOP) {
            gestureRef.current = null;
            return;
          }
          if (Math.abs(dx) <= AXIS_SLOP) return;
          if (Math.abs(dx) < Math.abs(dy) * 1.5 || (!open && dx < 0)) {
            gestureRef.current = null;
            return;
          }
          gesture.horizontal = true;
          event.currentTarget.setPointerCapture?.(event.pointerId);
        }
        event.preventDefault();
        gesture.offset = Math.max(0, Math.min(ACTION_WIDTH, gesture.initialOffset + dx));
        setDragOffset(gesture.offset);
      }}
      onPointerUp={(event) => {
        const gesture = gestureRef.current;
        if (!gesture || gesture.pointerId !== event.pointerId) return;
        gestureRef.current = null;
        if (!gesture.horizontal) return;
        suppressClickUntilRef.current = Date.now() + 600;
        onOpenChange(gesture.offset >= ACTION_WIDTH / 2);
        setDragOffset(null);
      }}
      onPointerCancel={() => {
        if (gestureRef.current?.horizontal) suppressClickUntilRef.current = Date.now() + 600;
        gestureRef.current = null;
        setDragOffset(null);
      }}
      onClickCapture={(event) => {
        if (Date.now() < suppressClickUntilRef.current) {
          suppressClickUntilRef.current = 0;
          event.preventDefault();
          event.stopPropagation();
          return;
        }
        if (open && event.target instanceof Element && event.target.closest('.sidebar-session-primary')) {
          onOpenChange(false);
          event.preventDefault();
          event.stopPropagation();
        }
      }}
      onKeyDown={(event) => {
        if (open && event.key === 'Escape') {
          event.stopPropagation();
          onOpenChange(false);
        }
      }}
    >
      <div
        className="shrink-0 overflow-hidden rounded-md transition-[width] duration-150 ease-out motion-reduce:transition-none"
        style={{ width: offset, transition: dragOffset === null ? undefined : 'none' }}
      >
        {offset > 0 && (
          <button
            type="button"
            tabIndex={open ? 0 : -1}
            aria-hidden={!open}
            aria-label={closeTitle}
            className="flex min-h-8 w-16 flex-col items-center justify-center gap-0.5 bg-destructive py-1 text-[10px] text-destructive-foreground"
            onClick={(event) => {
              event.stopPropagation();
              onOpenChange(false);
              onClose(event);
            }}
          >
            <Trash2 size={14} />
            {closeLabel}
          </button>
        )}
      </div>
      {children}
    </div>
  );
}
