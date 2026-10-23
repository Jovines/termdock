// @vitest-environment jsdom
import { useState } from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Markdown } from './Markdown';
import { MarkdownPreview } from './MarkdownPreview';
import { ChatMarkdown } from '../chat/ChatMarkdown';
import CollaborationTaskContent from '../sidebar/CollaborationTaskContent';
import { ArchitectureDocumentFields } from '../sidebar/ArchitectureDocumentFields';

const mermaid = vi.hoisted(() => ({
  initialize: vi.fn(),
  render: vi.fn(async (_id: string, _code: string) => ({ svg: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 96 48"><text>Shared diagram</text></svg>' })),
}));
vi.mock('mermaid', () => ({ default: mermaid }));

function FileContent({ content }: { content: string }) {
  const [open, setOpen] = useState(false);
  return <MarkdownPreview content={content} filePath="/repo/docs/test.md" rootPath="/repo"
    lineRange={null} onLineRangeClick={() => {}} scrollTop={0} outlineOpen={false}
    lightboxOpen={open} onLightboxOpen={() => setOpen(true)} onLightboxClose={() => setOpen(false)} />;
}
function ArchitectureContent({ content }: { content: string }) {
  return <ArchitectureDocumentFields value={{ description: content }} rootPath="/repo" />;
}

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn(async () => new Response('{}')));
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
  mermaid.render.mockClear();
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

// Exercise the actual product adapters, not mocks of the common renderer.
describe.each([
  ['file preview', FileContent],
  ['chat', ChatMarkdown],
  ['task delivery', CollaborationTaskContent],
  ['architecture', ArchitectureContent],
] as const)('shared Markdown behavior in %s', (_name, Surface) => {
  it('reflows source-wrapped list text as one paragraph, including nested and quoted lists', async () => {
    const content = '- First line\n  continuation with **strong** text\n  final line\n  - Nested\n    nested continuation\n\n> - Quoted\n>   quoted continuation';
    const view = render(<Surface content={content} />);
    await screen.findByText('strong');
    const items = Array.from(view.container.querySelectorAll('li'));
    expect(items).toHaveLength(3);
    expect(items[0].textContent).toContain('First line continuation with strong text final line');
    expect(items[1].textContent).toBe('Nested nested continuation');
    expect(items[2].textContent).toBe('Quoted quoted continuation');
    expect(view.container.querySelector('li p, li br')).toBeNull();
    expect(items[0].getAttribute('data-md-ref-start')).toBe('1');
    expect(items[0].getAttribute('data-md-ref-end')).toBe('5');
  });

  it('preserves explicit list line breaks and blank-line paragraphs', async () => {
    const content = '- [x] First  \n  Second\\\n  Third\n\n  New paragraph\n  still the same paragraph\n- Next\n\nOutside the list';
    const view = render(<Surface content={content} />);
    await screen.findByRole('checkbox');
    const items = Array.from(view.container.querySelectorAll('li'));
    expect(items).toHaveLength(2);
    expect(screen.getByRole<HTMLInputElement>('checkbox').checked).toBe(true);
    expect(items[0].querySelectorAll('br')).toHaveLength(2);
    expect(items[0].querySelectorAll('p')).toHaveLength(1);
    expect(items[0].querySelector('p')?.textContent).toBe('New paragraph still the same paragraph');
    expect(items[0].getAttribute('data-md-ref-end')).toBe('6');
    expect(screen.getByText('Outside the list').closest('li')).toBeNull();
  });

  it('supports the same syntax, safe HTML, formulas and diagrams', async () => {
    const content = '## Shared support\n\n**Strong** and $x^2$\n\n- Item\n\n| Name |\n| --- |\n| Value |\n\n```mermaid\ngraph TD\nA-->B\n```\n\n<script>window.injected = true</script>\n\n[Unsafe](javascript:alert(1))\n\n<div><b>Safe HTML</b><img src="x" onerror="alert(1)"></div>';
    const view = render(<Surface content={content} />);
    await screen.findByRole('heading', { name: 'Shared support' });
    expect(screen.getByRole('table').textContent).toContain('Value');
    expect(view.container.querySelector('strong')?.textContent).toBe('Strong');
    expect(view.container.querySelector('li')?.textContent).toBe('Item');
    await waitFor(() => expect(view.container.querySelector('.katex')).toBeTruthy());
    await screen.findByRole('img', { name: 'Mermaid diagram' });
    await screen.findByText('Safe HTML');
    expect(view.container.querySelector('script, [onerror], a[href^="javascript:"]')).toBeNull();
    const diagram = screen.getByRole('img', { name: 'Mermaid diagram' });
    fireEvent.click(diagram.closest('button')!);
    expect(await screen.findByRole('button', { name: 'Close image preview' })).toBeTruthy();
  });

  it('shows the source on parse failure and recovers when content changes', async () => {
    const content = 'x'.repeat(16_385);
    const view = render(<Surface content={content} />);
    await screen.findByRole('alert');
    expect(view.container.querySelector('[data-markdown-preview-fallback] pre')?.textContent).toBe(content);
    view.rerender(<Surface content="## Recovered" />);
    expect(await screen.findByRole('heading', { name: 'Recovered' })).toBeTruthy();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('opens, navigates and closes the image gallery and resets it for new content', async () => {
    const content = '![First](https://example.com/one.png)\n\n![Second](https://example.com/two.png)';
    const view = render(<Surface content={content} />);
    fireEvent.click(await screen.findByTitle('First'));
    expect(await screen.findByRole('button', { name: 'Close image preview' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Next image' }));
    expect(screen.getByText('2 / 2')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Close image preview' }));
    expect(screen.queryByRole('button', { name: 'Close image preview' })).toBeNull();
    fireEvent.click(screen.getByTitle('Second'));
    expect(screen.getByRole('button', { name: 'Close image preview' })).toBeTruthy();
    view.rerender(<Surface content="## Another document" />);
    expect(await screen.findByRole('heading', { name: 'Another document' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Close image preview' })).toBeNull();
  });
});

it('resolves file links against the supplied document context without source controls', () => {
  const open = vi.fn();
  const view = render(<Markdown content="[Sibling](../other.md#section)" filePath="/repo/docs/test.md" rootPath="/repo" onLocalLinkOpen={open} />);
  fireEvent.click(screen.getByRole('link', { name: 'Sibling' }));
  expect(open).toHaveBeenCalledWith({ path: '/repo/other.md', fragment: 'section', directory: false });
  expect(view.container.querySelector('[data-md-rail-segment], [data-markdown-heading-sticky], [role="button"]')).toBeNull();
});

it('gives simultaneous diagrams distinct render IDs across product surfaces', async () => {
  const content = '```mermaid\ngraph TD\nA-->B\n```';
  render(<><ChatMarkdown content={content} /><CollaborationTaskContent content={content} /></>);
  await waitFor(() => expect(screen.getAllByRole('img', { name: 'Mermaid diagram' })).toHaveLength(2));
  const ids = mermaid.render.mock.calls.map(([id]) => id);
  expect(new Set(ids).size).toBe(2);
});
