import { execFile, type ExecFileOptions } from 'node:child_process';
import { existsSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile) as unknown as (
  file: string,
  args: readonly string[],
  options: ExecFileOptions & { encoding: 'utf8' },
) => Promise<{ stdout: string; stderr: string }>;

const EXTRA_PATH = ['/usr/local/bin', '/opt/homebrew/bin', '/opt/local/bin', '/usr/bin', '/usr/lib/android-sdk/platform-tools'];

/** adb 与环境变量 PATH 分离：GUI/桌面进程启动的服务常拿不到 shell PATH。 */
export function adbSearchPath(): string {
  const current = process.env.PATH || '';
  const parts = current.split(delimiter).filter(Boolean);
  for (const dir of EXTRA_PATH) if (!parts.includes(dir)) parts.push(dir);
  return parts.join(delimiter);
}

function adbCandidates(): string[] {
  const override = process.env.TERMDOCK_ADB_BIN;
  const candidates: string[] = [];
  if (override) candidates.push(override);
  const names = process.platform === 'win32' ? ['adb.exe', 'adb'] : ['adb'];
  for (const dir of adbSearchPath().split(delimiter)) {
    for (const name of names) candidates.push(join(dir, name));
  }
  return candidates;
}

let resolvedAdb: string | null | undefined;
export function resolveAdbBinary(): string | null {
  if (resolvedAdb !== undefined) return resolvedAdb;
  for (const candidate of adbCandidates()) {
    if (candidate === 'adb') continue;
    if (existsSync(candidate)) { resolvedAdb = candidate; return resolvedAdb; }
  }
  // 交给 PATH 解析，运行失败时再暴露错误。
  resolvedAdb = 'adb';
  return resolvedAdb;
}

export interface AdbRunOptions { serial?: string; timeout?: number; maxBuffer?: number }

export async function runAdb(args: readonly string[], options: AdbRunOptions = {}): Promise<string> {
  const binary = resolveAdbBinary();
  if (!binary) throw new Error('ADB_NOT_FOUND');
  const full = options.serial ? ['-s', options.serial, ...args] : [...args];
  try {
    const { stdout } = await execFileAsync(binary, full, {
      timeout: options.timeout ?? 15_000,
      maxBuffer: options.maxBuffer ?? 8 * 1024 * 1024,
      env: { ...process.env, PATH: adbSearchPath() },
      encoding: 'utf8',
    });
    return stdout;
  } catch (error) {
    const message = error instanceof Error ? error.message : 'ADB_COMMAND_FAILED';
    throw new Error(message.includes('ENOENT') ? 'ADB_NOT_FOUND' : message);
  }
}

export interface AndroidDeviceInfo {
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

function parseDeviceLine(line: string): AndroidDeviceInfo | null {
  const parts = line.trim().split(/\s+/);
  if (parts.length < 2) return null;
  const [serial, state] = parts;
  const info: AndroidDeviceInfo = {
    serial,
    state: state === 'device' || state === 'offline' || state === 'unauthorized' ? state
      : state.startsWith('connect') ? 'connecting' : 'unknown',
    isNetwork: /^\d+\.\d+\.\d+\.\d+:\d+$/.test(serial) || serial.includes(':') === false && serial.includes('.'),
  };
  for (const token of parts.slice(2)) {
    const [key, value] = token.split(':');
    if (value === undefined) continue;
    if (key === 'model') info.model = value.replace(/_/g, ' ');
    else if (key === 'product') info.product = value;
    else if (key === 'device') info.device = value;
    else if (key === 'transport_id') info.transport = value;
  }
  return info;
}

const PROPS = 'ro.product.model|ro.build.version.release|ro.build.version.sdk';

export async function getDeviceProperties(serial: string): Promise<Pick<AndroidDeviceInfo, 'androidVersion' | 'sdk' | 'model'>> {
  try {
    const output = await runAdb(['shell', 'getprop', ...PROPS.split('|').map(prop => prop)], { serial, timeout: 8000 });
    const values = output.split(/\r?\n/).map(line => line.trim());
    const sdk = Number.parseInt(values[2] || '', 10);
    return {
      model: values[0] || undefined,
      androidVersion: values[1] || undefined,
      sdk: Number.isFinite(sdk) ? sdk : undefined,
    };
  } catch {
    return {};
  }
}

export async function listDevices(): Promise<AndroidDeviceInfo[]> {
  const output = await runAdb(['devices', '-l'], { timeout: 10_000 });
  const devices: AndroidDeviceInfo[] = [];
  for (const line of output.split(/\r?\n/)) {
    if (!line.trim() || /^List of devices/.test(line)) continue;
    const info = parseDeviceLine(line);
    if (info) devices.push(info);
  }
  await Promise.all(devices.filter(device => device.state === 'device').map(async device => {
    Object.assign(device, await getDeviceProperties(device.serial));
  }));
  return devices;
}

export async function connectDevice(address: string): Promise<{ serial: string; output: string }> {
  const normalized = normalizeAddress(address);
  if (!normalized) throw new Error('INVALID_ADDRESS');
  const output = await runAdb(['connect', normalized], { timeout: 20_000 });
  if (/unable to connect|failed to connect|cannot connect/i.test(output)) throw new Error(output.trim() || 'ADB_CONNECT_FAILED');
  return { serial: normalized, output: output.trim() };
}

export async function disconnectDevice(address: string): Promise<string> {
  const normalized = normalizeAddress(address);
  if (!normalized) throw new Error('INVALID_ADDRESS');
  return (await runAdb(['disconnect', normalized], { timeout: 10_000 })).trim();
}

/** 接受 `ip:port`、纯 ip（补 5555）、或带 scheme/路径的粘贴内容。 */
export function normalizeAddress(raw: string): string | null {
  let value = raw.trim();
  if (!value) return null;
  const urlMatch = /^[a-z]+:\/\/([^/]+)/i.exec(value);
  if (urlMatch) value = urlMatch[1];
  value = value.replace(/^\/+|\/+$/g, '');
  if (!/^[0-9a-zA-Z_.\-]+(?::\d+)?$/.test(value)) return null;
  if (!value.includes(':') && /^\d+\.\d+\.\d+\.\d+$/.test(value)) value = `${value}:5555`;
  const [host, port] = value.split(':');
  if (port !== undefined && !/^\d{1,5}$/.test(port)) return null;
  if (!host) return null;
  return port === undefined ? `${host}:5555` : `${host}:${port}`;
}
