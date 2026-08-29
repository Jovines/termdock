import { useCallback, useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import { Maximize as RiMaximize, Minimize as RiMinimize, Pause as RiPause, Play as RiPlay, RotateCw as RiRotateCw } from 'lucide-react';
import { useI18n } from '../../i18n';
import { SIDEBAR_GESTURE_IGNORE_ATTR, SWIPER_NO_SWIPING_CLASS } from './gestureArbiter';

export function formatVideoTime(totalSeconds: number): string {
  const safe = Number.isFinite(totalSeconds) && totalSeconds > 0 ? Math.floor(totalSeconds) : 0;
  const hours = Math.floor(safe / 3600);
  const minutes = Math.floor((safe % 3600) / 60);
  const seconds = safe % 60;
  const mm = String(minutes).padStart(2, '0');
  const ss = String(seconds).padStart(2, '0');
  return hours > 0 ? `${hours}:${mm}:${ss}` : `${mm}:${ss}`;
}

// Pointer X → 视频时间（秒），按轨道宽度线性映射并夹在 [0, duration]。
export function computeScrubTime(clientX: number, rect: { left: number; width: number }, duration: number): number {
  if (!Number.isFinite(duration) || duration <= 0 || !rect.width) return 0;
  const ratio = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
  return ratio * duration;
}

interface VideoPreviewPlayerProps {
  url: string;
  onLoadError?: () => void;
}

interface VideoWithWebkitFullscreen extends HTMLVideoElement {
  webkitEnterFullscreen?: () => void;
}

const LONG_PRESS_DELAY_MS = 350;
const LONG_PRESS_MOVE_TOLERANCE_PX = 12;
const SCRUB_EXACT_SETTLE_MS = 90;

/**
 * 右侧边栏视频预览播放器。
 *
 * 原生 <video controls> 的进度条只在松手时 seek，拖动过程画面不跟手；这里换成
 * 自绘进度条：拖动时用 rAF 节流地设置 video.currentTime（拖动时暂停、松手恢复），
 * 让画面在拖动过程中实时跳帧。
 */
export function VideoPreviewPlayer({ url, onLoadError }: VideoPreviewPlayerProps) {
  const { t } = useI18n();
  const rootRef = useRef<HTMLDivElement | null>(null);
  const stageRef = useRef<HTMLDivElement | null>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const trackRef = useRef<HTMLDivElement | null>(null);
  const wasPlayingRef = useRef(false);
  const rafRef = useRef<number | null>(null);
  const scrubSettleRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const latestScrubRef = useRef(0);
  const scrubbingRef = useRef(false);
  const scrubSeekInFlightRef = useRef(false);
  const scrubExactPendingRef = useRef(false);
  const longPressTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const longPressPointerRef = useRef<{ id: number; x: number; y: number } | null>(null);
  const longPressActiveRef = useRef(false);
  const playbackRateBeforeLongPressRef = useRef(1);
  const suppressClickRef = useRef(false);
  const [duration, setDuration] = useState(0);
  const [currentTime, setCurrentTime] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [scrubTime, setScrubTime] = useState<number | null>(null);
  const [longPressActive, setLongPressActive] = useState(false);
  const [rotation, setRotation] = useState(0);
  const [fullscreen, setFullscreen] = useState(false);
  const [stageSize, setStageSize] = useState({ width: 0, height: 0 });

  const clearLongPressTimer = useCallback(() => {
    if (longPressTimerRef.current !== null) {
      clearTimeout(longPressTimerRef.current);
      longPressTimerRef.current = null;
    }
  }, []);

  const restorePlaybackRate = useCallback(() => {
    clearLongPressTimer();
    longPressPointerRef.current = null;
    if (!longPressActiveRef.current) return false;
    const video = videoRef.current;
    if (video) video.playbackRate = playbackRateBeforeLongPressRef.current;
    longPressActiveRef.current = false;
    setLongPressActive(false);
    return true;
  }, [clearLongPressTimer]);

  useEffect(() => () => {
    if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
    if (scrubSettleRef.current !== null) clearTimeout(scrubSettleRef.current);
    clearLongPressTimer();
    const video = videoRef.current;
    if (video && longPressActiveRef.current) video.playbackRate = playbackRateBeforeLongPressRef.current;
  }, [clearLongPressTimer]);

  useEffect(() => {
    const stage = stageRef.current;
    if (!stage || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(([entry]) => {
      if (!entry) return;
      setStageSize({ width: entry.contentRect.width, height: entry.contentRect.height });
    });
    observer.observe(stage);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const handleFullscreenChange = () => setFullscreen(document.fullscreenElement === rootRef.current);
    document.addEventListener('fullscreenchange', handleFullscreenChange);
    return () => document.removeEventListener('fullscreenchange', handleFullscreenChange);
  }, []);

  const seekTo = useCallback((time: number, fast = false): boolean => {
    const video = videoRef.current;
    if (!video) return false;
    const end = Number.isFinite(video.duration) ? video.duration : time;
    const next = Math.min(Math.max(time, 0), end);
    setCurrentTime(next);
    if (Math.abs(video.currentTime - next) < 1 / 120) return false;
    const fastSeek = (video as unknown as { fastSeek?: (nextTime: number) => void }).fastSeek;
    if (fast && typeof fastSeek === 'function') fastSeek.call(video, next);
    else video.currentTime = next;
    return true;
  }, []);

  const scheduleScrubSeek = useCallback(() => {
    if (rafRef.current !== null) return;
    rafRef.current = requestAnimationFrame(() => {
      rafRef.current = null;
      const video = videoRef.current;
      if (!video || !scrubbingRef.current || scrubSeekInFlightRef.current || video.seeking) return;
      const exact = scrubExactPendingRef.current;
      scrubExactPendingRef.current = false;
      // 一次只解码一个目标；上一帧完成后直接取手指的最新位置，跳过已经
      // 过期的中间点，避免连续 currentTime 写入反复取消正在进行的解码。
      scrubSeekInFlightRef.current = seekTo(latestScrubRef.current, !exact);
    });
  }, [seekTo]);

  const handleScrubMove = useCallback((clientX: number) => {
    const track = trackRef.current;
    const video = videoRef.current;
    if (!track || !video) return;
    const rect = track.getBoundingClientRect();
    const time = computeScrubTime(clientX, rect, video.duration);
    latestScrubRef.current = time;
    setScrubTime(time);
    scrubExactPendingRef.current = false;
    scheduleScrubSeek();
    if (scrubSettleRef.current !== null) clearTimeout(scrubSettleRef.current);
    scrubSettleRef.current = setTimeout(() => {
      scrubSettleRef.current = null;
      scrubExactPendingRef.current = true;
      scheduleScrubSeek();
    }, SCRUB_EXACT_SETTLE_MS);
  }, [scheduleScrubSeek]);

  const flushScrub = useCallback(() => {
    if (rafRef.current !== null) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }
    if (scrubSettleRef.current !== null) {
      clearTimeout(scrubSettleRef.current);
      scrubSettleRef.current = null;
    }
    scrubExactPendingRef.current = false;
    scrubSeekInFlightRef.current = false;
    seekTo(latestScrubRef.current);
  }, [seekTo]);

  const startScrub = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    const video = videoRef.current;
    if (!video || !Number.isFinite(video.duration) || video.duration <= 0) return;
    wasPlayingRef.current = !video.paused;
    video.pause();
    scrubbingRef.current = true;
    setDragging(true);
    try {
      event.currentTarget.setPointerCapture(event.pointerId);
    } catch {
      // jsdom / 老环境没有 pointer capture 也不影响拖动。
    }
    handleScrubMove(event.clientX);
  }, [handleScrubMove]);

  const endScrub = useCallback(() => {
    scrubbingRef.current = false;
    flushScrub();
    setDragging(false);
    setScrubTime(null);
    const video = videoRef.current;
    if (video && wasPlayingRef.current && !video.ended) {
      void video.play().catch(() => undefined);
    }
    wasPlayingRef.current = false;
  }, [flushScrub]);

  const togglePlay = useCallback(() => {
    const video = videoRef.current;
    if (!video) return;
    if (suppressClickRef.current) {
      suppressClickRef.current = false;
      return;
    }
    if (video.paused) void video.play().catch(() => undefined);
    else video.pause();
  }, []);

  const startLongPress = useCallback((event: ReactPointerEvent<HTMLVideoElement>) => {
    const video = videoRef.current;
    if (!video || video.paused || event.button !== 0) return;
    clearLongPressTimer();
    longPressPointerRef.current = { id: event.pointerId, x: event.clientX, y: event.clientY };
    longPressTimerRef.current = setTimeout(() => {
      longPressTimerRef.current = null;
      playbackRateBeforeLongPressRef.current = video.playbackRate;
      video.playbackRate = 2;
      longPressActiveRef.current = true;
      setLongPressActive(true);
    }, LONG_PRESS_DELAY_MS);
  }, [clearLongPressTimer]);

  const moveLongPress = useCallback((event: ReactPointerEvent<HTMLVideoElement>) => {
    const start = longPressPointerRef.current;
    if (!start || start.id !== event.pointerId || longPressActiveRef.current) return;
    if (Math.hypot(event.clientX - start.x, event.clientY - start.y) > LONG_PRESS_MOVE_TOLERANCE_PX) {
      clearLongPressTimer();
      longPressPointerRef.current = null;
    }
  }, [clearLongPressTimer]);

  const endLongPress = useCallback(() => {
    const wasActive = restorePlaybackRate();
    if (wasActive) suppressClickRef.current = true;
  }, [restorePlaybackRate]);

  useEffect(() => {
    window.addEventListener('pointerup', endLongPress);
    window.addEventListener('pointercancel', endLongPress);
    window.addEventListener('blur', endLongPress);
    return () => {
      window.removeEventListener('pointerup', endLongPress);
      window.removeEventListener('pointercancel', endLongPress);
      window.removeEventListener('blur', endLongPress);
    };
  }, [endLongPress]);

  const toggleFullscreen = useCallback(async () => {
    const root = rootRef.current;
    const video = videoRef.current as VideoWithWebkitFullscreen | null;
    if (!root || !video) return;
    try {
      if (document.fullscreenElement === root) await document.exitFullscreen();
      else if (root.requestFullscreen) await root.requestFullscreen();
      else video.webkitEnterFullscreen?.();
    } catch {
      video.webkitEnterFullscreen?.();
    }
  }, []);

  const rotateVideo = useCallback(() => setRotation((value) => (value + 90) % 360), []);

  const handleTrackKeyDown = useCallback((event: React.KeyboardEvent<HTMLDivElement>) => {
    const video = videoRef.current;
    if (!video || !Number.isFinite(video.duration)) return;
    const step = event.shiftKey ? 10 : 5;
    let next: number | null = null;
    if (event.key === 'ArrowLeft') next = video.currentTime - step;
    else if (event.key === 'ArrowRight') next = video.currentTime + step;
    else if (event.key === 'Home') next = 0;
    else if (event.key === 'End') next = video.duration;
    if (next === null) return;
    event.preventDefault();
    seekTo(next);
  }, [seekTo]);

  const displayTime = dragging && scrubTime !== null ? scrubTime : currentTime;
  const progress = duration > 0 ? Math.min(1, Math.max(0, displayTime / duration)) : 0;
  const sideways = rotation === 90 || rotation === 270;
  const measuredRotatedStyle = sideways && stageSize.width > 0 && stageSize.height > 0
    ? { width: `${stageSize.height}px`, height: `${stageSize.width}px` }
    : { width: '100%', height: '100%' };

  return (
    <div
      ref={rootRef}
      className="flex h-full min-h-0 flex-col overflow-hidden rounded-lg bg-background fullscreen:h-screen fullscreen:w-screen fullscreen:rounded-none"
      data-testid="file-preview-video-player"
      data-rotation={rotation}
    >
      <div ref={stageRef} className="relative min-h-0 flex-1 overflow-hidden bg-background">
        <video
          ref={videoRef}
          data-testid="file-preview-video"
          className="absolute left-1/2 top-1/2 max-w-none object-contain transition-transform duration-200"
          style={{ ...measuredRotatedStyle, transform: `translate(-50%, -50%) rotate(${rotation}deg)` }}
          src={url}
          preload="auto"
          playsInline
          onClick={togglePlay}
          onPointerDown={startLongPress}
          onPointerMove={moveLongPress}
          onPointerUp={endLongPress}
          onPointerCancel={endLongPress}
          onContextMenu={(event) => {
            if (longPressActiveRef.current) event.preventDefault();
          }}
          onPlay={() => setPlaying(true)}
          onPause={() => setPlaying(false)}
          onTimeUpdate={(event) => setCurrentTime(event.currentTarget.currentTime)}
          onSeeked={(event) => {
            const video = event.currentTarget;
            setCurrentTime(video.currentTime);
            scrubSeekInFlightRef.current = false;
            if (!scrubbingRef.current) return;
            const requestPresentedFrame = (video as unknown as {
              requestVideoFrameCallback?: (callback: () => void) => number;
            }).requestVideoFrameCallback;
            if (typeof requestPresentedFrame === 'function') {
              requestPresentedFrame.call(video, () => {
                if (scrubbingRef.current) scheduleScrubSeek();
              });
            } else {
              // 下一次 rAF 先让刚解码的帧完成绘制，随后 scheduleScrubSeek
              // 再排入下一帧，避免在同一轮 paint 前立刻把它取消掉。
              requestAnimationFrame(() => {
                if (scrubbingRef.current) scheduleScrubSeek();
              });
            }
          }}
          onLoadedMetadata={(event) => setDuration(Number.isFinite(event.currentTarget.duration) ? event.currentTarget.duration : 0)}
          onDurationChange={(event) => setDuration(Number.isFinite(event.currentTarget.duration) ? event.currentTarget.duration : 0)}
          onError={onLoadError}
        >
          {t('rightSidebar.videoUnsupported')}
        </video>
        {longPressActive && (
          <div className="pointer-events-none absolute left-1/2 top-3 z-10 -translate-x-1/2 rounded-full bg-surface-elevated px-3 py-1 text-xs font-semibold tabular-nums text-foreground shadow-md">
            {t('rightSidebar.videoLongPressSpeed')}
          </div>
        )}
        {dragging && scrubTime !== null && (
          <div
            className="pointer-events-none absolute bottom-1 z-10 -translate-x-1/2 rounded-md bg-surface-elevated px-2 py-1 text-[11px] font-medium text-foreground shadow-md"
            style={{ left: `${progress * 100}%` }}
            data-testid="file-preview-video-scrub-time"
          >
            {formatVideoTime(scrubTime)}
          </div>
        )}
      </div>
      {/* 控制条是横向拖动密集区：必须同时排除文件预览 Swiper 和侧边栏抽屉，
          否则手机上拖进度条会串成切页/收抽屉。视频画面本身保持可侧滑切页。 */}
      <div
        data-testid="file-preview-video-controls"
        className={`shrink-0 border-t border-border/60 bg-background px-2 py-1.5 ${SWIPER_NO_SWIPING_CLASS}`}
        {...{ [SIDEBAR_GESTURE_IGNORE_ATTR]: '' }}
      >
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={togglePlay}
            aria-label={playing ? t('rightSidebar.videoPause') : t('rightSidebar.videoPlay')}
            title={playing ? t('rightSidebar.videoPause') : t('rightSidebar.videoPlay')}
            className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-foreground transition hover:bg-surface-elevated active:scale-95"
            data-testid="file-preview-video-play"
          >
            {playing ? <RiPause size={14} /> : <RiPlay size={14} />}
          </button>
          <div
            ref={trackRef}
            role="slider"
            aria-label="Seek"
            aria-valuemin={0}
            aria-valuemax={Math.floor(duration)}
            aria-valuenow={Math.floor(displayTime)}
            tabIndex={0}
            className="group relative h-5 min-w-0 flex-1 cursor-pointer touch-none py-2"
            data-testid="file-preview-video-track"
            onPointerDown={startScrub}
            onPointerMove={(event) => {
              if (dragging) handleScrubMove(event.clientX);
            }}
            onPointerUp={endScrub}
            onPointerCancel={endScrub}
            onKeyDown={handleTrackKeyDown}
          >
            <div className="h-1 w-full rounded-full bg-surface-elevated" />
            <div className="absolute inset-y-0 left-0 my-auto h-1 rounded-full bg-primary" style={{ width: `${progress * 100}%` }} />
            <div
              className="absolute top-1/2 h-3 w-3 -translate-x-1/2 -translate-y-1/2 rounded-full bg-primary shadow"
              style={{ left: `${progress * 100}%` }}
            />
          </div>
          <div className="shrink-0 text-[11px] tabular-nums text-muted-foreground" data-testid="file-preview-video-time">
            {formatVideoTime(displayTime)} / {formatVideoTime(duration)}
          </div>
          <button
            type="button"
            onClick={rotateVideo}
            aria-label={t('rightSidebar.videoRotate')}
            title={t('rightSidebar.videoRotate')}
            className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-foreground transition hover:bg-surface-elevated active:scale-95"
            data-testid="file-preview-video-rotate"
          >
            <RiRotateCw size={14} />
          </button>
          <button
            type="button"
            onClick={() => void toggleFullscreen()}
            aria-label={fullscreen ? t('rightSidebar.videoFullscreenExit') : t('rightSidebar.videoFullscreenEnter')}
            title={fullscreen ? t('rightSidebar.videoFullscreenExit') : t('rightSidebar.videoFullscreenEnter')}
            className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-foreground transition hover:bg-surface-elevated active:scale-95"
            data-testid="file-preview-video-fullscreen"
          >
            {fullscreen ? <RiMinimize size={14} /> : <RiMaximize size={14} />}
          </button>
        </div>
      </div>
    </div>
  );
}
