// Long-lived terminal subscriptions have an independent budget from short HTTP
// operations. Normal browser requests queue below the server's defensive ceiling.
export const MAX_ACTIVE_HTTP_REQUESTS = 8;
export const MAX_SERVER_HTTP_REQUESTS = 32;
export const MAX_OPEN_SECURE_SOCKETS = 128;
