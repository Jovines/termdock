import { createRoot, type Root } from 'react-dom/client';
import { flushSync } from 'react-dom';
import { afterEach, expect, it } from 'vitest';
import '../../../index.css';
import { getKeyboardPanelStyles } from './keyboardPanelLayout';

let root: Root | undefined;
afterEach(() => {
  root?.unmount(); root = undefined;
  document.body.replaceChildren();
  document.documentElement.style.removeProperty('--kb-translate-y');
  document.documentElement.style.removeProperty('--kb-margin-top');
});

it.each(['mobile', 'desktop', 'ancestor-owned'] as const)('preserves panel geometry: %s', mode => {
  const host = document.createElement('div'); document.body.append(host);
  const layout = getKeyboardPanelStyles(mode !== 'desktop');
  const nested = getKeyboardPanelStyles(false);
  root = createRoot(host);
  flushSync(() => root!.render(
    <div style={{ position: 'fixed', inset: '0 auto auto 0', width: 390, height: 844, display: 'flex', flexDirection: 'column' }}>
      <header style={{ height: 44, flexShrink: 0 }}>导航</header>
      <section style={{ display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0, overflow: 'hidden', ...layout.rootStyle }}>
        <main style={{ flex: 1, minHeight: 0, overflow: 'auto', ...layout.contentStyle }}>
          {mode === 'ancestor-owned' && <div data-child style={{ height: '100%', display: 'flex', flexDirection: 'column', ...nested.rootStyle }}>
            <div data-child-content style={{ flex: 1, minHeight: 0, ...nested.contentStyle }}>子面板</div>
          </div>}
        </main>
        <footer style={{ height: 56, flexShrink: 0 }}>输入栏</footer>
      </section>
    </div>,
  ));
  const header = host.querySelector('header')!, content = host.querySelector('main')!, footer = host.querySelector('footer')!;
  for (const inset of [0, 180, 374, 410, 0, 374, 0]) {
    document.documentElement.style.setProperty('--kb-translate-y', `${-inset}px`);
    document.documentElement.style.setProperty('--kb-margin-top', `${inset}px`);
    const applied = mode === 'desktop' ? 0 : inset;
    expect(header.getBoundingClientRect().top).toBe(0);
    expect(content.getBoundingClientRect().top).toBe(44);
    expect(content.getBoundingClientRect().height).toBe(744 - applied);
    expect(footer.getBoundingClientRect().bottom).toBe(844 - applied);
    expect(content.getBoundingClientRect().bottom).toBe(footer.getBoundingClientRect().top);
    if (mode === 'ancestor-owned') {
      expect(host.querySelector('[data-child-content]')!.getBoundingClientRect().top).toBe(44);
      expect(getComputedStyle(host.querySelector('[data-child]')!).transform).toBe('none');
    }
  }
});
