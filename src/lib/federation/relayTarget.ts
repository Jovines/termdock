export function relayTargetName(target: { serviceId: string; label?: string; url?: string }): string {
  if (target.label) return target.label;
  if (target.url) try { return new URL(target.url).host; } catch { /* Keep malformed metadata out of rendering. */ }
  // Ed25519 IDs all start with 12D3KooW; their suffix distinguishes machines.
  return `中转服务 ${target.serviceId.slice(-8)}`;
}

export function relayTargetFailure(target: { error?: string }): string {
  if (target.error === 'TARGET_IDENTITY_MISMATCH') return '服务身份与登记地址不一致，请修正登记';
  if (target.error === 'TARGET_CHECKING') return '正在验证目标服务身份';
  if (target.error === 'TARGET_UNREACHABLE') return '目标连接失败，请检查地址、网络与证书';
  return '中转暂不可用';
}
