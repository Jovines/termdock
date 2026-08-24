import type { CSSProperties, ReactNode } from 'react';
import { Link2 as RiLink } from 'lucide-react';

export interface FloatingAnnotationAnchor {
  xPercent: number;
  yPercent: number;
}

export function getFloatingAnnotationButtonStyle(anchor: FloatingAnnotationAnchor): CSSProperties {
  const x = Math.max(0, Math.min(100, anchor.xPercent));
  const y = Math.max(0, Math.min(100, anchor.yPercent));
  return {
    ...(x <= 50 ? { left: `calc(${x}% + 8px)` } : { right: `calc(${100 - x}% + 8px)` }),
    ...(y <= 50 ? { top: `calc(${y}% + 8px)` } : { bottom: `calc(${100 - y}% + 8px)` }),
  };
}

export function FloatingAnnotationButton({
  anchor,
  children,
  disabled = false,
  onClick,
  title,
}: {
  anchor: FloatingAnnotationAnchor;
  children: ReactNode;
  disabled?: boolean;
  onClick: () => void;
  title?: string;
}) {
  return (
    <button
      type="button"
      data-floating-annotation-button
      disabled={disabled}
      onClick={(event) => {
        event.stopPropagation();
        onClick();
      }}
      title={title}
      style={getFloatingAnnotationButtonStyle(anchor)}
      className="absolute z-30 inline-flex h-7 items-center gap-1 rounded-full bg-primary px-3 text-[11px] font-semibold text-primary-foreground shadow-lg ring-1 ring-primary/30 transition hover:bg-primary/90 active:scale-95 disabled:cursor-wait disabled:opacity-50"
    >
      <RiLink size={11} />
      {children}
    </button>
  );
}
