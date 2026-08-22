import { describe, expect, it } from 'vitest';
import { RenderedTerminalContext } from './renderedTerminalContext.js';

describe('RenderedTerminalContext', () => {
  it('keeps only the rendered result of carriage-return loading updates', async () => {
    const context = new RenderedTerminalContext(80, 10);
    context.write('Fix automatic titles\r\n');
    context.write('Loading 1%');
    context.write('\r\x1b[2KLoading 50%');
    context.write('\r\x1b[2KDone');

    const text = await context.snapshot();

    expect(text).toContain('Fix automatic titles');
    expect(text).not.toContain('Done');
    expect(text).not.toContain('Loading 1%');
    expect(text).not.toContain('Loading 50%');
    context.dispose();
  });

  it('does not let an endless spinner evict earlier static content', async () => {
    const context = new RenderedTerminalContext(80, 10);
    context.write('User wants reliable automatic titles\r\n');
    for (let frame = 0; frame < 2_000; frame += 1) {
      context.write(`\r\x1b[2KLoading ${frame}`);
    }

    const text = await context.snapshot();

    expect(text).toContain('User wants reliable automatic titles');
    expect(text).not.toContain('Loading 1999');
    expect(text).not.toContain('Loading 1998');
    context.dispose();
  });

  it('includes rendered scrollback beyond the visible viewport', async () => {
    const context = new RenderedTerminalContext(40, 3);
    context.write('purpose\r\nfirst result\r\nsecond result\r\nthird result\r\n');

    const text = await context.snapshot();

    expect(text).toContain('purpose');
    expect(text).toContain('third result');
    context.dispose();
  });

  it('drops queued output from before a turn reset', async () => {
    const context = new RenderedTerminalContext(80, 10);
    context.write('old session output');
    context.reset();
    context.write('new user request\r\n');

    const text = await context.snapshot();

    expect(text).toBe('new user request');
    context.dispose();
  });
});
