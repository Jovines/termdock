// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { MarkdownImageLightbox } from './RightSidebar';
import { downloadMarkdownImage } from './markdownImageDownload';

vi.mock('./markdownImageDownload', () => ({ downloadMarkdownImage: vi.fn() }));
vi.mock('swiper/react', () => ({
  Swiper: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  SwiperSlide: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));
vi.mock('swiper/css', () => ({}));
afterEach(() => { cleanup(); vi.resetAllMocks(); });
const images = [
  { kind: 'image' as const, src: 'https://images.test/one.png', alt: 'One' },
  { kind: 'image' as const, src: 'https://images.test/two.png', alt: 'Two' },
];

it('keeps download in the toolbar and disables duplicate clicks until saving finishes', async () => {
  let resolve!: () => void;
  vi.mocked(downloadMarkdownImage).mockReturnValue(new Promise<void>((done) => { resolve = done; }));
  const onClose = vi.fn();
  render(<MarkdownImageLightbox images={images} index={0} onChange={() => {}} onClose={onClose} />);
  const button = screen.getByRole('button', { name: 'Download file' });
  expect(button.closest('[data-markdown-image-lightbox-stage]')).toBeNull();
  fireEvent.click(button);
  fireEvent.click(button);
  expect(downloadMarkdownImage).toHaveBeenCalledExactlyOnceWith(images[0]);
  expect(button.hasAttribute('disabled')).toBe(true);
  expect(onClose).not.toHaveBeenCalled();
  await act(async () => resolve());
  expect(button.hasAttribute('disabled')).toBe(false);
});

it('shows a retryable download error and downloads the selected image after navigation', async () => {
  vi.mocked(downloadMarkdownImage).mockRejectedValueOnce(new Error('offline')).mockResolvedValue(undefined);
  const onClose = vi.fn();
  const view = render(<MarkdownImageLightbox images={images} index={0} onChange={() => {}} onClose={onClose} />);
  fireEvent.click(screen.getByRole('button', { name: 'Download file' }));
  expect((await screen.findByRole('alert')).textContent).toContain('offline');
  fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
  await waitFor(() => expect(screen.queryByRole('alert')).toBeNull());
  view.rerender(<MarkdownImageLightbox images={images} index={1} onChange={() => {}} onClose={onClose} />);
  fireEvent.click(screen.getByRole('button', { name: 'Download file' }));
  await waitFor(() => expect(downloadMarkdownImage).toHaveBeenLastCalledWith(images[1]));
  expect(onClose).not.toHaveBeenCalled();
});
