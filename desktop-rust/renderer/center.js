'use strict';
const api = (op, args = {}) => window.__TAURI_INTERNALS__.invoke('preview_dispatch', { op, args });
const status = document.querySelector('#status');
let busy = false;
async function run(action) {
  if (busy) return;
  busy = true; document.querySelectorAll('button').forEach(button => { button.disabled = true; });
  status.textContent = '正在处理…'; status.dataset.error = 'false';
  try { await action(); await refresh(); status.textContent = '已完成'; }
  catch (error) { status.textContent = String(error); status.dataset.error = 'true'; }
  finally { busy = false; document.querySelectorAll('button').forEach(button => { button.disabled = false; }); }
}
async function refresh() {
  const snapshot = await api('snapshot');
  const list = document.querySelector('#connections'); list.replaceChildren();
  if (!snapshot.connections.length) { const p = document.createElement('p'); p.textContent = '添加服务地址，或连接本机已启动的 Termdock。'; list.append(p); }
  for (const connection of snapshot.connections) {
    const row = document.createElement('div'); row.className = 'service';
    const info = document.createElement('div'); const name = document.createElement('strong'); name.textContent = connection.label;
    const address = document.createElement('p'); address.textContent = connection.serviceOrigin || connection.url;
    const route = document.createElement('p'); route.textContent = connection.entryServiceId ? `经入口 ${connection.url} 连接目标 ${connection.targetPeerId}` : connection.targetPeerId || '打开时确认服务身份';
    info.append(name, address, route);
    const actions = document.createElement('div'); actions.className = 'actions';
    for (const [label, action] of [['连接', () => api('openConnection', { connection })], ['编辑', async () => {
      const form = document.querySelector('#connection-form'); for (const key of ['label','url','targetPeerId','serviceOrigin','entryServiceId']) form.elements[key].value = connection[key] || ''; form.dataset.id = connection.id; form.scrollIntoView({ behavior: 'smooth' });
    }], ['移除', () => api('removeConnection', { id: connection.id })]]) {
      const button = document.createElement('button'); button.textContent = label; button.addEventListener('click', () => run(action)); actions.append(button);
    }
    row.append(info, actions); list.append(row);
  }
  const pins = document.querySelector('#pins'); pins.replaceChildren();
  for (const [origin, fingerprint] of Object.entries(snapshot.certificatePins || {})) { const p = document.createElement('p'); p.textContent = `${origin} · ${fingerprint}`; pins.append(p); }
}
document.querySelector('#connection-form').addEventListener('submit', event => {
  event.preventDefault(); const form = event.target; const values = Object.fromEntries(new FormData(form));
  run(async () => {
    let connection = { id: form.dataset.id || crypto.randomUUID(), url: values.url, label: values.label, routes: [] };
    for (const field of ['targetPeerId','serviceOrigin','entryServiceId']) if (values[field]) connection[field] = values[field];
    if (values.invitation) {
      const invite = new URL(values.invitation); const prefix = 'termdock-invite=';
      if (!invite.hash.slice(1).startsWith(prefix)) throw new Error('邀请链接格式不正确');
      const raw = invite.hash.slice(1 + prefix.length).replaceAll('-', '+').replaceAll('_', '/');
      const descriptor = JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(raw), c => c.charCodeAt(0))));
      if (descriptor.v !== 1) throw new Error('不支持该邀请版本');
      connection = { ...connection, url: invite.origin, targetPeerId: descriptor.serviceId, serviceOrigin: descriptor.serviceUrl || invite.origin, ...(descriptor.entryServiceId ? { entryServiceId: descriptor.entryServiceId } : {}) };
    }
    await api('openConnection', { connection, invitation: values.invitation || undefined }); form.reset(); delete form.dataset.id;
  });
});
document.querySelector('#local').addEventListener('click', () => run(() => api('openLocal')));
document.querySelector('#config').addEventListener('click', () => run(() => api('revealConfig')));
document.querySelector('#certificate-form').addEventListener('submit', event => { event.preventDefault(); run(() => api('trustCertificate', Object.fromEntries(new FormData(event.target)))); });
document.querySelector('#revoke').addEventListener('click', () => run(() => api('revokeCertificate', { origin: document.querySelector('#certificate-form').elements.origin.value })));
window.addEventListener('termdock:preview-connections', () => { void refresh().catch(error => { status.textContent = String(error); }); });
void refresh().catch(error => { status.textContent = String(error); status.dataset.error = 'true'; });
