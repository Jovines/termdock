export function relayTargetName(target: { serviceId: string; label?: string; url?: string }): string {
  if (target.label) return target.label;
  if (target.url) try { return new URL(target.url).host; } catch { /* Keep malformed metadata out of rendering. */ }
  // Ed25519 IDs all start with 12D3KooW; their suffix distinguishes machines.
  return `中转服务 ${target.serviceId.slice(-8)}`;
}

export function relayTargetFailure(target: { error?: string }): string {
  if (target.error === 'TARGET_PASSWORD_REQUIRED') return '目标服务未配置有效访问密码，已禁用中转。请让目标管理员先配置访问密码';
  if (target.error === 'TARGET_SECURITY_UPGRADE_REQUIRED') return '无法核验密码保护，已禁用中转。请更新目标服务和中继程序';
  if (target.error === 'TARGET_IDENTITY_MISMATCH') return '服务身份与登记地址不一致，请修正登记';
  if (target.error === 'TARGET_CHECKING') return '正在验证目标服务身份';
  if (target.error === 'TARGET_UNREACHABLE') return '目标连接失败，请检查地址、网络与证书';
  return '中转暂不可用';
}
