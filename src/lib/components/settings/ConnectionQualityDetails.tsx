import React from 'react';
import type { ConnectionQuality } from '../../terminal/connectionQuality';
import { useI18n } from '../../i18n';

export function ConnectionQualityDetails({ quality }: { quality: ConnectionQuality | null }) {
  const { locale } = useI18n();
  const tr = (zh: string, en: string) => locale === 'zh' ? zh : en;
  const ms = (value?: number | null) => value == null || !Number.isFinite(value) ? '—' : `${value.toFixed(1)} ms`;
  const d = quality?.diagnostics;
  const rows = (items: Array<[string, React.ReactNode]>) => <dl className="grid grid-cols-[minmax(0,1fr)_auto] gap-x-3 gap-y-1.5 tabular-nums">
    {items.map(([name, value]) => <React.Fragment key={name}><dt>{name}</dt><dd className="text-right text-foreground break-all">{value}</dd></React.Fragment>)}
  </dl>;
  const section = (title: string, content: React.ReactNode) => <section className="mt-3 border-t border-border/30 pt-3">
    <h3 className="mb-2 font-medium text-foreground">{title}</h3>{content}
  </section>;
  return <div className="text-[11px] leading-relaxed">
    {section(tr('往返统计', 'Round-trip statistics'), <>
      {rows([
        [tr('平均延迟', 'Average latency'), ms(quality?.average)],
        ['P95', ms(quality?.p95)],
        [tr('服务端回包处理', 'Server reply handler'), ms(quality?.handlerMs)],
      ])}
      <p className="mt-2">{tr('8 秒未响应计为超时，不等于网络丢包。回包处理仅含消息解析至构造回复，不含解密、排队和发包。', 'A probe times out after 8s; this is not packet loss. Handler timing covers parsing through reply creation, excluding decryption, queues and transmission.')}</p>
    </>)}
    {section(tr('当前发送与排队', 'Current buffers and queues'), d ? <>
      {rows([
        [tr('传输层发送缓冲', 'Transport send buffer'), `${d.bufferedBytes} B`],
        [tr('加密通道待发送', 'Channel writes pending'), d.pendingWrites ? tr('有', 'Yes') : tr('无', 'No')],
        [tr('进行中的非终端请求', 'Active non-terminal requests'), d.activeRequests],
        [tr('等待通道的请求', 'Requests waiting for capacity'), d.waitingRequests],
      ])}
      <p className="mt-2">{tr('属于此服务共用的连接，包含文件等其他请求。', 'Shared by this service, including file transfers and other requests.')}</p>
    </> : <p>{tr('尚无连接记录。', 'No connection record yet.')}</p>)}
    {section(tr('本次连接建立 · 历史耗时', 'Connection setup · recorded timings'), <>
      {rows([
        [tr('传输通道就绪', 'Transport ready'), ms(d?.transportOpenMs)],
        ...(d?.relay ? [
          [tr('其中：连上入口 WebSocket', 'Within transport: entry WebSocket'), ms(d.relay.entryOpenMs)],
          [tr('其中：请求中转至通道打开', 'Within transport: relay open request'), ms(d.relay.routeOpenMs)],
        ] as Array<[string, React.ReactNode]> : []),
        [tr('Noise 加密握手', 'Noise handshake'), ms(d?.handshakeMs)],
        [tr('终端逻辑通道就绪', 'Terminal logical channel ready'), ms(d?.socketOpenMs)],
        [tr('其中：等待本地通道名额', 'Within logical open: local capacity wait'), ms(d?.socketQueueMs)],
      ])}
      <p className="mt-2">{tr('这是建链时的历史耗时，不代表当前延迟。“其中”为子项，不能重复相加；中转耗时含处理和建链，不含之前的授权。', 'Recorded setup timings, not live latency. “Within” rows are subsets, not additive. Relay timing includes processing and setup, excluding earlier authorization.')}</p>
    </>)}
  </div>;
}
