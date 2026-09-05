// @vitest-environment node
import express from 'express';
import { once } from 'node:events';
import { expect, it } from 'vitest';
import { apiCachePolicy } from './apiCachePolicy.js';

it('preserves preview validators through the API boundary and still runs authentication', async () => {
  const app = express();
  app.use('/api', apiCachePolicy);
  app.use((req, res, next) => { if (req.headers.authorization !== 'fixture') { res.status(401).end(); return; } next(); });
  app.get('/api/*path', (req, res) => {
    if (req.headers['if-none-match'] === '"current"') { res.status(304).end(); return; }
    res.json({ body: true });
  });
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing address');
  const base = `http://127.0.0.1:${address.port}/api`;
  try {
    for (const route of ['/terminal/fs/read', '/terminal/fs/blob', '/terminal/fs/eda-preview']) {
      const response = await fetch(base + route, { headers: { Authorization: 'fixture', 'If-None-Match': '"current"' } });
      expect(response.status).toBe(304);
      expect((await fetch(base + route, { headers: { 'If-None-Match': '"current"' } })).status).toBe(401);
    }
    const ordinary = await fetch(base + '/terminal/session-inventory', { headers: { Authorization: 'fixture', 'If-None-Match': '"current"' } });
    expect(ordinary.status).toBe(200);
    expect(ordinary.headers.get('cache-control')).toBe('no-store');
  } finally { server.close(); }
});
