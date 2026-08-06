import { useCallback, useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import { Pause as RiPause, Play as RiPlay } from 'lucide-react';
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

/**
 * 右侧边栏视频预览播放器。
 *
 * 原生 <video controls> 的进度条只在松手时 seek，拖动过程画面不跟手；这里换成
 * 自绘进度条：拖动时用 rAF 节流地设置 video.currentTime（拖动时暂停、松手恢复），
 * 让画面在拖动过程中实时跳帧。
 */
export function VideoPreviewPlayer({ url, onLoadError }: VideoPreviewPlayerProps) {
  const { t } = useI18n();
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const trackRef = useRef<HTMLDivElement | null>(null);
  const wasPlayingRef = useRef(false);
  const rafRef = useRef<number | null>(null);
  const latestScrubRef = useRef(0);
  const [duration, setDuration] = useState(0);
  const [currentTime, setCurrentTime] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [scrubTime, setScrubTime] = useState<number | null>(null);

  useEffect(() => () => {
    if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
  }, []);

  const seekTo = useCallback((time: number) => {
    const video = videoRef.current;
    if (!video) return;
    const end = Number.isFinite(video.duration) ? video.duration : time;
    video.currentTime = Math.min(Math.max(time, 0), end);
  }, []);

  const handleScrubMove = useCallback((clientX: number) => {
    const track = trackRef.current;
    const video = videoRef.current;
    if (!track || !video) return;
    const rect = track.getBoundingClientRect();
    const time = computeScrubTime(clientX, rect, video.duration);
    latestScrubRef.current = time;
    setScrubTime(time);
    // rAF 节流：每帧只发最后一次 seek，避免拖动过程产生 seek 风暴。
    if (rafRef.current === null) {
      rafRef.current = requestAnimationFrame(() => {
        rafRef.current = null;
        seekTo(latestScrubRef.current);
      });
    }
  }, [seekTo]);

  const flushScrub = useCallback(() => {
    if (rafRef.current !== null) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }
    seekTo(latestScrubRef.current);
  }, [seekTo]);

  const startScrub = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    const video = videoRef.current;
    if (!video || !Number.isFinite(video.duration) || video.duration <= 0) return;
    wasPlayingRef.current = !video.paused;
    video.pause();
    setDragging(true);
    try {
      event.currentTarget.setPointerCapture(event.pointerId);
    } catch {
      // jsdom / 老环境没有 pointer capture 也不影响拖动。
    }
    handleScrubMove(event.clientX);
  }, [handleScrubMove]);

  const endScrub = useCallback(() => {
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
    if (video.paused) void video.play().catch(() => undefined);
    else video.pause();
  }, []);

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

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden rounded-lg bg-background" data-testid="file-preview-video-player">
      <div className="relative min-h-0 flex-1">
        <video
          ref={videoRef}
          data-testid="file-preview-video"
          className="h-full w-full object-contain"
          src={url}
          preload="metadata"
          playsInline
          onClick={togglePlay}
          onPlay={() => setPlaying(true)}
          onPause={() => setPlaying(false)}
          onTimeUpdate={(event) => setCurrentTime(event.currentTarget.currentTime)}
          onLoadedMetadata={(event) => setDuration(Number.isFinite(event.currentTarget.duration) ? event.currentTarget.duration : 0)}
          onDurationChange={(event) => setDuration(Number.isFinite(event.currentTarget.duration) ? event.currentTarget.duration : 0)}
          onError={onLoadError}
        >
          {t('rightSidebar.videoUnsupported')}
        </video>
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
        </div>
      </div>
    </div>
  );
}
