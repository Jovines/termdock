import type { ConnectionIntent } from './browserIntegration';

export interface InviteDescriptor { v: 1; serviceId: string; code?: string; routeOnly?: boolean; entryUrl: string; serviceUrl?: string; name?: string; entryServiceId?: string; routeCode?: string }
const PREFIX = '#termdock-invite=';
export function createInviteLink(descriptor: InviteDescriptor): string {
  const entry = new URL(descriptor.entryUrl);
  entry.hash = ''; entry.search = ''; entry.pathname = '/';
  const bytes = new TextEncoder().encode(JSON.stringify(descriptor));
  entry.hash = PREFIX.slice(1) + btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  return entry.href;
}
export function parseInviteLink(value: string): ConnectionIntent {
  const link = new URL(value);
  if (!['https:', 'http:'].includes(link.protocol) || !link.hash.startsWith(PREFIX)) throw new Error('这不是有效的 Termdock 邀请链接');
  const encoded = link.hash.slice(PREFIX.length);
  if (encoded.length > 8192) throw new Error('邀请链接过长');
  let data: InviteDescriptor;
  try {
    const base64 = encoded.replace(/-/g, '+').replace(/_/g, '/');
    data = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Uint8Array.from(atob(base64), c => c.charCodeAt(0))));
  } catch { throw new Error('邀请链接不完整，请重新复制'); }
  if (data.v !== 1 || typeof data.serviceId !== 'string' || !/^12D3KooW[1-9A-HJ-NP-Za-km-z]{44}$/.test(data.serviceId) || (data.routeOnly !== true && (typeof data.code !== 'string' || !/^[A-Za-z0-9_-]{32,128}$/.test(data.code)))) throw new Error('邀请信息无效或版本不兼容');
  const entry = new URL(data.entryUrl);
  if (entry.origin !== link.origin || entry.username || entry.password || !['https:', 'http:'].includes(entry.protocol)) throw new Error('邀请地址与服务不一致');
  if (entry.protocol === 'http:' && !['localhost', '127.0.0.1', '[::1]'].includes(entry.hostname)) throw new Error('远程邀请需要 HTTPS');
  if (data.entryServiceId !== undefined && (typeof data.entryServiceId !== 'string' || !/^12D3KooW[1-9A-HJ-NP-Za-km-z]{44}$/.test(data.entryServiceId))) throw new Error('邀请入口身份无效');
  if (data.routeCode !== undefined && (typeof data.routeCode !== 'string' || !/^[A-Za-z0-9_-]{32,128}$/.test(data.routeCode) || !data.entryServiceId)) throw new Error('邀请入口权限无效');
  if (data.routeOnly === true && (!data.entryServiceId || !data.routeCode || data.code !== undefined)) throw new Error('备用连接邀请不完整');
  let serviceOrigin = entry.origin;
  if (data.serviceUrl !== undefined) {
    const service = new URL(data.serviceUrl);
    if (!['https:', 'http:'].includes(service.protocol) || service.username || service.password) throw new Error('目标服务地址无效');
    serviceOrigin = data.entryServiceId && data.entryServiceId !== data.serviceId ? service.origin : entry.origin;
  }
  return { url: entry.origin, targetPeerId: data.serviceId, pairingCode: data.code, ...(data.routeOnly === true ? { routeOnly: true } : {}), serviceOrigin, serviceName: typeof data.name === 'string' ? data.name.slice(0, 120) : undefined, entryServiceId: data.entryServiceId, routeCode: data.routeCode };
}
