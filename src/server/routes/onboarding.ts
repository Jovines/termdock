import express from 'express';
import fs from 'fs';
import QRCode from 'qrcode';
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

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function createQrCards(items: Array<{ label: string; address: string; url: string; qr: string | null }>): string {
  return items.map((item) => `
      <div class="qr-card">
        ${item.qr ? `<div class="qr"><img src="${item.qr}" alt="QR code for ${escapeHtml(item.url)}" /></div>` : ''}
        <div>
          <div class="label">${escapeHtml(item.label)} · ${escapeHtml(item.address)}</div>
          <code>${escapeHtml(item.url)}</code>
        </div>
      </div>`).join('');
}

function createPage(caAvailable: boolean, qrItems: Array<{ label: string; address: string; url: string; qr: string | null }>, targetUrl?: string): string {
  const state = localAccessManager.getState();
  const url = escapeHtml(targetUrl ?? state.url);
  const fallbackUrl = escapeHtml(state.fallbackUrl);
  const status = escapeHtml(state.status);
  const reason = state.reason ? escapeHtml(state.reason) : '';
  const caButton = caAvailable
    ? '<a class="button" href="/onboarding/ca.crt">Download CA certificate</a>'
    : '<div class="warn">CA file is not configured. Start Termdock with --https-ca &lt;path&gt; to enable certificate download.</div>';

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Termdock Local Access</title>
  <style>
    body { margin: 0; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; background: #0f1115; color: #f5f5f5; }
    main { max-width: 720px; margin: 0 auto; padding: 32px 20px 48px; }
    .card { border: 1px solid rgba(255,255,255,.12); border-radius: 20px; background: rgba(255,255,255,.05); padding: 20px; }
    h1 { font-size: 28px; margin: 0 0 8px; }
    h2 { font-size: 18px; margin: 24px 0 8px; }
    p, li { color: rgba(255,255,255,.78); line-height: 1.6; }
    code { word-break: break-all; color: #8bd5ff; }
    .button { display: inline-flex; margin: 12px 0; padding: 12px 16px; border-radius: 999px; background: #41d17d; color: #08110b; font-weight: 700; text-decoration: none; }
    .warn { margin: 12px 0; padding: 12px; border-radius: 12px; background: rgba(255, 193, 7, .15); color: #ffd36a; }
    .muted { color: rgba(255,255,255,.55); font-size: 13px; }
    .qr { display: inline-block; margin: 12px 0; padding: 10px; border-radius: 16px; background: #fff; }
    .qr img { display: block; width: 160px; height: 160px; }
    .qr-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 14px; margin: 14px 0; }
    .qr-card { border: 1px solid rgba(255,255,255,.1); border-radius: 16px; padding: 12px; background: rgba(255,255,255,.04); }
    .label { margin: 4px 0 6px; font-weight: 700; color: rgba(255,255,255,.86); }
  </style>
</head>
<body>
  <main>
    <div class="card">
      <h1>Termdock Local Access</h1>
      <p>Scan one of these QR codes to open an IP fallback address on your phone:</p>
      <div class="qr-grid">${createQrCards(qrItems)}</div>
      <p>Install the local CA on your phone first, then open:</p>
      <p><code>${url}</code></p>
      <p class="muted">If mDNS does not resolve on your Wi‑Fi, use this IP fallback after installing the CA: <code>${fallbackUrl}</code></p>
      <p class="muted">Status: ${status}${reason ? ` · ${reason}` : ''}</p>
      ${caButton}
      <p class="muted">Short link: <code>/ca</code> (same certificate download)</p>
      <h2>iPhone / iPad</h2>
      <ol>
        <li>Tap “Download CA certificate”.</li>
        <li>Open Settings and install the downloaded profile.</li>
        <li>Go to Settings → General → About → Certificate Trust Settings, then fully trust the CA.</li>
        <li>Return to <code>${url}</code>.</li>
      </ol>
      <h2>Android</h2>
      <ol>
        <li>Tap “Download CA certificate”.</li>
        <li>Install it as a CA certificate from system security settings.</li>
        <li>Return to <code>${url}</code>.</li>
      </ol>
    </div>
  </main>
</body>
</html>`;
}

export function createOnboardingRouter(options: OnboardingOptions = {}): express.Router {
  const router = express.Router();

  router.get('/', async (_req, res) => {
    const caAvailable = Boolean(options.caCertPath && fs.existsSync(options.caCertPath));
    const state = localAccessManager.getState();
    const targetUrl = state.hostname
      ? `${state.httpsEnabled ? 'https' : 'http'}://${state.hostname}:${options.port ?? 9834}`
      : state.url;
    const qrItems = await Promise.all(state.interfaces.map(async (entry) => {
      const url = `${state.httpsEnabled ? 'https' : 'http'}://${entry.address}:${options.port ?? 9834}`;
      const qr = await QRCode.toDataURL(url, {
        margin: 1,
        width: 160,
        errorCorrectionLevel: 'M',
      }).catch(() => null);
      return { label: `${entry.label} (${entry.name})`, address: entry.address, url, qr };
    }));
    res.type('html').send(createPage(caAvailable, qrItems, targetUrl));
  });

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
