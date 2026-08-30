import React from 'react';
import { BellDot, Check, LoaderCircle, Server, Settings2 } from 'lucide-react';
import type {
  DesktopServiceActivityBridge,
  DesktopServiceActivity,
} from '../desktop/nativeBridge';

interface DesktopServiceSwitcherProps {
  bridge: DesktopServiceActivityBridge;
  runningCount: number;
  reviewCount: number;
  labels: {
    switchService: string;
    openServices: string;
    current: string;
    running: string;
    review: string;
    idle: string;
    manageServices: string;
  };
}

export function DesktopServiceSwitcher({
  bridge,
  runningCount,
  reviewCount,
  labels,
}: DesktopServiceSwitcherProps) {
  const [services, setServices] = React.useState<DesktopServiceActivity[]>([]);
  const [open, setOpen] = React.useState(false);
  const hostRef = React.useRef<HTMLDivElement>(null);

  React.useEffect(() => bridge.onServiceActivity(setServices), [bridge]);

  React.useEffect(() => {
    bridge.reportServiceActivity({ runningCount, reviewCount });
  }, [bridge, reviewCount, runningCount]);

  React.useEffect(() => {
    if (!open) return;
    const handlePointerDown = (event: PointerEvent) => {
      if (!hostRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };
    document.addEventListener('pointerdown', handlePointerDown);
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('pointerdown', handlePointerDown);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [open]);

  if (services.length < 2) return null;

  const orderedServices = [...services].sort((left, right) => {
    if (left.current !== right.current) return left.current ? -1 : 1;
    if (left.reviewCount !== right.reviewCount) return right.reviewCount - left.reviewCount;
    if (left.runningCount !== right.runningCount) return right.runningCount - left.runningCount;
    return left.label.localeCompare(right.label);
  });
  const current = orderedServices.find((service) => service.current);
  const otherServices = orderedServices.filter((service) => !service.current);
  const otherRunning = otherServices.reduce((count, service) => count + service.runningCount, 0);
  const otherReview = otherServices.reduce((count, service) => count + service.reviewCount, 0);

  const focusService = async (origin: string) => {
    if (await bridge.focusService(origin)) setOpen(false);
  };

  return (
    <div ref={hostRef} className="relative z-20 shrink-0" data-testid="desktop-service-switcher">
      <button
        type="button"
        className={`inline-flex h-7 items-center gap-1.5 rounded-md px-2 text-[11px] ring-1 transition sm:h-8 ${
          otherReview > 0
            ? 'bg-[rgb(var(--warning-rgb)_/_0.12)] text-[color:var(--warning)] ring-[rgb(var(--warning-rgb)_/_0.22)] hover:bg-[rgb(var(--warning-rgb)_/_0.18)]'
            : 'bg-surface-2 text-muted-foreground ring-border/10 hover:bg-surface-elevated hover:text-foreground'
        }`}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={labels.switchService}
        title={current ? `${labels.switchService} · ${current.label}` : labels.switchService}
        onClick={() => setOpen((value) => !value)}
      >
        <Server size={13} className="shrink-0" />
        {otherRunning > 0 && (
          <span className="inline-flex items-center gap-0.5 text-[color:var(--success)]" title={`${labels.running}: ${otherRunning}`}>
            <LoaderCircle size={10} className="animate-spin" />
            <span className="tabular-nums">{otherRunning}</span>
          </span>
        )}
        {otherReview > 0 && (
          <span className="inline-flex items-center gap-0.5" title={`${labels.review}: ${otherReview}`}>
            <BellDot size={10} className="animate-pulse" />
            <span className="tabular-nums">{otherReview}</span>
          </span>
        )}
        {otherRunning === 0 && otherReview === 0 && (
          <span className="tabular-nums text-muted-foreground">{services.length}</span>
        )}
      </button>

      {open && (
        <div
          role="menu"
          aria-label={labels.openServices}
          className="absolute right-0 top-[calc(100%+0.4rem)] z-30 w-72 overflow-hidden rounded-xl border border-border/15 bg-surface-elevated p-1.5 text-foreground shadow-[0_18px_50px_var(--app-shadow-strong)]"
        >
          <div className="px-2.5 pb-1.5 pt-1 text-[10px] font-semibold uppercase tracking-[0.12em] text-muted-foreground">
            {labels.openServices}
          </div>
          {orderedServices.map((service) => {
            const idle = service.runningCount === 0 && service.reviewCount === 0;
            return (
              <button
                key={service.origin}
                type="button"
                role="menuitem"
                className="flex min-h-11 w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left transition hover:bg-surface-2 focus-visible:bg-surface-2 focus-visible:outline-none"
                onClick={() => void focusService(service.origin)}
              >
                <span className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-surface text-muted-foreground">
                  {service.current ? <Check size={13} className="text-primary" /> : <Server size={13} />}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="flex items-center gap-1.5">
                    <span className="truncate text-[12px] font-medium">{service.label}</span>
                    {service.current && <span className="shrink-0 text-[9px] text-primary">{labels.current}</span>}
                  </span>
                  <span className="mt-0.5 block truncate text-[9px] text-muted-foreground">{service.origin}</span>
                </span>
                <span className="flex shrink-0 items-center gap-1.5 text-[10px] tabular-nums">
                  {service.runningCount > 0 && (
                    <span className="inline-flex items-center gap-0.5 text-[color:var(--success)]" title={labels.running}>
                      <LoaderCircle size={10} className="animate-spin" />{service.runningCount}
                    </span>
                  )}
                  {service.reviewCount > 0 && (
                    <span className="inline-flex items-center gap-0.5 text-[color:var(--warning)]" title={labels.review}>
                      <BellDot size={10} />{service.reviewCount}
                    </span>
                  )}
                  {idle && <span className="text-muted-foreground">{labels.idle}</span>}
                </span>
              </button>
            );
          })}
          <div className="mt-1 border-t border-border/15 pt-1">
            <button
              type="button"
              role="menuitem"
              className="flex min-h-9 w-full items-center gap-2 rounded-lg px-2.5 text-left text-[11px] text-muted-foreground transition hover:bg-surface-2 hover:text-foreground focus-visible:bg-surface-2 focus-visible:outline-none"
              onClick={() => {
                setOpen(false);
                void bridge.showConnectionCenter();
              }}
            >
              <Settings2 size={13} />
              <span>{labels.manageServices}</span>
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
