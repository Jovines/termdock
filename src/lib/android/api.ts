export interface AndroidDevice {
  serial: string;
  state: 'device' | 'offline' | 'unauthorized' | 'connecting' | 'unknown';
  model?: string;
  product?: string;
  device?: string;
  transport?: string;
  isNetwork?: boolean;
  androidVersion?: string;
  sdk?: number;
}

export interface AndroidDeviceList {
  adbAvailable: boolean;
  scrcpyVersion: string | null;
  devices: AndroidDevice[];
}

async function requestJson<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    ...init,
    headers: { 'Content-Type': 'application/json', Accept: 'application/json', ...(init?.headers ?? {}) },
  });
  const payload = await response.json().catch(() => null) as (T & { error?: string; code?: string }) | null;
  if (!response.ok || !payload) {
    const message = payload?.error || payload?.code || `ANDROID_REQUEST_FAILED_${response.status}`;
    throw new Error(message);
  }
  return payload;
}

export async function listAndroidDevices(): Promise<AndroidDeviceList> {
  return requestJson<AndroidDeviceList>('/api/android/devices');
}

export async function connectAndroidDevice(address: string): Promise<{ serial: string; output: string }> {
  return requestJson<{ serial: string; output: string }>('/api/android/connect', {
    method: 'POST', body: JSON.stringify({ address }),
  });
}

export async function disconnectAndroidDevice(address: string): Promise<void> {
  await requestJson<{ ok: boolean }>('/api/android/disconnect', {
    method: 'POST', body: JSON.stringify({ address }),
  });
}

/** 画质：三档快捷预设 + 自定义。scrcpy 参数在会话启动时固定，切换会重连流。 */
export type AndroidQualityId = 'auto' | 'low' | 'medium' | 'high' | 'custom';
export interface AndroidQuality { id: AndroidQualityId; maxSize: number; bitRate: number; maxFps: number }

export const ANDROID_QUALITY_PRESETS: AndroidQuality[] = [
  { id: 'low', maxSize: 720, bitRate: 1_200_000, maxFps: 30 },
  { id: 'medium', maxSize: 1080, bitRate: 4_000_000, maxFps: 30 },
  { id: 'high', maxSize: 1600, bitRate: 8_000_000, maxFps: 60 },
];
export const DEFAULT_ANDROID_QUALITY = ANDROID_QUALITY_PRESETS[1]!;

/** 服务端也会 clamp；这里只做粗略校验，避免把非法值写进存储。 */
export function normalizeAndroidQuality(value: unknown): AndroidQuality {
  if (!value || typeof value !== 'object') return DEFAULT_ANDROID_QUALITY;
  const candidate = value as Partial<AndroidQuality>;
  if (candidate.id === 'auto') return { id: 'auto', maxSize: 1080, bitRate: 4_000_000, maxFps: 30 };
  const preset = ANDROID_QUALITY_PRESETS.find(item => item.id === candidate.id);
  if (preset) return preset;
  if (candidate.id !== 'custom') return DEFAULT_ANDROID_QUALITY;
  const maxSize = typeof candidate.maxSize === 'number' ? Math.max(360, Math.min(2160, Math.round(candidate.maxSize))) : 1080;
  const bitRate = typeof candidate.bitRate === 'number' ? Math.max(300_000, Math.min(30_000_000, Math.round(candidate.bitRate))) : 4_000_000;
  const maxFps = typeof candidate.maxFps === 'number' ? Math.max(0, Math.min(60, Math.round(candidate.maxFps))) : 30;
  return { id: 'custom', maxSize, bitRate, maxFps };
}

/** serial 允许 `:`（网络设备），编码会破坏路径匹配，因此只做白名单校验后原样拼入。 */
export function androidStreamPath(serial: string, quality?: AndroidQuality): string {
  if (!/^[0-9a-zA-Z_.:\-]{1,128}$/.test(serial)) throw new Error('INVALID_SERIAL');
  const params = new URLSearchParams();
  if (quality) {
    params.set('max_size', String(quality.maxSize));
    params.set('bit_rate', String(quality.bitRate));
    if (quality.maxFps > 0) params.set('max_fps', String(quality.maxFps));
  }
  const query = params.toString();
  return `/api/android/${serial}/ws${query ? `?${query}` : ''}`;
}

export function androidErrorText(code: string): string {
  const known: Record<string, string> = {
    ADB_UNAVAILABLE: '本机没有可用的 adb，请先安装 Android platform-tools。',
    ADB_NOT_FOUND: '找不到 adb 可执行文件，可用 TERMDOCK_ADB_BIN 指定路径。',
    SCRCPY_NOT_FOUND: '本机没有 scrcpy，请先安装（含 scrcpy-server）。',
    SCRCPY_SERVER_NOT_FOUND: '找不到 scrcpy-server，可用 TERMDOCK_SCRCPY_SERVER 指定路径。',
    SCRCPY_VERSION_UNKNOWN: '无法读取 scrcpy 版本，请确认 scrcpy --version 可执行。',
    SCRCPY_CONNECT_TIMEOUT: '设备连接超时，请确认已授权 USB 调试并保持解锁。',
    SCRCPY_UNSUPPORTED_CODEC: '设备返回了不支持的视频编码。',
    INVALID_ADDRESS: '地址格式不正确，应为 ip:port。',
    API_NOT_ALLOWED: '当前设备权限不足：投屏需要全权服务授权。',
  };
  for (const [key, text] of Object.entries(known)) if (code.includes(key)) return text;
  return code;
}

export interface AndroidRecording {
  id: string; serial: string; name: string; size: number; startedAt: number;
  status: 'starting' | 'recording' | 'stopping' | 'ready' | 'error';
  error?: string;
}
export function listAndroidRecordings(serial: string): Promise<{ recordings: AndroidRecording[] }> {
  return requestJson(`/api/android/recordings?serial=${encodeURIComponent(serial)}`);
}
export function startAndroidRecording(serial: string): Promise<AndroidRecording> {
  return requestJson('/api/android/recordings', { method: 'POST', body: JSON.stringify({ serial }) });
}
export function stopAndroidRecording(id: string): Promise<AndroidRecording> {
  return requestJson(`/api/android/recordings/${encodeURIComponent(id)}/stop`, { method: 'POST' });
}
export function saveAndroidRecording(id: string, directory?: string): Promise<{ path: string }> {
  return requestJson(`/api/android/recordings/${encodeURIComponent(id)}/save`, { method: 'POST', body: JSON.stringify({ directory }) });
}
export function discardAndroidRecording(id: string): Promise<{ ok: boolean }> {
  return requestJson(`/api/android/recordings/${encodeURIComponent(id)}`, { method: 'DELETE' });
}
