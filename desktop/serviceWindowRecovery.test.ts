import { describe, expect, it, vi } from 'vitest';
import { serviceDocumentNeedsReload } from './serviceWindowRecovery.js';

describe('serviceDocumentNeedsReload', () => {
  it('keeps a complete workspace document', async () => {
    await expect(serviceDocumentNeedsReload({
      getURL: () => 'https://localhost:9834/',
      executeJavaScript: vi.fn().mockResolvedValue({
        origin: 'https://localhost:9834',
        readyState: 'complete',
        rootChildren: 1,
      }),
    }, 'https://localhost:9834')).resolves.toBe(false);
  });

  it('reloads an error page or empty renderer', async () => {
    await expect(serviceDocumentNeedsReload({
      getURL: () => 'chrome-error://chromewebdata/',
      executeJavaScript: vi.fn(),
    }, 'https://localhost:9834')).resolves.toBe(true);

    await expect(serviceDocumentNeedsReload({
      getURL: () => 'https://localhost:9834/',
      executeJavaScript: vi.fn().mockResolvedValue({
        origin: 'https://localhost:9834',
        readyState: 'complete',
        rootChildren: 0,
      }),
    }, 'https://localhost:9834')).resolves.toBe(true);
  });

  it('treats an unresponsive renderer as recoverable', async () => {
    await expect(serviceDocumentNeedsReload({
      getURL: () => 'https://localhost:9834/',
      executeJavaScript: vi.fn(() => new Promise(() => undefined)),
    }, 'https://localhost:9834', 5)).resolves.toBe(true);
  });
});
