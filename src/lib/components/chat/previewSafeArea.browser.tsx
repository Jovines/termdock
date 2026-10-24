import { useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { page } from 'vitest/browser';
import '../../../index.css';
import { I18nProvider } from '../../i18n';
import { MarkdownImageLightbox } from '../markdown/MarkdownPreview';
import { Markdown } from '../markdown/Markdown';
import { ChatFilePreview } from './ChatFilePreview';

let root: Root | undefined;
afterEach(() => {
  root?.unmount(); root = undefined;
  vi.unstubAllGlobals(); document.body.replaceChildren(); document.documentElement.removeAttribute('style');
});
const frame = () => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
function mount(content: React.ReactNode) {
  const host = document.createElement('div'); host.id = 'root'; document.body.append(host);
  root = createRoot(host); root.render(<I18nProvider>{content}</I18nProvider>);
}
const layouts = [
  { name: 'portrait', width: 390, height: 844, top: 59, right: 0, bottom: 34, left: 0 },
  { name: 'landscape', width: 844, height: 390, top: 0, right: 59, bottom: 21, left: 59 },
  { name: 'short landscape', width: 568, height: 320, top: 38, right: 44, bottom: 34, left: 44 },
  { name: 'desktop title bar', width: 1280, height: 900, top: 38, right: 0, bottom: 0, left: 0 },
];
function insideSafeArea(element: Element, layout: typeof layouts[number]) {
  const box = element.getBoundingClientRect();
  expect(box.width).toBeGreaterThan(0); expect(box.height).toBeGreaterThan(0);
  expect(box.top).toBeGreaterThanOrEqual(layout.top - 1);
  expect(box.left).toBeGreaterThanOrEqual(layout.left - 1);
  expect(box.right).toBeLessThanOrEqual(layout.width - layout.right + 1);
  expect(box.bottom).toBeLessThanOrEqual(layout.height - layout.bottom + 1);
}
async function applyLayout(layout: typeof layouts[number]) {
  await page.viewport(layout.width, layout.height);
  for (const edge of ['top', 'right', 'bottom', 'left'] as const) document.documentElement.style.setProperty(`--safe-${edge}-inset`, `${layout[edge]}px`);
  vi.stubGlobal('fetch', vi.fn(() => new Promise(() => {})));
}
for (const layout of layouts) {
  it(`keeps the entire file dialog and close control inside the ${layout.name} safe area`, async () => {
    await applyLayout(layout);
    mount(<ChatFilePreview path="/tmp/config.md" sessionId="safe-area" canWrite close={() => {}} />);
    await expect.element(page.getByRole('dialog', { name: '文件预览' })).toBeVisible(); await frame();
    insideSafeArea(document.querySelector('[role="dialog"]')!, layout);
    insideSafeArea(document.querySelector('[aria-label="关闭文件预览"]')!, layout);
  });
  it(`keeps Markdown image controls and stage inside the ${layout.name} safe area`, async () => {
    await applyLayout(layout);
    mount(<MarkdownImageLightbox images={[{ kind: 'image', src: '/test.png', alt: 'Test' }]} index={0} onChange={() => {}} onClose={() => {}} />);
    await expect.poll(() => document.querySelector('[data-markdown-image-lightbox-stage]')).toBeTruthy(); await frame();
    insideSafeArea(document.querySelector('[data-markdown-image-lightbox-stage]')!, layout);
    insideSafeArea(document.querySelector('[data-markdown-image-lightbox] button:last-child')!, layout);
  });
}
function Outline() {
  const [open, setOpen] = useState(false);
  return <Markdown variant="document" content={Array.from({ length: 40 }, (_, i) => `## Chapter ${i}\n\nBody`).join('\n\n')} fileControls={{ lineRange: null, onLineRangeClick: () => {}, scrollTop: 0, outlineOpen: open, onOutlineOpen: () => setOpen(true), onOutlineClose: () => setOpen(false) }} />;
}
it('keeps the Markdown mobile outline controls and scrolling list inside all four insets', async () => {
  const layout = layouts[2]!; await applyLayout(layout); mount(<Outline />);
  await page.getByRole('button', { name: /Markdown outline|Markdown 目录/ }).click(); await frame();
  const sheet = document.querySelector('[data-markdown-heading-outline-mobile]')!;
  insideSafeArea(sheet.querySelector('button')!, layout);
  const list = sheet.lastElementChild!;
  insideSafeArea(list, layout);
  expect(list.scrollHeight).toBeGreaterThan(list.clientHeight);
});
