// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SIDEBAR_GESTURE_IGNORE_ATTR, SWIPER_NO_SWIPING_CLASS } from './gestureArbiter';
import { VideoPreviewPlayer, computeHoldRate, computeScrubTime, formatVideoTime } from './VideoPreviewPlayer';

// jsdom 尚未实现 PointerEvent，testing-library 的 fireEvent.pointerDown 会退化成
// 不带坐标的普通事件；补一个最小实现让拖动测试能带上 clientX/pointerId。
class TestPointerEvent extends MouseEvent {
  readonly pointerId: number;
  constructor(type: string, init: PointerEventInit = {}) {
    super(type, init);
    this.pointerId = init.pointerId ?? 0;
  }
}
if (typeof window !== 'undefined' && !window.PointerEvent) {
  window.PointerEvent = TestPointerEvent as unknown as typeof PointerEvent;
}

afterEach(() => cleanup());

beforeEach(() => {
  vi.restoreAllMocks();
});

function renderPlayer(url = '/api/terminal/fs/video?path=%2Frepo%2Fclips%2Fdemo.mp4') {
  return render(<VideoPreviewPlayer url={url} />);
}

describe('video time formatting', () => {
  it('formats seconds as mm:ss (or h:mm:ss for long videos)', () => {
    expect(formatVideoTime(0)).toBe('00:00');
    expect(formatVideoTime(59)).toBe('00:59');
    expect(formatVideoTime(60)).toBe('01:00');
    expect(formatVideoTime(3661)).toBe('1:01:01');
  });

  it('falls back to 00:00 for invalid durations', () => {
    expect(formatVideoTime(Number.NaN)).toBe('00:00');
    expect(formatVideoTime(-5)).toBe('00:00');
    expect(formatVideoTime(Number.POSITIVE_INFINITY)).toBe('00:00');
  });
});

describe('scrub time math', () => {
  it('maps pointer x to video time linearly', () => {
    expect(computeScrubTime(50, { left: 0, width: 100 }, 100)).toBe(50);
    expect(computeScrubTime(25, { left: 0, width: 100 }, 80)).toBe(20);
  });

  it('clamps outside the track and handles degenerate inputs', () => {
    expect(computeScrubTime(-10, { left: 0, width: 100 }, 100)).toBe(0);
    expect(computeScrubTime(200, { left: 0, width: 100 }, 100)).toBe(100);
    expect(computeScrubTime(50, { left: 0, width: 100 }, 0)).toBe(0);
    expect(computeScrubTime(50, { left: 0, width: 0 }, 100)).toBe(0);
  });
});

describe('VideoPreviewPlayer rendering', () => {
  it('renders a custom player without native controls', () => {
    renderPlayer();
    const video = screen.getByTestId('file-preview-video');
    expect(video.tagName).toBe('VIDEO');
    expect(video.getAttribute('controls')).toBeNull();
    expect(screen.getByTestId('file-preview-video-track').getAttribute('role')).toBe('slider');
    expect(screen.getByRole('button', { name: 'Play' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Rotate 90° clockwise' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Enter fullscreen' })).toBeTruthy();
    expect(screen.getByTestId('file-preview-video-time').textContent).toBe('00:00 / 00:00');
    expect(video.getAttribute('preload')).toBe('auto');
    expect(video.getAttribute('tabindex')).toBe('0');
    // 控制条同时排除 Swiper 与侧边栏抽屉，避免手机上拖进度条串成切页/收抽屉；
    // 视频画面本身不在这两个标记内，仍可侧滑切页。
    const controls = screen.getByTestId('file-preview-video-controls');
    expect(controls.classList.contains(SWIPER_NO_SWIPING_CLASS)).toBe(true);
    expect(controls.hasAttribute(SIDEBAR_GESTURE_IGNORE_ATTR)).toBe(true);
  });

  it('rotates the video in 90 degree steps', () => {
    renderPlayer();
    const player = screen.getByTestId('file-preview-video-player');
    const rotate = screen.getByRole('button', { name: 'Rotate 90° clockwise' });

    fireEvent.click(rotate);
    expect(player.getAttribute('data-rotation')).toBe('90');
    fireEvent.click(rotate);
    expect(player.getAttribute('data-rotation')).toBe('180');
  });

  it('requests fullscreen for the whole player', () => {
    renderPlayer();
    const player = screen.getByTestId('file-preview-video-player');
    const requestFullscreen = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(player, 'requestFullscreen', { configurable: true, value: requestFullscreen });

    fireEvent.click(screen.getByRole('button', { name: 'Enter fullscreen' }));
    expect(requestFullscreen).toHaveBeenCalledOnce();
  });
});

