// @vitest-environment jsdom
import type { ReactNode } from 'react';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { __testParseMarkdownListBlock, MarkdownImageLightbox, buildMarkdownPreviewBlocks, buildMarkdownPreviewRenderResult, getMarkdownHeadingOutline, getMarkdownHeadingPathAtLine, shouldCloseMarkdownImageLightboxDrag } from './RightSidebar';

const mermaidRender = vi.fn(async () => ({ svg: '<svg xmlns="http://www.w3.org/2000/svg"><text>Graph</text></svg>' }));
const katexRenderToString = vi.fn((tex: string) => `<span class="katex">${tex}</span>`);
const domPurifySanitize = vi.fn((html: string) => (
  html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/\s+on\w+="[^"]*"/gi, '')
    .replace(/\s+href="javascript:[^"]*"/gi, '')
));

vi.mock('mermaid', () => ({
  default: {
    initialize: vi.fn(),
    render: mermaidRender,
  },
}));

vi.mock('katex', () => ({
  default: {
    renderToString: katexRenderToString,
  },
}));

vi.mock('katex/dist/katex.min.css', () => ({}));

vi.mock('dompurify', () => ({
  default: {
    sanitize: domPurifySanitize,
  },
}));

vi.mock('swiper/react', () => ({
  Swiper: ({ children, onSwiper, onSlideChange }: {
    children: ReactNode;
    onSwiper?: (instance: { activeIndex: number; allowTouchMove: boolean; slideTo: (index: number) => void }) => void;
    onSlideChange?: (instance: { activeIndex: number }) => void;
  }) => {
    const instance = {
      activeIndex: 0,
      allowTouchMove: true,
      slideTo(index: number) {
        instance.activeIndex = index;
        onSlideChange?.(instance);
      },
    };
    onSwiper?.(instance);
    return <div data-testid="swiper">{children}</div>;
  },
  SwiperSlide: ({ children }: { children: ReactNode }) => <div data-testid="swiper-slide">{children}</div>,
}));

vi.mock('swiper/css', () => ({}));

function renderPreview(markdown: string) {
  const blocks = buildMarkdownPreviewBlocks(
    markdown.split('\n'),
    '/repo/docs/guide.md',
    '/repo',
  );
  return render(<>{blocks.map((block) => <div key={block.key}>{block.content}</div>)}</>);
}

