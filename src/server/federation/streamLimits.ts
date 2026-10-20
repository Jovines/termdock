// Long-lived terminal subscriptions have an independent budget from short HTTP
// operations. Normal browser requests queue below the server's defensive ceiling.
export const MAX_ACTIVE_HTTP_REQUESTS = 8;
export const MAX_SERVER_HTTP_REQUESTS = 32;
export const MAX_OPEN_SECURE_SOCKETS = 128;

// Relay selection must finish before foreground/background clients abandon the
// transport, leaving time for the final pinned Noise handshake.
export const RELAY_PROVIDER_CONNECT_TIMEOUT_MS = 10_000;
export const RELAY_ROUTE_OPEN_TIMEOUT_MS = 15_000;
export const RELAY_CLIENT_CONNECT_TIMEOUT_MS = 20_000;
