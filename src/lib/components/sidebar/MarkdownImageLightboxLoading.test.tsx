// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { MarkdownImageLightbox } from './RightSidebar';
import { clearPreviewResourceCache } from '../../utils/previewResourceCache';
import { useSidebarStore } from '../../stores/useSidebarStore';

vi.mock('swiper/react', () => ({
  Swiper: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  SwiperSlide: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));
vi.mock('swiper/css', () => ({}));
const originalWorker = navigator.serviceWorker;
const originalCreate = URL.createObjectURL;
const originalRevoke = URL.revokeObjectURL;
const src = '/api/terminal/fs/blob?path=%2Ftmp%2Fmap.svg';
function open() {
  return render(<MarkdownImageLightbox images={[{ kind: 'image', src, alt: 'Mind map' }]} index={0} onChange={() => {}} onClose={() => {}} />);
}
beforeEach(() => {
  Object.defineProperty(navigator, 'serviceWorker', { configurable: true, value: undefined });
  URL.createObjectURL = vi.fn(() => 'blob:http://localhost/map');
  URL.revokeObjectURL = vi.fn();
  clearPreviewResourceCache();
});
afterEach(() => {
  cleanup();
  clearPreviewResourceCache();
  vi.unstubAllGlobals();
  Object.defineProperty(navigator, 'serviceWorker', { configurable: true, value: originalWorker });
  URL.createObjectURL = originalCreate;
  URL.revokeObjectURL = originalRevoke;
});

it('fetches immediately without a worker and withholds the image until its blob is ready', async () => {
  let resolve!: (response: Response) => void;
  const fetchMock = vi.fn(() => new Promise<Response>((done) => { resolve = done; }));
  vi.stubGlobal('fetch', fetchMock);
  const view = open();
  expect(fetchMock).toHaveBeenCalledOnce();
  expect(screen.getByRole('status').textContent).toBe('Loading image…');
  expect(screen.queryByRole('img')).toBeNull();
  await act(async () => { resolve(new Response('<svg/>', { headers: { 'Content-Type': 'image/svg+xml' } })); });
  expect(screen.getByRole('img').getAttribute('src')).toBe('blob:http://localhost/map');
  expect(document.querySelector('[data-vector-zoom-surface]')).toBeTruthy();
  view.unmount();
  expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:http://localhost/map');
});

it('shows a retryable error without issuing a native business request', async () => {
  const fetchMock = vi.fn().mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce(new Response('<svg/>'));
  vi.stubGlobal('fetch', fetchMock);
  open();
  expect((await screen.findByRole('alert')).textContent).toContain('Failed to load image preview');
  expect(screen.queryByRole('img')).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
  await waitFor(() => expect(screen.getByRole('img').getAttribute('src')).toBe('blob:http://localhost/map'));
  expect(fetchMock).toHaveBeenCalledTimes(2);
});

it('aborts a closed preview without reporting a late failure', async () => {
  let signal!: AbortSignal;
  vi.stubGlobal('fetch', vi.fn((_url, options) => {
    signal = options.signal;
    return new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason)));
  }));
  const view = open();
  view.unmount();
  expect(signal.aborted).toBe(true);
  await act(async () => {});
  expect(URL.createObjectURL).not.toHaveBeenCalled();
});

it('reloads when the file version changes and clears the stale image while waiting', async () => {
  const initialEpoch = useSidebarStore.getState().fileWatchEpoch;
  let resolve!: (response: Response) => void;
  const fetchMock = vi.fn().mockResolvedValueOnce(new Response('<svg/>')).mockImplementationOnce(() => new Promise<Response>((done) => { resolve = done; }));
  vi.stubGlobal('fetch', fetchMock);
  const view = open();
  await screen.findByRole('img');
  act(() => useSidebarStore.setState({ fileWatchEpoch: initialEpoch + 1 }));
  expect(screen.queryByRole('img')).toBeNull();
  expect(fetchMock.mock.calls[1][0]).toContain(`v=${initialEpoch + 1}`);
  await act(async () => { resolve(new Response('<svg/>')); });
  expect(screen.getByRole('img').getAttribute('src')).toBe('blob:http://localhost/map');
  view.unmount();
  useSidebarStore.setState({ fileWatchEpoch: initialEpoch });
});