describe('right sidebar Markdown preview rendering', () => {
  afterEach(() => {
    cleanup();
  });

  it('renders images, strikethrough, and autolinks in inline content', () => {
    const { container } = renderPreview([
      'Preview ![Icon](../assets/icon.png "App icon") and ![Vector](./diagram.svg) with ~~old~~ text and https://example.com/docs.',
      '',
      'Also <https://example.com/raw>, www.example.com, <team@example.com>, and owner@example.com.',
    ].join('\n'));

    const image = screen.getByRole('img', { name: 'Icon' });
    expect(image.getAttribute('src')).toBe('/api/terminal/fs/blob?path=%2Frepo%2Fassets%2Ficon.png');
    expect(image.getAttribute('title')).toBe('App icon');
    expect(screen.getByRole('img', { name: 'Vector' }).getAttribute('src')).toBe('/api/terminal/fs/blob?path=%2Frepo%2Fdocs%2Fdiagram.svg');
    expect(container.querySelector('del')?.textContent).toBe('old');
    expect(screen.getByRole('link', { name: 'https://example.com/docs' }).getAttribute('href')).toBe('https://example.com/docs');
    expect(screen.getByRole('link', { name: 'https://example.com/raw' }).getAttribute('href')).toBe('https://example.com/raw');
    expect(screen.getByRole('link', { name: 'www.example.com' }).getAttribute('href')).toBe('https://www.example.com');
    expect(screen.getByRole('link', { name: 'team@example.com' }).getAttribute('href')).toBe('mailto:team@example.com');
    expect(screen.getByRole('link', { name: 'owner@example.com' }).getAttribute('href')).toBe('mailto:owner@example.com');
    expect(container.textContent).toContain('owner@example.com.');
  });

  it('renders backslash-escaped Markdown punctuation literally', () => {
    const { container } = renderPreview(String.raw`Escaped \*not italic\* and \[not link\](https://example.com) plus \!\[not image\](./x.png)`);

    expect(container.textContent).toContain('*not italic*');
    expect(container.textContent).toContain('[not link](https://example.com)');
    expect(container.textContent).toContain('![not image](./x.png)');
    expect(container.querySelector('em')).toBeNull();
    expect(screen.queryByRole('link', { name: 'not link' })).toBeNull();
    expect(screen.queryByRole('img', { name: 'not image' })).toBeNull();
  });

  it('renders and normalizes code spans with matching multi-backtick fences', () => {
    const { container } = renderPreview('Use ``code ` inside`` and ` plain ` spans.');

    const codes = Array.from(container.querySelectorAll('code')).map((node) => node.textContent);
    expect(codes).toEqual(['code ` inside', 'plain']);
  });

  it('hides YAML front matter and HTML comments from preview output', () => {
    const { container } = renderPreview([
      '---',
      'title: Hidden title',
      'tags:',
      '  - hidden',
      '---',
      '<!-- internal note',
      'still hidden -->',
      '# Visible title',
      'Visible body',
    ].join('\n'));

    expect(container.textContent).not.toContain('Hidden title');
    expect(container.textContent).not.toContain('internal note');
    expect(container.textContent).not.toContain('still hidden');
    expect(screen.getByRole('heading', { name: 'Visible title' })).toBeTruthy();
    expect(screen.getByText('Visible body')).toBeTruthy();
  });

  it('hides TOML front matter from preview output', () => {
    const { container } = renderPreview([
      '+++',
      'title = "Hidden TOML"',
      'draft = true',
      '+++',
      '# Public title',
    ].join('\n'));

    expect(container.textContent).not.toContain('Hidden TOML');
    expect(container.textContent).not.toContain('draft');
    expect(screen.getByRole('heading', { name: 'Public title' })).toBeTruthy();
  });

  it('renders CommonMark horizontal rule variants', () => {
    const blocks = buildMarkdownPreviewBlocks([
      '* * *',
      '',
      '___',
      '',
      '- - -',
    ], '/repo/docs/guide.md', '/repo');

    expect(blocks).toHaveLength(3);
    render(<>{blocks.map((block) => <div key={block.key}>{block.content}</div>)}</>);
    expect(document.querySelectorAll('hr')).toHaveLength(3);
  });

  it('renders tilde fences and setext headings as blocks with line ranges', () => {
    const blocks = buildMarkdownPreviewBlocks([
      'Heading',
      '=======',
      '',
      '~~~ts',
      'const ok = true;',
      '~~~',
    ], '/repo/docs/guide.md', '/repo');

    expect(blocks).toHaveLength(2);
    expect(blocks[0]).toMatchObject({ startLine: 1, endLine: 2 });
    expect(blocks[1]).toMatchObject({ startLine: 4, endLine: 6 });

    render(<>{blocks.map((block) => <div key={block.key}>{block.content}</div>)}</>);
    expect(screen.getByRole('heading', { level: 1, name: 'Heading' })).toBeTruthy();
    expect(screen.getByText('ts')).toBeTruthy();
    expect(screen.getByText('const ok = true;')).toBeTruthy();
    expect(screen.getByText('const ok = true;').closest('pre')?.className).toContain('termdock-code');
  });

  it('adds stable unique ids to headings for anchor links', () => {
    const { container } = renderPreview([
      '[Jump](#hello-world)',
      '',
      '# Hello **World**!',
      'Hello World',
      '-----------',
      '> ## Hello World',
    ].join('\n'));

    expect(screen.getByRole('link', { name: 'Jump' }).getAttribute('href')).toBe('#hello-world');
    expect(container.querySelector('#hello-world')?.textContent).toBe('Hello World!');
    expect(container.querySelector('#hello-world-1')?.textContent).toBe('Hello World');
    expect(container.querySelector('#hello-world-2')?.textContent).toBe('Hello World');
  });

  it('tracks the active heading hierarchy for sticky Markdown preview context', () => {
    const blocks = buildMarkdownPreviewBlocks([
      '# Product',
      'intro',
      '## Install',
      'steps',
      '### Mobile',
      'details',
      '## Usage',
      'text',
    ], '/repo/docs/guide.md', '/repo');

    expect(getMarkdownHeadingPathAtLine(blocks, 6).map((heading) => `${heading.level}:${heading.text}`)).toEqual([
      '1:Product',
      '2:Install',
      '3:Mobile',
    ]);
    expect(getMarkdownHeadingPathAtLine(blocks, 8).map((heading) => `${heading.level}:${heading.text}`)).toEqual([
      '1:Product',
      '2:Usage',
    ]);
  });

  it('builds a full Markdown heading outline for the sticky outline menu', () => {
    const blocks = buildMarkdownPreviewBlocks([
      '# Product',
      'intro',
      '## Install',
      'steps',
      '### Mobile',
      'details',
      '## Usage',
      'text',
    ], '/repo/docs/guide.md', '/repo');

    expect(getMarkdownHeadingOutline(blocks).map((heading) => `${heading.level}:${heading.text}:${heading.startLine}`)).toEqual([
      '1:Product:1',
      '2:Install:3',
      '3:Mobile:5',
      '2:Usage:7',
    ]);
  });

  it('strips optional closing hashes from ATX headings', () => {
    const { container } = renderPreview([
      '## Section Title ##',
      '> ### Nested Title ###',
    ].join('\n'));

    expect(screen.getByRole('heading', { name: 'Section Title' })).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Nested Title' })).toBeTruthy();
    expect(container.textContent).not.toContain('##');
    expect(container.querySelector('#section-title')).toBeTruthy();
    expect(container.querySelector('#nested-title')).toBeTruthy();
  });

  it('falls back to plain text for unknown fenced-code languages', () => {
    renderPreview([
      '```not-a-real-language',
      'plain <unsafe> text',
      '```',
    ].join('\n'));

    expect(screen.getByText('not-a-real-language')).toBeTruthy();
    expect(screen.getByText('plain <unsafe> text')).toBeTruthy();
  });

  it('renders indented code blocks at top level and inside blockquotes', () => {
    renderPreview([
      '    const top = true;',
      '',
      '>     const quoted = true;',
    ].join('\n'));

    expect(screen.getByText('const top = true;').closest('pre')?.className).toContain('termdock-code');
    expect(screen.getByText('const quoted = true;').closest('pre')?.className).toContain('termdock-code');
  });

  it('renders Mermaid fences as image-backed diagrams', async () => {
    renderPreview([
      '```mermaid',
      'graph TD',
      '  A-->B',
      '```',
    ].join('\n'));

    expect(screen.getByText('Rendering diagram...')).toBeTruthy();
    await waitFor(() => expect(screen.getByRole('img', { name: 'Mermaid diagram' })).toBeTruthy());
    expect(mermaidRender).toHaveBeenCalledWith(expect.stringContaining('termdock-md-mermaid-code-0'), 'graph TD\n  A-->B');
  });

  it('renders inline and block math with KaTeX', async () => {
    const { container } = renderPreview([
      'Inline math $a^2+b^2=c^2$ and \\(x+1\\).',
      '',
      '$$',
      'E = mc^2',
      '$$',
      '',
      '```math',
      '\\int_0^1 x dx',
      '```',
    ].join('\n'));

    await waitFor(() => expect(container.querySelectorAll('.katex').length).toBe(4));
    expect(katexRenderToString).toHaveBeenCalledWith('a^2+b^2=c^2', expect.objectContaining({ displayMode: false, trust: false }));
    expect(katexRenderToString).toHaveBeenCalledWith('x+1', expect.objectContaining({ displayMode: false, trust: false }));
    expect(katexRenderToString).toHaveBeenCalledWith('E = mc^2', expect.objectContaining({ displayMode: true, trust: false }));
    expect(katexRenderToString).toHaveBeenCalledWith('\\int_0^1 x dx', expect.objectContaining({ displayMode: true, trust: false }));
  });

  it('preserves table alignment markers and ordered list start numbers', () => {
    renderPreview([
      '| Left | Center | Right |',
      '| :--- | :---: | ---: |',
      '| a | b | c |',
      '',
      '3) third',
      '4) fourth',
    ].join('\n'));

    const [left, center, right] = screen.getAllByRole('columnheader');
    expect(left.className).toContain('text-left');
    expect(left.className).not.toContain('min-w-[10rem]');
    expect(left.className).not.toContain('max-w-[18rem]');
    expect(left.querySelector('div')?.className).toContain('max-w-none');
    expect(left.querySelector('div')?.className).toContain('whitespace-nowrap');
    expect(center.className).toContain('text-center');
    expect(right.className).toContain('text-right');
    expect(left.closest('table')?.className).toContain('w-max');
    expect(left.closest('table')?.className).toContain('min-w-full');
    expect(screen.getByRole('list').getAttribute('start')).toBe('3');
  });

  it('keeps empty Markdown tables at least as wide as the preview pane', () => {
    renderPreview([
      '|  |  |  |',
      '| --- | --- | --- |',
      '|  |  |  |',
    ].join('\n'));

    const table = screen.getAllByRole('columnheader')[0].closest('table');
    expect(table?.className).toContain('w-max');
    expect(table?.className).toContain('min-w-full');
  });

  it('keeps Markdown tables in a dedicated iOS-friendly horizontal scroller', () => {
    const { container } = renderPreview([
      '| Very long column | Another very long column | Third very long column | Fourth very long column |',
      '| --- | --- | --- | --- |',
      '| a long value | b long value | c long value | d long value |',
    ].join('\n'));

    const scroller = container.querySelector('[data-markdown-table-scroll]');
    expect(scroller?.className).toContain('max-w-full');
    expect(scroller?.className).toContain('termdock-md-table-scroll');
    expect(scroller?.className).toContain('overflow-x-auto');
    expect(scroller?.className).toContain('overflow-y-hidden');
  });

  it('renders one-column Markdown tables with the same overflow-safe cell sizing', () => {
    const { container } = renderPreview([
      '| Only column |',
      '| --- |',
      '| A long value that should use the shared cell width cap instead of falling back to paragraph text. |',
    ].join('\n'));

    const header = screen.getByRole('columnheader', { name: 'Only column' });
    const cell = screen.getByRole('cell');
    expect(header.querySelector('div')?.className).toContain('max-w-none');
    expect(header.querySelector('div')?.className).toContain('whitespace-nowrap');
    expect(cell.textContent).toContain('A long value');
    expect(container.querySelector('table')?.className).toContain('w-max');
  });

  it('keeps hard line breaks inside a paragraph', () => {
    const { container } = renderPreview('first line  \nsecond line\\\nthird line');

    const paragraph = container.querySelector('p');
    expect(paragraph?.textContent).toBe('first linesecond linethird line');
    expect(paragraph?.querySelectorAll('br')).toHaveLength(2);
  });

  it('does not render unsafe image schemes', () => {
    renderPreview('unsafe ![bad](javascript:alert(1)) image');

    expect(screen.queryByRole('img')).toBeNull();
    expect(within(screen.getByText(/unsafe/).closest('p') as HTMLElement).getByText(/!\[bad\]/)).toBeTruthy();
  });

  it('renders reference links and images without showing definition rows', () => {
    const { container } = renderPreview([
      'Read [docs][guide], [Guide], [Guide File], [Local](docs/local.md), [Paren](docs/A_(B).md), [Spaced](<docs/my file.md> \'Spaced title\'), and inspect ![Diagram][diagram] plus ![Logo], ![WideRef], ![ParenImage](images/a_(b).png), and ![Wide](<images/my chart.png> (Chart title)).',
      '',
      '[guide]: https://example.com/guide "Guide title"',
      '[guide file]: <docs/my guide.md> \'Guide file title\'',
      '[diagram]: ./diagram.webp "System diagram"',
      '[logo]: ./logo.png "Logo title"',
      '[wideref]: <images/wide ref.png> (Wide ref title)',
    ].join('\n'));

    const link = screen.getByRole('link', { name: 'docs' });
    expect(link.getAttribute('href')).toBe('https://example.com/guide');
    expect(link.getAttribute('title')).toBe('Guide title');
    expect(screen.getByRole('link', { name: 'Guide' }).getAttribute('href')).toBe('https://example.com/guide');
    expect(screen.getByRole('link', { name: 'Guide File' }).getAttribute('href')).toBe('docs/my guide.md');
    expect(screen.getByRole('link', { name: 'Guide File' }).getAttribute('title')).toBe('Guide file title');
    expect(screen.getByRole('link', { name: 'Local' }).getAttribute('href')).toBe('docs/local.md');
    expect(screen.getByRole('link', { name: 'Paren' }).getAttribute('href')).toBe('docs/A_(B).md');
    expect(screen.getByRole('link', { name: 'Spaced' }).getAttribute('href')).toBe('docs/my file.md');
    expect(screen.getByRole('link', { name: 'Spaced' }).getAttribute('title')).toBe('Spaced title');
    const image = screen.getByRole('img', { name: 'Diagram' });
    expect(image.getAttribute('src')).toBe('/api/terminal/fs/blob?path=%2Frepo%2Fdocs%2Fdiagram.webp');
    expect(image.getAttribute('title')).toBe('System diagram');
    const shortcutImage = screen.getByRole('img', { name: 'Logo' });
    expect(shortcutImage.getAttribute('src')).toBe('/api/terminal/fs/blob?path=%2Frepo%2Fdocs%2Flogo.png');
    expect(shortcutImage.getAttribute('title')).toBe('Logo title');
    const wideRefImage = screen.getByRole('img', { name: 'WideRef' });
    expect(wideRefImage.getAttribute('src')).toBe('/api/terminal/fs/blob?path=%2Frepo%2Fdocs%2Fimages%2Fwide%20ref.png');
    expect(wideRefImage.getAttribute('title')).toBe('Wide ref title');
    expect(screen.getByRole('img', { name: 'ParenImage' }).getAttribute('src')).toBe('/api/terminal/fs/blob?path=%2Frepo%2Fdocs%2Fimages%2Fa_(b).png');
    const spacedImage = screen.getByRole('img', { name: 'Wide' });
    expect(spacedImage.getAttribute('src')).toBe('/api/terminal/fs/blob?path=%2Frepo%2Fdocs%2Fimages%2Fmy%20chart.png');
    expect(spacedImage.getAttribute('title')).toBe('Chart title');
    expect(container.textContent).not.toContain('[guide]:');
    expect(container.textContent).not.toContain('[diagram]:');
    expect(container.textContent).not.toContain('[logo]:');
    expect(container.textContent).not.toContain('[wideref]:');
  });

  it('renders deep nested list items', () => {
    const { container } = renderPreview([
      '- parent',
      '  3. child one',
      '     - grandchild',
      '       2. great grandchild',
      '- sibling',
    ].join('\n'));
    expect(__testParseMarkdownListBlock([
      '- parent',
      '  3. child one',
      '     - grandchild',
      '       2. great grandchild',
      '- sibling',
    ])[0].children[0]).toMatchObject({ ordered: true, start: 3 });
    expect(__testParseMarkdownListBlock([
      '- parent',
      '  3. child one',
      '     - grandchild',
      '       2. great grandchild',
      '- sibling',
    ])[0].children[0].children[0].children[0]).toMatchObject({ content: 'great grandchild', ordered: true, start: 2 });

    expect(container.textContent).toContain('parent');
    expect(container.textContent).toContain('child one');
    expect(container.textContent).toContain('grandchild');
    expect(container.textContent).toContain('great grandchild');
    expect(container.textContent).toContain('sibling');
    expect(container.querySelector('ul ol')?.getAttribute('start')).toBe('3');
    expect(container.querySelector('ul ol ul ol')?.getAttribute('start')).toBe('2');
  });

  it('renders indented continuation paragraphs inside list items', () => {
    renderPreview([
      '- parent',
      '  continuation with **strong** text',
      '  another continuation',
      '- sibling',
    ].join('\n'));

    expect(screen.getByText('parent')).toBeTruthy();
    expect(screen.getByText(/continuation with/)).toBeTruthy();
    expect(screen.getByText('strong')).toBeTruthy();
    expect(screen.getByText('another continuation')).toBeTruthy();
    expect(screen.getByText('sibling')).toBeTruthy();
  });

  it('renders nested task list checkboxes', () => {
    renderPreview([
      '- [ ] parent task',
      '  - [x] nested done',
      '  - [ ] nested todo',
    ].join('\n'));

    const checkboxes = screen.getAllByRole('checkbox') as HTMLInputElement[];
    expect(checkboxes).toHaveLength(3);
    expect(checkboxes[0].checked).toBe(false);
    expect(checkboxes[1].checked).toBe(true);
    expect(checkboxes[2].checked).toBe(false);
    expect(screen.getByText('parent task')).toBeTruthy();
    expect(screen.getByText('nested done')).toBeTruthy();
    expect(screen.getByText('nested todo')).toBeTruthy();
  });

  it('collects document images and wires image buttons to their gallery index', () => {
    const onImageOpen = vi.fn();
    const result = buildMarkdownPreviewRenderResult([
      '![First](../assets/one.png)',
      '',
      '| Inline image |',
      '| --- |',
      '| ![Second](./two.webp) |',
    ], '/repo/docs/guide.md', '/repo', onImageOpen);

    expect(result.images).toEqual([
      { src: '/api/terminal/fs/blob?path=%2Frepo%2Fassets%2Fone.png', alt: 'First', title: undefined },
      { src: '/api/terminal/fs/blob?path=%2Frepo%2Fdocs%2Ftwo.webp', alt: 'Second', title: undefined },
    ]);

    render(<>{result.blocks.map((block) => <div key={block.key}>{block.content}</div>)}</>);
    const buttons = screen.getAllByRole('button');
    buttons[0].click();
    buttons[1].click();
    expect(onImageOpen).toHaveBeenNthCalledWith(1, 0);
    expect(onImageOpen).toHaveBeenNthCalledWith(2, 1);
  });

  it('keeps Markdown image lightbox controls outside the image and preserves tap/double-tap behavior', () => {
    vi.useFakeTimers();
    const onChange = vi.fn();
    const onClose = vi.fn();

    const { container } = render(
      <MarkdownImageLightbox
        images={[
          { src: '/one.png', alt: 'One' },
          { src: '/two.png', alt: 'Two' },
        ]}
        index={0}
        onChange={onChange}
        onClose={onClose}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Next image' }));
    expect(onChange).toHaveBeenCalledWith(1);

    const stage = container.querySelector('[data-markdown-image-lightbox-stage]');
    expect(stage).toBeTruthy();
    fireEvent.click(stage as Element);
    vi.advanceTimersByTime(299);
    expect(onClose).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(onClose).toHaveBeenCalledTimes(1);

    onClose.mockClear();
    const image = screen.getByRole('img', { name: 'One' });
    fireEvent.click(stage as Element);
    fireEvent.doubleClick(image, { clientX: 120, clientY: 120 });
    vi.advanceTimersByTime(350);
    expect(onClose).not.toHaveBeenCalled();

    const imgStyle = image.getAttribute('style') ?? '';
    expect(imgStyle).toContain('scale(2.5)');
    expect(screen.getByRole('button', { name: 'Previous image' }).closest('.flex')?.contains(image)).toBe(false);

    vi.useRealTimers();
  });

  it('uses iOS-like downward swipe thresholds for closing the Markdown image lightbox', () => {
    expect(shouldCloseMarkdownImageLightboxDrag(97, 0.1)).toBe(true);
    expect(shouldCloseMarkdownImageLightboxDrag(60, 0.36)).toBe(true);
    expect(shouldCloseMarkdownImageLightboxDrag(60, 0.2)).toBe(false);
    expect(shouldCloseMarkdownImageLightboxDrag(20, 0.8)).toBe(false);
  });

  it('keeps escaped table pipes inside the same cell', () => {
    renderPreview([
      '| Key | Value | More |',
      '| --- | --- | --- |',
      '| regex | a \\| b | `x|y` and ``a `|` b`` plus [a|b](docs/a.md) and ![x|y](./xy.png) |',
    ].join('\n'));

    const cells = screen.getAllByRole('cell');
    expect(cells).toHaveLength(3);
    expect(cells[1].textContent).toBe('a | b');
    expect(cells[2].textContent).toContain('x|y and a `|` b plus a|b and');
    expect(within(cells[2]).getByRole('link', { name: 'a|b' }).getAttribute('href')).toBe('docs/a.md');
    expect(within(cells[2]).getByRole('img', { name: 'x|y' }).getAttribute('src')).toBe('/api/terminal/fs/blob?path=%2Frepo%2Fdocs%2Fxy.png');
  });

  it('renders footnote references, definitions, continuations, and backrefs', () => {
    const { container } = renderPreview([
      'Metric changed[^p50].',
      '',
      '[^p50]: Use 7-day P50 averages.',
      '    Continuation line.',
    ].join('\n'));

    const footnoteRef = screen.getByTitle('Use 7-day P50 averages. Continuation line.');
    expect(footnoteRef.textContent).toBe('1');
    expect(footnoteRef.querySelector('a')?.getAttribute('href')).toBe('#fn-p50');
    expect(screen.getByText('Footnotes')).toBeTruthy();
    expect(screen.getByText(/Use 7-day P50 averages/).closest('li')?.id).toBe('fn-p50');
    expect(screen.getByLabelText('Back to footnote 1').getAttribute('href')).toBe('#fnref-p50');
    expect(container.textContent).not.toContain('[^p50]:');
  });

  it('renders callout blockquotes as callout panels', () => {
    renderPreview([
      '> [!NOTE] Keep this in mind',
      '> Details with **strong** text.',
    ].join('\n'));

    expect(screen.getByText('NOTE')).toBeTruthy();
    expect(screen.getByText(/Keep this in mind/)).toBeTruthy();
    expect(screen.getByText('strong')).toBeTruthy();
  });

  it('renders block-level Markdown inside regular blockquotes', () => {
    renderPreview([
      '> ## Quote title',
      '> - item one',
      '> - item two',
      '> ```ts',
      '> const ok = true;',
      '> ```',
      '> | A | B |',
      '> | --- | --- |',
      '> | a | b |',
    ].join('\n'));

    expect(screen.getByRole('heading', { name: 'Quote title' })).toBeTruthy();
    expect(screen.getByText('item one')).toBeTruthy();
    expect(screen.getByText('item two')).toBeTruthy();
    expect(screen.getByText('ts')).toBeTruthy();
    expect(screen.getByText('const ok = true;')).toBeTruthy();
    expect(screen.getAllByRole('columnheader')).toHaveLength(2);
    expect(screen.getAllByRole('cell')).toHaveLength(2);
  });

  it('renders a safe inline HTML subset without enabling arbitrary HTML', async () => {
    const { container } = renderPreview('Press <kbd>⌘K</kbd><br/>Use <mark>highlight</mark> H<sub>2</sub>O x<sup>2</sup> <a href="javascript:alert(1)" onclick="alert(2)">bad</a> <span class="ok">inline</span> <script>alert(1)</script>');

    expect(container.querySelector('kbd')?.textContent).toBe('⌘K');
    expect(container.querySelector('br')).toBeTruthy();
    expect(container.querySelector('mark')?.textContent).toBe('highlight');
    expect(container.querySelector('sub')?.textContent).toBe('2');
    expect(container.querySelector('sup')?.textContent).toBe('2');
    await waitFor(() => expect(screen.getByText('inline')).toBeTruthy());
    expect(screen.getByText('bad').closest('a')?.getAttribute('href')).toBeNull();
    expect(screen.getByText('bad').closest('a')?.getAttribute('onclick')).toBeNull();
    expect(container.querySelector('.ok')?.textContent).toBe('inline');
    expect(container.querySelector('script')).toBeNull();
    expect(container.textContent).toContain('<script>alert(1)</script>');
  });

  it('renders details and summary blocks safely', () => {
    renderPreview([
      '<details>',
      '<summary>More **info**</summary>',
      'Hidden <kbd>Esc</kbd> details',
      '</details>',
    ].join('\n'));

    const details = screen.getByText('More').closest('details');
    expect(details).toBeTruthy();
    expect(screen.getByText('info')).toBeTruthy();
    expect(screen.getByText('Esc').tagName.toLowerCase()).toBe('kbd');
  });

  it('renders sanitized block HTML while stripping unsafe content', async () => {
    const { container } = renderPreview([
      '<div class="note" onclick="alert(1)">',
      '<p>Safe <strong>HTML</strong></p>',
      '<a href="javascript:alert(1)">bad link</a>',
      '<script>alert(1)</script>',
      '</div>',
    ].join('\n'));

    expect(screen.getByText('Rendering HTML...')).toBeTruthy();
    await waitFor(() => expect(screen.getByText('HTML')).toBeTruthy());
    expect(domPurifySanitize).toHaveBeenCalledWith(expect.stringContaining('<script>alert(1)</script>'), expect.objectContaining({ ALLOW_DATA_ATTR: false }));
    expect(container.querySelector('script')).toBeNull();
    expect(container.querySelector('[onclick]')).toBeNull();
    expect(container.querySelector('a')?.getAttribute('href')).toBeNull();
    expect(container.querySelector('.note')).toBeTruthy();
  });
});
