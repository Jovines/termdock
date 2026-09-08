import { randomUUID } from 'node:crypto';
import type { SavedConnection } from './types.js';

function address(value: unknown): string {
  if (typeof value !== 'string' || value.length > 2048) throw new Error('服务地址无效。');
  const url = new URL(value);
  if (url.protocol === 'wss:') url.protocol = 'https:';
  if (url.protocol === 'ws:') url.protocol = 'http:';
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash || !['/', '/api/federation/secure'].includes(url.pathname)) throw new Error('请输入服务首页地址。');
  return url.origin;
}
function peer(value: unknown): string | undefined {
  if (value === undefined) return;
  if (typeof value !== 'string' || !/^12D3KooW[1-9A-HJ-NP-Za-km-z]{44}$/.test(value)) throw new Error('服务身份无效。');
  return value;
}
/** Whitelist metadata so passwords, invitation codes, and route tickets cannot
 * accidentally enter desktop.json or the restore list. */
export function serviceConnection(input: unknown): SavedConnection {
  if (!input || typeof input !== 'object') throw new Error('服务信息无效。');
  const value = input as Record<string, unknown>;
  const url = address(value.url), targetPeerId = peer(value.targetPeerId), entryServiceId = peer(value.entryServiceId);
  if (entryServiceId && !targetPeerId) throw new Error('缺少目标服务信息。');
  const label = typeof value.label === 'string' ? value.label.trim() : '';
  if (label.length > 120 || /[\x00-\x1f\x7f]/.test(label)) throw new Error('服务名称无效。');
  return { id: typeof value.id === 'string' && value.id.length > 0 && value.id.length <= 512 ? value.id : randomUUID(), url, label: label || new URL(url).host,
    ...(targetPeerId ? { targetPeerId } : {}), ...(entryServiceId ? { entryServiceId } : {}),
    ...(value.serviceOrigin !== undefined ? { serviceOrigin: address(value.serviceOrigin) } : {}),
    ...(Array.isArray(value.routes) ? { routes: value.routes.slice(0, 4).map(route => { const targetPeerId = peer(route?.targetPeerId); if (!targetPeerId) throw new Error('备用服务身份无效。'); return { url: address(route.url), targetPeerId }; }) } : {}) };
}
export function sameServiceConnection(left: SavedConnection, right: SavedConnection): boolean {
  if (left.targetPeerId && right.targetPeerId) return left.targetPeerId === right.targetPeerId;
  return (left.serviceOrigin || left.url) === (right.serviceOrigin || right.url);
}
export function serviceConnectionKeys(connection: SavedConnection): string[] {
  return [connection.id, connection.targetPeerId, connection.serviceOrigin || connection.url].filter((key): key is string => !!key);
}
export function importServiceConnection(current: SavedConnection[], removedKeys: string[], input: unknown): SavedConnection[] {
  const candidate = serviceConnection(input);
  return serviceConnectionKeys(candidate).some(key => removedKeys.includes(key)) ? current : upsertServiceConnection(current, candidate);
}
export function upsertServiceConnection(current: SavedConnection[], input: unknown): SavedConnection[] {
  const next = serviceConnection(input);
  const old = current.find(item => item.id === next.id || sameServiceConnection(item, next));
  // Updating a name from an older renderer must retain the verified route/pin.
  const merged = { ...old, ...next, id: old?.id || next.id };
  return [...current.filter(item => item !== old), merged];
}
export function invitationForService(value: unknown, service: SavedConnection): string | undefined {
  if (value === undefined) return;
  if (typeof value !== 'string' || value.length > 12000) throw new Error('邀请链接无效。');
  const url = new URL(value);
  if (url.origin !== service.url || url.username || url.password || url.search || url.pathname !== '/' || !url.hash.startsWith('#termdock-invite=')) throw new Error('邀请地址与服务不一致。');
  const descriptor = JSON.parse(Buffer.from(url.hash.slice('#termdock-invite='.length), 'base64url').toString('utf8'));
  if (descriptor.v !== 1 || descriptor.serviceId !== service.targetPeerId || descriptor.entryServiceId !== service.entryServiceId || descriptor.entryUrl !== service.url || (descriptor.routeOnly === true ? descriptor.code !== undefined || !descriptor.entryServiceId || typeof descriptor.routeCode !== 'string' || !/^[A-Za-z0-9_-]{32,128}$/.test(descriptor.routeCode) : typeof descriptor.code !== 'string' || !/^[A-Za-z0-9_-]{32,128}$/.test(descriptor.code))) throw new Error('邀请内容与服务不一致。');
  return url.href;
}