describe('VideoPreviewPlayer scrubbing', () => {
  it('seeks the video to the drag position on release and shows a scrub tooltip', () => {
    renderPlayer();
    const video = screen.getByTestId('file-preview-video') as HTMLVideoElement;
    const track = screen.getByTestId('file-preview-video-track');
    const pauseSpy = vi.spyOn(video, 'pause').mockImplementation(() => {});
    Object.defineProperty(video, 'duration', { configurable: true, value: 100 });
    vi.spyOn(track, 'getBoundingClientRect').mockReturnValue({
      left: 0,
      width: 100,
      top: 0,
      right: 100,
      bottom: 0,
      height: 0,
      x: 0,
      y: 0,
    } as DOMRect);

    fireEvent.pointerDown(track, { clientX: 50, pointerId: 1 });
    // 拖动过程中显示时间气泡，画面跟随 seek。
    expect(screen.getByTestId('file-preview-video-scrub-time').textContent).toBe('00:50');
    expect(pauseSpy).toHaveBeenCalled();

    fireEvent.pointerMove(track, { clientX: 75, pointerId: 1 });
    expect(screen.getByTestId('file-preview-video-scrub-time').textContent).toBe('01:15');

    fireEvent.pointerUp(track, { clientX: 75, pointerId: 1 });
    expect(video.currentTime).toBe(75);
    expect(screen.queryByTestId('file-preview-video-scrub-time')).toBeNull();
    expect(screen.getByTestId('file-preview-video-time').textContent).toBe('01:15 / 00:00');
  });

  it('waits for the current frame and then seeks straight to the latest drag position', () => {
    const frameCallbacks: FrameRequestCallback[] = [];
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) => {
      frameCallbacks.push(callback);
      return frameCallbacks.length;
    });
    vi.spyOn(window, 'cancelAnimationFrame').mockImplementation(() => {});
    renderPlayer();
    const video = screen.getByTestId('file-preview-video') as HTMLVideoElement;
    const track = screen.getByTestId('file-preview-video-track');
    vi.spyOn(video, 'pause').mockImplementation(() => {});
    Object.defineProperty(video, 'duration', { configurable: true, value: 100 });
    const fastSeek = vi.fn((time: number) => {
      video.currentTime = time;
    });
    Object.defineProperty(video, 'fastSeek', { configurable: true, value: fastSeek });
    vi.spyOn(track, 'getBoundingClientRect').mockReturnValue({
      left: 0,
      width: 100,
      top: 0,
      right: 100,
      bottom: 0,
      height: 0,
      x: 0,
      y: 0,
    } as DOMRect);

    fireEvent.pointerDown(track, { clientX: 10, pointerId: 1 });
    act(() => frameCallbacks.shift()?.(0));
    expect(fastSeek).toHaveBeenLastCalledWith(10);

    // 解码第一帧期间的多个位置只更新“最新目标”，不会中断当前 seek。
    fireEvent.pointerMove(track, { clientX: 30, pointerId: 1 });
    fireEvent.pointerMove(track, { clientX: 80, pointerId: 1 });
    act(() => frameCallbacks.shift()?.(16));
    expect(fastSeek).toHaveBeenCalledTimes(1);

    fireEvent.seeked(video);
    // 第一轮让已解码帧真正绘制，第二轮才开始最新位置的 seek。
    act(() => frameCallbacks.shift()?.(32));
    act(() => frameCallbacks.shift()?.(48));
    expect(fastSeek).toHaveBeenCalledTimes(2);
    expect(fastSeek).toHaveBeenLastCalledWith(80);
    fireEvent.pointerUp(track, { clientX: 80, pointerId: 1 });
  });
});

