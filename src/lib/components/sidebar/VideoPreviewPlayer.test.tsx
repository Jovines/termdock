// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SIDEBAR_GESTURE_IGNORE_ATTR, SWIPER_NO_SWIPING_CLASS } from './gestureArbiter';
import { VideoPreviewPlayer, computeScrubTime, formatVideoTime } from './VideoPreviewPlayer';

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
    expect(screen.getByTestId('file-preview-video-time').textContent).toBe('00:00 / 00:00');
    // 控制条同时排除 Swiper 与侧边栏抽屉，避免手机上拖进度条串成切页/收抽屉；
    // 视频画面本身不在这两个标记内，仍可侧滑切页。
    const controls = screen.getByTestId('file-preview-video-controls');
    expect(controls.classList.contains(SWIPER_NO_SWIPING_CLASS)).toBe(true);
    expect(controls.hasAttribute(SIDEBAR_GESTURE_IGNORE_ATTR)).toBe(true);
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
  });
});
