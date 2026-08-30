// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { I18nProvider } from '../../i18n';
import { buildErrorDiagnostic, ErrorBoundary } from './ErrorBoundary';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('ErrorBoundary diagnostics', () => {
  it('includes the actionable error context in copied text', () => {
    const error = new TypeError('bridge.onServiceActivity is not a function');
    error.stack = 'TypeError: bridge.onServiceActivity is not a function\n    at DesktopServiceSwitcher';
    const diagnostic = buildErrorDiagnostic(error, 'at DesktopServiceSwitcher', {
      url: 'https://localhost:9834/',
      userAgent: 'Termdock Desktop',
      capturedAt: '2026-08-30T08:00:00.000Z',
    });
    expect(diagnostic).toContain('TypeError: bridge.onServiceActivity is not a function');
    expect(diagnostic).toContain('URL: https://localhost:9834/');
    expect(diagnostic).toContain('React component stack:\nat DesktopServiceSwitcher');
  });

  it('offers a copy action when a child crashes', async () => {
    const writeText = vi.fn(async (_text: string) => undefined);
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const preventExpectedError = (event: ErrorEvent) => event.preventDefault();
    window.addEventListener('error', preventExpectedError);
    const Broken = () => {
      throw new Error('render failed');
    };

    render(
      <I18nProvider>
        <ErrorBoundary><Broken /></ErrorBoundary>
      </I18nProvider>,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Copy error details' }));
    await waitFor(() => expect(writeText).toHaveBeenCalledOnce());
    expect(writeText.mock.calls[0]?.[0]).toContain('Error: render failed');
    expect(screen.getByRole('button', { name: 'Copied' })).toBeTruthy();
    window.removeEventListener('error', preventExpectedError);
  });
});
