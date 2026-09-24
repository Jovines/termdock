/** Timings belong to the actual socket, never the currently selected service. */
export interface ConnectionDiagnostics {
  endpoint: string;
  path: 'direct' | 'relay';
  targetPeerId: string;
  transportOpenMs: number;
  handshakeMs: number;
  establishedAt: number;
  relay?: { entryOpenMs: number | null; routeOpenMs: number | null };
  socketOpenMs?: number;
  socketQueueMs?: number;
  bufferedBytes: number;
  pendingWrites: boolean;
  activeRequests: number;
  waitingRequests: number;
}
export interface DiagnosticSocket {
  getConnectionDiagnostics?: () => ConnectionDiagnostics | undefined;
}
