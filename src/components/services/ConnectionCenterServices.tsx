import { useEffect, useMemo, useRef, useState } from 'react';
import { ServiceManager } from './ServiceManager';
import type { TermdockDesktopBridge } from '../../lib/desktop/nativeBridge';
import { desktopCertificateTrust, openDesktopService, serviceConnectionInput, type ServiceConnectionReview } from '../../lib/services/desktopServiceConnection';
import type { ServiceConnection } from '../../lib/services/serviceDirectory';

/** The bundled center owns certificate approval for every desktop entry point. */
export function ConnectionCenterServices({ bridge }: { bridge: TermdockDesktopBridge }) {
  const certificateTrust = useMemo(() => desktopCertificateTrust(bridge), [bridge]);
  const [review, setReview] = useState<ServiceConnectionReview | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const reading = useRef(false);
  const active = useRef(false);
  const open = (service: ServiceConnection, invitation?: string) => openDesktopService(bridge, service, invitation);
  const add = async (input: string) => { const request = serviceConnectionInput(input); await open(request.connection, request.invitation); };
  useEffect(() => {
    active.current = true;
    const receive = async () => {
      if (review || busy || reading.current || !bridge.takeServiceConnectionReview) return;
      reading.current = true;
      try {
        const request = await bridge.takeServiceConnectionReview();
        if (active.current && request) setReview(request);
      } catch { if (active.current) setError('暂时无法读取工作区的连接请求，请重新打开连接中心后重试。'); }
      finally { reading.current = false; }
    };
    const unsubscribe = bridge.onServiceConnectionReview?.(() => { void receive(); });
    void receive();
    return () => { active.current = false; unsubscribe?.(); };
  }, [bridge, review, busy]);
  const input = review?.invitation || review?.connection.url;
  return <>
    {error && <p className="service-error" role="alert">{error}</p>}
    <div hidden={!!review}><ServiceManager certificateTrust={certificateTrust} onOpen={open} onAdd={add} onBusyChange={review ? undefined : setBusy} /></div>
    {review && <section aria-label="来自工作区的连接请求">
      <p className="service-help">此连接需要在连接中心继续检查。原工作区会保留。</p>
      <ServiceManager initiallyAdding autoConnect initialInput={input} certificateTrust={certificateTrust} onBusyChange={setBusy}
        onNavigation={navigation => { if (!navigation.title) setReview(null); }}
        onOpen={open} onAdd={async value => {
          if (value === input) await open(review.connection, review.invitation);
          else await add(value);
        }} />
    </section>}
  </>;
}
