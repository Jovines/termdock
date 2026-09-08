/* Public inert shell. The parent supplies only the selected preview resource pack. */
(() => {
  const capability = location.hash.slice(1);
  if (!/^[a-f0-9-]{36}$/.test(capability)) return;
  const announce = () => parent.postMessage({ type: 'preview-ready', capability }, '*');
  const timer = setInterval(announce, 250);
  const receive = event => {
    if (event.source !== parent || event.data?.type !== 'preview-init' || event.data.capability !== capability) return;
    clearInterval(timer); removeEventListener('message', receive);
    const replacements = [];
    const rewrite = text => { for (const [token, url] of replacements) text = text.split(token).join(url); return text; };
    for (const resource of event.data.resources) {
      const data = typeof resource.data === 'string' ? rewrite(resource.data) : resource.data;
      replacements.push([resource.token, URL.createObjectURL(new Blob([data], { type: resource.type }))]);
    }
    const html = rewrite(event.data.html);
    document.open(); document.write(html); document.close();
  };
  addEventListener('message', receive); announce();
})();
