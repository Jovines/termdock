// Runs before the existing encrypted background bundle. Workers do not inherit
// the page's WebSocket wrapper; route only saved origins and encrypted sockets.
(() => {
  const boot = self.__TD_PREVIEW_TRANSPORT__;
  const OriginalSocket = self.WebSocket;
  self.WebSocket = class extends OriginalSocket {
    constructor(raw, protocols) {
      const url = new URL(raw, self.location.origin);
      const origin = url.protocol === 'wss:' ? `https://${url.host}` : url.protocol === 'ws:' ? `http://${url.host}` : url.origin;
      const index = origin === self.location.origin ? boot.defaultRoute : boot.origins.indexOf(origin);
      if (index < 0 || url.username || url.password || !['/api/federation/secure','/api/federation/relay'].includes(url.pathname)) throw new TypeError('Unapproved background encrypted route');
      const local = self.location.origin.replace('http:', 'ws:');
      super(`${local}/__td_route/${index}${url.pathname}${url.search}`, protocols);
    }
  };
  delete self.__TD_PREVIEW_TRANSPORT__;
})();
