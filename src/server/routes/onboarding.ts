import express from 'express';
import fs from 'fs';
import { localAccessManager } from '../utils/localAccess.js';

export interface OnboardingOptions {
  port?: number;
  caCertPath?: string;
}

function sendCaCertificate(res: express.Response, caCertPath: string): void {
  res.setHeader('Content-Type', 'application/x-x509-ca-cert');
  res.setHeader('Content-Disposition', 'attachment; filename="rootCA.pem"');
  res.send(fs.readFileSync(caCertPath));
}

export function createOnboardingRouter(options: OnboardingOptions = {}): express.Router {
  const router = express.Router();

  router.get('/status', (_req, res) => {
    const state = localAccessManager.getState();
    res.json({
      ...state,
      caDownloadUrl: options.caCertPath && fs.existsSync(options.caCertPath) ? '/onboarding/ca.crt' : null,
      targetUrl: state.hostname ? `${state.httpsEnabled ? 'https' : 'http'}://${state.hostname}:${options.port ?? 9834}` : state.url,
      fallbackUrl: state.fallbackUrl,
    });
  });

  router.get('/ca.crt', (_req, res) => {
    if (!options.caCertPath || !fs.existsSync(options.caCertPath)) {
      res.status(404).json({ error: 'CA certificate is not configured', code: 'CA_NOT_CONFIGURED' });
      return;
    }
    sendCaCertificate(res, options.caCertPath);
  });

  router.get('/ca', (_req, res) => {
    if (!options.caCertPath || !fs.existsSync(options.caCertPath)) {
      res.status(404).json({ error: 'CA certificate is not configured', code: 'CA_NOT_CONFIGURED' });
      return;
    }
    sendCaCertificate(res, options.caCertPath);
  });

  return router;
}
