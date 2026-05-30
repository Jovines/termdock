import React, { useEffect } from 'react';

interface SidebarProps {
  side: 'left' | 'right';
  isOpen: boolean;
  drawerWidthPx: number;
  onClose: () => void;
  children: React.ReactNode;
}

export const Sidebar = React.forwardRef<HTMLElement, SidebarProps>(function Sidebar(
  { side, isOpen, drawerWidthPx, onClose, children },
  ref,
) {
  const handleBackdropClick = () => onClose();

  useEffect(() => {
    if (!isOpen) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [isOpen, onClose]);

  const isLeft = side === 'left';

  return (
    <>
      {/* Backdrop — plain div, opacity toggled via CSS class */}
      <div
        data-sidebar-backdrop={side}
        className={`fixed inset-0 z-40 bg-[rgba(0,0,0,0.5)] backdrop-blur-sm cursor-default transition-opacity duration-250 ease-out ${
          isOpen ? 'opacity-100 pointer-events-auto' : 'opacity-0 pointer-events-none'
        }`}
        onClick={handleBackdropClick}
        aria-label="Close sidebar"
      />

      {/* Panel — plain aside, position controlled by direct DOM transform */}
      <aside
        ref={ref}
        data-sidebar={side}
        className={`fixed inset-y-0 z-50 flex flex-col bg-surface will-change-transform ${
          isLeft
            ? 'left-0 border-r border-border/15'
            : 'right-0 border-l border-border/15'
        }`}
        style={{
          width: drawerWidthPx,
          maxWidth: '90vw',
          transform: isLeft ? `translateX(-${drawerWidthPx}px)` : `translateX(${drawerWidthPx}px)`,
          paddingTop: 'max(0px, env(safe-area-inset-top, 0px) - 24px)',
          paddingBottom: 'env(safe-area-inset-bottom, 0px)',
          ...(isLeft
            ? { paddingLeft: 'env(safe-area-inset-left, 0px)' }
            : { paddingRight: 'env(safe-area-inset-right, 0px)' }),
        }}
      >
        {children}
      </aside>
    </>
  );
});
