// Shared by the controls, persisted preferences and local encoders.
export const IMAGE_DIMENSIONS = [640, 960, 1280, 1600, 2048, 2560, 3072, 4096] as const;
export const VIDEO_DIMENSIONS = [240, 360, 480, 540, 720, 1080, 1440, 2160] as const;
export type ImageDimension = typeof IMAGE_DIMENSIONS[number];
export type VideoDimension = typeof VIDEO_DIMENSIONS[number];
export const IMAGE_QUALITY = { min: 0.1, max: 1, step: 0.01 } as const;
export const VIDEO_BITRATE = { min: 250_000, max: 20_000_000, step: 250_000 } as const;
