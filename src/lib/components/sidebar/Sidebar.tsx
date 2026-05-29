import React, { useEffect, useRef } from 'react';

interface SidebarProps {
  side: 'left' | 'right';
  isOpen: boolean;
  isDragging?: boolean;
  dragProgress?: number;
  onClose: () => void;
  width?: string;
  children: React.ReactNode;
}

export function Sidebar({
  side,
  isOpen,
  isDragging = false,
  dragProgress = 0,
  onClose,
  width,
  children,
}: SidebarProps) {
  const panelRef = useRef<HTMLDivElement>(null);
  const isMobile = typeof window !== 'undefined' && window.innerWidth < 768;
  const panelWidth = width ?? (isMobile ? '85vw' : '360px');

  // Compute transform
  const getTransform = () => {
    if (isDragging && dragProgress > 0) {
      const offset = (1 - dragProgress) * 100;
      return side === 'left' ? `translateX(-${offset}%)` : `translateX(${offset}%)`;
    }
    if (isOpen) return 'translateX(0)';
    return side === 'left' ? 'translateX(-100%)' : 'translateX(100%)';
  };

  // Close on backdrop click
  const handleBackdropClick = () => {
    onClose();
  };

  // Close on Escape
  useEffect(() => {
    if (!isOpen) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [isOpen, onClose]);

  const showBackdrop = isOpen || (isDragging && dragProgress > 0.1);

  return (
    <>
      {/* Backdrop */}
      {showBackdrop && (
        <button
          type="button"
          className="fixed inset-0 z-40 bg-[rgba(0,0,0,0.5)] backdrop-blur-sm animate-fade-in cursor-default"
          onClick={handleBackdropClick}
          aria-label="Close sidebar"
        />
      )}

      {/* Panel */}
      <div
        ref={panelRef}
        data-sidebar={side}
        className={`fixed inset-y-0 z-50 flex flex-col bg-surface ${
          side === 'left'
            ? 'left-0 border-r border-border/15'
            : 'right-0 border-l border-border/15'
        }`}
        style={{
          width: panelWidth,
          maxWidth: '90vw',
          transform: getTransform(),
          transition: isDragging ? 'none' : 'transform 0.3s cubic-bezier(0.16, 1, 0.3, 1)',
          paddingTop: 'max(0px, env(safe-area-inset-top, 0px) - 24px)',
          paddingBottom: 'env(safe-area-inset-bottom, 0px)',
          ...(side === 'left'
            ? { paddingLeft: 'env(safe-area-inset-left, 0px)' }
            : { paddingRight: 'env(safe-area-inset-right, 0px)' }),
        }}
      >
        {children}
      </div>
    </>
  );
}