describe('VideoPreviewPlayer long press speed', () => {
  it('uses 2x while held, then restores the previous rate without toggling playback', () => {
    vi.useFakeTimers();
    renderPlayer();
    const video = screen.getByTestId('file-preview-video') as HTMLVideoElement;
    const pauseSpy = vi.spyOn(video, 'pause').mockImplementation(() => {});
    Object.defineProperty(video, 'paused', { configurable: true, value: false });
    video.playbackRate = 1.25;

    fireEvent.pointerDown(video, { button: 0, clientX: 20, clientY: 20, pointerId: 1 });
    act(() => vi.advanceTimersByTime(350));
    expect(video.playbackRate).toBe(2);
    expect(screen.getByText('Playing at 2×')).toBeTruthy();
    // 长按期间视频成为手势盲区，横向拖动留给播放器而不是抽屉/Swiper。
    expect(video.classList.contains(SWIPER_NO_SWIPING_CLASS)).toBe(true);
    expect(video.hasAttribute(SIDEBAR_GESTURE_IGNORE_ATTR)).toBe(true);

    fireEvent.pointerUp(video, { button: 0, clientX: 20, clientY: 20, pointerId: 1 });
    fireEvent.click(video);
    expect(video.playbackRate).toBe(1.25);
    expect(video.hasAttribute(SIDEBAR_GESTURE_IGNORE_ATTR)).toBe(false);
    expect(pauseSpy).not.toHaveBeenCalled();
    vi.useRealTimers();
  });

  it('cancels the hold gesture when the pointer starts swiping', () => {
    vi.useFakeTimers();
    renderPlayer();
    const video = screen.getByTestId('file-preview-video') as HTMLVideoElement;
    Object.defineProperty(video, 'paused', { configurable: true, value: false });

    fireEvent.pointerDown(video, { button: 0, clientX: 10, clientY: 10, pointerId: 1 });
    fireEvent.pointerMove(video, { clientX: 40, clientY: 10, pointerId: 1 });
    act(() => vi.advanceTimersByTime(400));
    expect(video.playbackRate).toBe(1);
    expect(screen.queryByText('Playing at 2×')).toBeNull();
    vi.useRealTimers();
  });

  it('raises the multiplier as the hold gesture drags forward, then restores the rate', () => {
    vi.useFakeTimers();
    renderPlayer();
    const video = screen.getByTestId('file-preview-video') as HTMLVideoElement;
    Object.defineProperty(video, 'paused', { configurable: true, value: false });
    video.playbackRate = 1;

    fireEvent.pointerDown(video, { button: 0, clientX: 10, clientY: 20, pointerId: 1 });
    act(() => vi.advanceTimersByTime(350));
    expect(video.playbackRate).toBe(2);

    // 向右前拖 120px → 每 60px 一档，2× 提升到 4×。
    fireEvent.pointerMove(video, { clientX: 130, clientY: 20, pointerId: 1 });
    expect(video.playbackRate).toBe(4);
    expect(screen.getByText('Playing at 4×')).toBeTruthy();

    // 拖回起点 → 回落到 2×。
    fireEvent.pointerMove(video, { clientX: 10, clientY: 20, pointerId: 1 });
    expect(video.playbackRate).toBe(2);

    fireEvent.pointerUp(video, { clientX: 10, clientY: 20, pointerId: 1 });
    expect(video.playbackRate).toBe(1);
    vi.useRealTimers();
  });
});

describe('hold rate math', () => {
  it('maps forward drag distance to a capped multiplier', () => {
    expect(computeHoldRate(0)).toBe(2);
    expect(computeHoldRate(-50)).toBe(2);
    expect(computeHoldRate(59)).toBe(2);
    expect(computeHoldRate(60)).toBe(3);
    expect(computeHoldRate(240)).toBe(6);
    expect(computeHoldRate(10000)).toBe(8);
  });
});

describe('VideoPreviewPlayer keyboard controls', () => {
  it('seeks with left/right arrows, changes volume, and toggles playback with space', () => {
    renderPlayer();
    const video = screen.getByTestId('file-preview-video') as HTMLVideoElement;
    Object.defineProperty(video, 'duration', { configurable: true, value: 100 });
    video.currentTime = 50;

    fireEvent.keyDown(video, { key: 'ArrowRight' });
    expect(video.currentTime).toBe(55);
    fireEvent.keyDown(video, { key: 'ArrowLeft' });
    expect(video.currentTime).toBe(50);
    fireEvent.keyDown(video, { key: 'ArrowRight', shiftKey: true });
    expect(video.currentTime).toBe(60);

    video.volume = 0.5;
    fireEvent.keyDown(video, { key: 'ArrowUp' });
    expect(video.volume).toBeCloseTo(0.55, 5);
    fireEvent.keyDown(video, { key: 'ArrowDown' });
    expect(video.volume).toBeCloseTo(0.5, 5);
    expect(screen.getByTestId('file-preview-video-volume')).toBeTruthy();

    const playSpy = vi.spyOn(video, 'play').mockResolvedValue(undefined);
    const pauseSpy = vi.spyOn(video, 'pause').mockImplementation(() => {});
    Object.defineProperty(video, 'paused', { configurable: true, value: false });
    fireEvent.keyDown(video, { key: ' ' });
    expect(pauseSpy).toHaveBeenCalledOnce();
    Object.defineProperty(video, 'paused', { configurable: true, value: true });
    fireEvent.keyDown(video, { key: ' ' });
    expect(playSpy).toHaveBeenCalledOnce();
  });
});
