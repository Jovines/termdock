import { spawn, type ChildProcess } from 'child_process';
import dns from 'dns';
import os from 'os';
import { getPreventSleepSetting, setPreventSleepSetting } from './settings.js';

// ── Network detection ─────────────────────────────────────────────────
async function checkNetworkConnectivity(): Promise<boolean> {
  // Quick check: any non-loopback IPv4 interface?
  const interfaces = os.networkInterfaces();
  const hasNonLoopback = Object.values(interfaces).some(
    (addrs) => addrs?.some((a) => !a.internal && a.family === 'IPv4'),
  );
  if (!hasNonLoopback) return false;

  // Deeper check: can we resolve DNS?
  let timeout: ReturnType<typeof setTimeout> | null = null;
  try {
    await Promise.race([
      dns.promises.resolve('cloudflare.com'),
      new Promise<never>((_, reject) => {
        timeout = setTimeout(() => reject(new Error('DNS resolve timed out')), 5000);
      }),
    ]);
    return true;
  } catch {
    return false;
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

// ── Caffeinate manager ────────────────────────────────────────────────
const isMacOS = process.platform === 'darwin';

let preventSleep = getPreventSleepSetting();
let caffeinateProcess: ChildProcess | null = null;
let networkAvailable = false;
let monitorTimer: ReturnType<typeof setInterval> | null = null;
let debounceTimer: ReturnType<typeof setTimeout> | null = null;

function shouldCaffeinate(): boolean {
  return preventSleep && networkAvailable;
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
    preventSleep = enabled;
    setPreventSleepSetting(enabled);
    evaluate();
  },

  getPreventSleep(): boolean {
    return preventSleep;
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
    if (preventSleep) spawnCaffeinate();
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
