import { ConnectionQualityDetails } from './ConnectionQualityDetails';
import React from 'react';
import { getTerminalConnectionQuality } from '../../terminal/api';
import type { ConnectionQuality } from '../../terminal/connectionQuality';
import { useI18n } from '../../i18n';

export function ConnectionQualitySettings({ backendSessionId }: { backendSessionId: string | null }) {
  const { locale } = useI18n();
  const zh = locale === 'zh';
  const [quality, setQuality] = React.useState<ConnectionQuality | null>(null);
  const [expanded, setExpanded] = React.useState(false);
  React.useEffect(() => {
    setQuality(null);
    if (!expanded || !backendSessionId) return;
    const update = () => setQuality(getTerminalConnectionQuality(backendSessionId));
    update();
    const timer = setInterval(update, 1000);
    document.addEventListener('visibilitychange', update);
    return () => { clearInterval(timer); document.removeEventListener('visibilitychange', update); };
  }, [backendSessionId, expanded]);
  const route = quality?.diagnostics;
  const rtt = quality?.rtt;
  const label = !quality?.connected ? (zh ? '未连接' : 'Disconnected')
    : quality.waiting ? (zh ? '等待响应…' : 'Waiting for reply…')
    : rtt == null ? (zh ? '测量中…' : 'Measuring…')
    : `${rtt} ms · ${rtt < 150 ? (zh ? '流畅' : 'Low latency') : rtt < 300 ? (zh ? '有延迟' : 'Moderate latency') : (zh ? '高延迟' : 'High latency')}`;
  const ms = (value: number | null | undefined) => value == null ? '—' : `${Math.round(value)} ms`;
  return (
    <div className="mt-3 rounded-xl bg-surface-2 px-3 text-muted-foreground">
      <button type="button" aria-expanded={expanded} onClick={() => setExpanded(value => !value)}
        className="flex min-h-11 w-full items-center gap-2 py-2 text-[12px] tabular-nums hover:text-foreground"
        aria-label={`${zh ? '连接质量' : 'Connection quality'}${expanded ? `: ${label}` : ''}`}>
        <span aria-hidden="true" className={`h-1.5 w-1.5 rounded-full ${expanded && quality && (!quality.connected || quality.waiting || (rtt != null && rtt >= 300)) ? 'bg-destructive' : 'bg-current'}`} />
        <span className="flex-1 text-left">{zh ? '连接质量' : 'Connection quality'}{expanded ? ` · ${label}` : ''}</span>
        <span aria-hidden="true">{expanded ? '▾' : '▸'}</span>
      </button>
      {expanded && <div className="pb-3 text-[11px] leading-relaxed">
        {!backendSessionId && <p>{zh ? '请先打开一个终端会话，再查看连接质量。' : 'Open a terminal session to measure connection quality.'}</p>}
        <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-2 tabular-nums">
          <dt>{zh ? '近期延迟' : 'Recent latency'}</dt>
          <dd className="text-right text-foreground">{quality?.minimum == null ? '—' : `${Math.round(quality.minimum)}–${Math.round(quality.maximum ?? quality.minimum)} ms`}</dd>
          <dt>{zh ? '波动' : 'Jitter'}</dt>
          <dd className="text-right text-foreground">{ms(quality?.jitter)}</dd>
          <dt>{zh ? '探测超时' : 'Probe timeouts'}</dt>
          <dd className="text-right text-foreground">{quality?.samples ? `${quality.timeouts} / ${quality.samples}` : '—'}</dd>
          <dt>{zh ? '连接路径' : 'Connection route'}</dt>
          <dd className="text-right text-foreground break-words">{route
            ? `${route.path === 'relay' ? (zh ? '经入口中转' : 'Via relay') : (zh ? '直连' : 'Direct')} · ${route.endpoint}`
            : '—'}</dd>
        </dl>
        <p className="mt-2">{zh ? '每 5 秒更新，统计最近 20 次；波动越小越稳定。' : 'Updates every 5s, using the last 20 probes. Lower jitter means more consistent latency.'}</p>
        <details className="mt-3 border-t border-border/30 pt-2">
          <summary className="cursor-pointer py-1 hover:text-foreground">{zh ? '诊断详情' : 'Diagnostics'}</summary>
          <ConnectionQualityDetails quality={quality} />
        </details>
      </div>}
    </div>
  );
}
