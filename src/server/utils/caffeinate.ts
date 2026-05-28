import { spawn, type ChildProcess } from 'child_process';
import dns from 'dns';
import fs from 'fs';
import os from 'os';
import path from 'path';

// ── Settings persistence ──────────────────────────────────────────────
const SETTINGS_DIR = path.join(os.homedir(), '.termdock');
const SETTINGS_FILE = path.join(SETTINGS_DIR, 'settings.json');

interface SettingsDoc {
  version: 1;
  preventSleep: boolean;
  updatedAt: number;
}

function loadSettingsFromDisk(): SettingsDoc {
  try {
    if (fs.existsSync(SETTINGS_FILE)) {
      const raw = fs.readFileSync(SETTINGS_FILE, 'utf-8');
      const parsed = JSON.parse(raw);
      return {
        version: 1,
        preventSleep: parsed.preventSleep === true,
        updatedAt: typeof parsed.updatedAt === 'number' ? parsed.updatedAt : Date.now(),
      };
    }
  } catch { /* ignore */ }
  return { version: 1, preventSleep: false, updatedAt: Date.now() };
}

function persistSettings(doc: SettingsDoc): void {
  try {
    if (!fs.existsSync(SETTINGS_DIR)) fs.mkdirSync(SETTINGS_DIR, { recursive: true });
    fs.writeFileSync(SETTINGS_FILE, JSON.stringify(doc, null, 2), 'utf-8');
  } catch { /* best effort */ }
}

// ── Network detection ─────────────────────────────────────────────────
async function checkNetworkConnectivity(): Promise<boolean> {
  // Quick check: any non-loopback IPv4 interface?
  const interfaces = os.networkInterfaces();
  const hasNonLoopback = Object.values(interfaces).some(
    (addrs) => addrs?.some((a) => !a.internal && a.family === 'IPv4'),
  );
  if (!hasNonLoopback) return false;

  // Deeper check: can we resolve DNS?
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);
    await dns.promises.resolve('cloudflare.com');
    clearTimeout(timeout);
    return true;
  } catch {
    return false;
  }
}

// ── Caffeinate manager ────────────────────────────────────────────────
const isMacOS = process.platform === 'darwin';

let settings: SettingsDoc = loadSettingsFromDisk();
let caffeinateProcess: ChildProcess | null = null;
let networkAvailable = false;
let monitorTimer: ReturnType<typeof setInterval> | null = null;
let debounceTimer: ReturnType<typeof setTimeout> | null = null;

function shouldCaffeinate(): boolean {
  return settings.preventSleep && networkAvailable;
}

function spawnCaffeinate(): void {
  if (!isMacOS || caffeinateProcess) return;
  try {
    caffeinateProcess = spawn('caffeinate', ['-i', '-s'], { stdio: 'ignore' });
    caffeinateProcess.on('exit', () => {
      caffeinateProcess = null;
    });
    caffeinateProcess.unref();
  } catch { /* caffeinate not available */ }
}

function killCaffeinate(): void {
  if (!caffeinateProcess) return;
  try {
    caffeinateProcess.kill('SIGTERM');
  } catch { /* already dead */ }
  caffeinateProcess = null;
}

function evaluate(): void {
  if (shouldCaffeinate()) {
    spawnCaffeinate();
  } else {
    killCaffeinate();
  }
}

function onNetworkChanged(available: boolean): void {
  if (available === networkAvailable) return;
  networkAvailable = available;

  // Debounce: wait 5s before acting on network state change
  if (debounceTimer) clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => {
    debounceTimer = null;
    evaluate();
  }, 5000);
}

async function checkNetwork(): Promise<void> {
  const available = await checkNetworkConnectivity();
  onNetworkChanged(available);
}

export const caffeinateManager = {
  setPreventSleep(enabled: boolean): void {
    settings.preventSleep = enabled;
    settings.updatedAt = Date.now();
    persistSettings(settings);
    evaluate();
  },

  getPreventSleep(): boolean {
    return settings.preventSleep;
  },

  isActive(): boolean {
    return caffeinateProcess !== null;
  },

  isNetworkAvailable(): boolean {
    return networkAvailable;
  },

  startNetworkMonitor(): void {
    // If setting is ON, start caffeinate immediately without waiting for
    // the first network check. If there's no network, the async check
    // will detect that and kill caffeinate shortly after.
    if (settings.preventSleep) spawnCaffeinate();
    // Start periodic network monitoring
    void checkNetwork();
    monitorTimer = setInterval(() => void checkNetwork(), 30_000);
  },

  shutdown(): void {
    if (monitorTimer) {
      clearInterval(monitorTimer);
      monitorTimer = null;
    }
    if (debounceTimer) {
      clearTimeout(debounceTimer);
      debounceTimer = null;
    }
    killCaffeinate();
  },
};
