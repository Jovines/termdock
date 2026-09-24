import { create } from 'zustand';
import { IMAGE_DIMENSIONS, VIDEO_DIMENSIONS, IMAGE_QUALITY, VIDEO_BITRATE, type ImageDimension, type VideoDimension } from './mediaCompressionOptions';

// Device preferences: deliberately independent of a terminal, service or build.
const STORAGE_KEY = 'termdock:mobile-media-compression-v1';

export type MediaCompressionPreferences = {
  imageEnabled: boolean;
  imageMaxDimension: ImageDimension;
  imageQuality: number;
  videoEnabled: boolean;
  videoMaxHeight: VideoDimension;
  videoBitrate: number;
};

const defaults: MediaCompressionPreferences = {
  imageEnabled: false, imageMaxDimension: 2048, imageQuality: 0.8,
  videoEnabled: false, videoMaxHeight: 720, videoBitrate: 2_500_000,
};

function readPreferences(): MediaCompressionPreferences {
  try {
    const stored = JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null');
    if (!stored || typeof stored !== 'object') return defaults;
    return {
      imageEnabled: stored.imageEnabled === true,
      imageMaxDimension: IMAGE_DIMENSIONS.includes(stored.imageMaxDimension) ? stored.imageMaxDimension : defaults.imageMaxDimension,
      imageQuality: typeof stored.imageQuality === 'number' && stored.imageQuality >= IMAGE_QUALITY.min && stored.imageQuality <= IMAGE_QUALITY.max ? stored.imageQuality : defaults.imageQuality,
      videoEnabled: stored.videoEnabled === true,
      videoMaxHeight: VIDEO_DIMENSIONS.includes(stored.videoMaxHeight) ? stored.videoMaxHeight : defaults.videoMaxHeight,
      videoBitrate: typeof stored.videoBitrate === 'number' && stored.videoBitrate >= VIDEO_BITRATE.min && stored.videoBitrate <= VIDEO_BITRATE.max ? stored.videoBitrate : defaults.videoBitrate,
    };
  } catch {
    return defaults;
  }
}

export const useMediaCompressionPreferences = create<{
  preferences: MediaCompressionPreferences;
  saveFailed: boolean;
  update: (patch: Partial<MediaCompressionPreferences>) => void;
}>((set, get) => ({
  preferences: readPreferences(),
  saveFailed: false,
  update: patch => {
    const preferences = { ...get().preferences, ...patch };
    let saveFailed = false;
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(preferences)); }
    catch { saveFailed = true; }
    // All mounted terminals see the same values; an older tab cannot overwrite
    // a newer choice just by mounting or changing another slider.
    set({ preferences, saveFailed });
  },
}));

if (typeof window !== 'undefined') {
  window.addEventListener('storage', event => {
    if (event.key === STORAGE_KEY || event.key === null) {
      useMediaCompressionPreferences.setState({ preferences: readPreferences(), saveFailed: false });
    }
  });
}
