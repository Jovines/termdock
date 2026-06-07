import express from 'express';
import { createServer, type Server } from 'http';
import fs from 'fs';
import type { AddressInfo } from 'net';
import { createOnboardingRouter } from './routes/onboarding.js';
import { getLanIPv4Addresses } from './utils/localAccess.js';

export interface OnboardingServerOptions {
  httpsPort: number;
  caCertPath?: string;
}

export interface OnboardingServerState {
  server: Server | null;
  url: string | null;
}

let activeServer: Server | null = null;
let activeUrl: string | null = null;

function canStart(options: OnboardingServerOptions): boolean {
  return Boolean(options.caCertPath && fs.existsSync(options.caCertPath));
}

export function startOnboardingServer(options: OnboardingServerOptions): OnboardingServerState {
  stopOnboardingServer();
  if (!canStart(options)) {
    return { server: null, url: null };
  }

  const app = express();
  app.use('/onboarding', createOnboardingRouter({ port: options.httpsPort, caCertPath: options.caCertPath }));
  app.get('/ca', (_req, res) => {
    if (!options.caCertPath || !fs.existsSync(options.caCertPath)) {
      res.status(404).json({ error: 'CA certificate is not configured', code: 'CA_NOT_CONFIGURED' });
      return;
    }
    res.setHeader('Content-Type', 'application/x-x509-ca-cert');
    res.setHeader('Content-Disposition', 'attachment; filename="rootCA.pem"');
    res.send(fs.readFileSync(options.caCertPath));
  });
  app.get('/', (_req, res) => res.redirect('/onboarding'));

  const server = createServer(app);
  server.on('error', (error) => {
    console.warn('[onboarding] HTTP setup server failed:', error);
  });
  server.once('listening', () => {
    const address = server.address() as AddressInfo | null;
    const port = address?.port ?? null;
    const host = getLanIPv4Addresses()[0] ?? 'localhost';
    activeUrl = port ? `http://${host}:${port}/onboarding` : null;
  });
  server.listen(0, '0.0.0.0');

  activeServer = server;
  return { server, get url() { return activeUrl; } };
}

export function stopOnboardingServer(): void {
  if (activeServer) {
    try { activeServer.close(); } catch { /* ignore */ }
  }
  activeServer = null;
  activeUrl = null;
}

export function getOnboardingServerUrl(): string | null {
  return activeUrl;
}
