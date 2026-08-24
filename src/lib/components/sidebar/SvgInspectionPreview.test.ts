// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { createElement } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { clientPointToSvgViewBox, formatSvgAnnotation, SvgInspectionPreview } from './SvgInspectionPreview';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function renderPreview() {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
    text: () => Promise.resolve('<svg viewBox="0 0 100 100"><text x="10" y="10">U1</text></svg>'),
  }));
  return render(createElement(SvgInspectionPreview, {
    blobUrl: 'blob:test',
    filePath: '/work/review.svg',
    viewLabel: 'SVG 文件',
  }));
}

describe('SVG annotation', () => {
  it('maps a zoomed pointer through xMidYMid meet letterboxing into viewBox coordinates', () => {
    expect(clientPointToSvgViewBox(
      400,
      300,
      { left: 100, top: 50, width: 800, height: 500 },
      { x: 10, y: 20, width: 200, height: 100 },
    )).toEqual({ x: 85, y: 70, xPercent: 37.5, yPercent: 50 });

    expect(clientPointToSvgViewBox(
      110,
      60,
      { left: 100, top: 50, width: 800, height: 500 },
      { x: 10, y: 20, width: 200, height: 100 },
    )).toBeNull();
  });

  it('includes vector coordinates, normalized position and nearest label', () => {
    expect(formatSvgAnnotation('/work/review.svg', '原理图第1页', {
      x: 123.456,
      y: 78.9,
      xPercent: 34.56,
      yPercent: 12.34,
      nearestText: 'U2',
    })).toBe('"SVG标注: /work/review.svg / 视图: 原理图第1页 / SVG坐标: (123.46,78.90) [viewBox坐标] / 图片位置: (34.6%,12.3%) [相对内容边界左上角] / 最近文字: U2"');
  });

  it('uses an app-level fullscreen overlay that also works without the browser Fullscreen API', async () => {
    renderPreview();
    await waitFor(() => expect(screen.getByText('U1')).toBeTruthy());

    fireEvent.click(screen.getByRole('button', { name: '全屏 SVG' }));

    expect(screen.getByRole('button', { name: '退出全屏 SVG' })).toBeTruthy();
    expect(document.body.querySelector('.fixed.inset-0.z-modal-panel')).toBeTruthy();
  });

  it('only exposes fit-to-window after the SVG has been enlarged', async () => {
    const { container } = renderPreview();
    await waitFor(() => expect(screen.getByText('U1')).toBeTruthy());
    const canvas = container.querySelector<HTMLDivElement>('div[role="button"]');
    const toolbar = container.querySelector<HTMLDivElement>('[data-svg-toolbar]');
    expect(canvas).toBeTruthy();
    expect(toolbar).toBeTruthy();
    expect(toolbar?.parentElement).toBe(canvas?.parentElement);
    expect(toolbar?.classList.contains('absolute')).toBe(true);

    expect(screen.queryByRole('button', { name: '适合窗口' })).toBeNull();
    fireEvent.doubleClick(canvas!);
    expect(screen.getByRole('button', { name: '适合窗口' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '适合窗口' }));
    expect(screen.queryByRole('button', { name: '适合窗口' })).toBeNull();
  });

  it('places the pick marker at the pointer instead of adding the scroller offset again', async () => {
    const { container } = renderPreview();
    await waitFor(() => expect(screen.getByText('U1')).toBeTruthy());
    const canvas = container.querySelector<HTMLDivElement>('div[role="button"]')!;
    const stage = canvas.parentElement as HTMLDivElement;
    const svg = container.querySelector<SVGSVGElement>('[data-svg-document] > svg')!;
    Object.defineProperty(svg, 'viewBox', { value: { baseVal: { x: 0, y: 0, width: 100, height: 100 } } });
    svg.getBoundingClientRect = () => ({ left: 100, top: 50, width: 400, height: 400, right: 500, bottom: 450, x: 100, y: 50, toJSON: () => ({}) });
    stage.getBoundingClientRect = () => ({ left: 80, top: 30, width: 440, height: 440, right: 520, bottom: 470, x: 80, y: 30, toJSON: () => ({}) });
    canvas.scrollLeft = 280;
    canvas.scrollTop = 160;

    fireEvent.click(canvas, { clientX: 300, clientY: 250 });

    const marker = container.querySelector<HTMLElement>('[data-svg-pick-marker]');
    const insertButton = screen.getByRole('button', { name: '引用 SVG 标注' });
    expect(marker?.style.left).toBe('220px');
    expect(marker?.style.top).toBe('220px');
    expect(marker?.parentElement).toBe(stage);
    expect(insertButton.parentElement).toBe(stage);
    expect(insertButton.classList.contains('absolute')).toBe(true);
    expect(insertButton.style.left).toBe('calc(50% + 8px)');
    expect(insertButton.style.top).toBe('calc(50% + 8px)');
  });
});
