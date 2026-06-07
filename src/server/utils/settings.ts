import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { LOCAL_ACCESS } from '../config.js';

const SETTINGS_DIR = path.join(os.homedir(), '.termdock');
const SETTINGS_FILE = path.join(SETTINGS_DIR, 'settings.json');

export type LocalAccessNameSource = 'auto' | 'manual';

export interface LocalAccessSettings {
  name: string;
  source: LocalAccessNameSource;
}

export interface SettingsDoc {
  version: 1;
  preventSleep: boolean;
  localAccess: LocalAccessSettings;
  firstRunCompleted: boolean;
  updatedAt: number;
}

function ensureSettingsDir(): void {
  if (!fs.existsSync(SETTINGS_DIR)) {
    fs.mkdirSync(SETTINGS_DIR, { recursive: true });
  }
}

function generateAutoName(): string {
  const alphabet = LOCAL_ACCESS.generatedNameAlphabet;
  const bytes = crypto.randomBytes(LOCAL_ACCESS.generatedNameLength);
  let value = '';
  for (const byte of bytes) {
    value += alphabet[byte % alphabet.length];
  }
  return value;
}

function normalizeSource(value: unknown): LocalAccessNameSource {
  return value === 'manual' ? 'manual' : 'auto';
}

export function normalizeLocalAccessName(input: unknown): string | null {
  if (typeof input !== 'string') return null;
  const normalized = input.trim().toLowerCase();
  if (normalized.length === 0) return null;
  // DNS label: 1..63 chars, alnum at both ends, hyphen allowed inside.
  if (normalized.length > 63) return null;
  if (!/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(normalized)) return null;
  return normalized;
}

export function createAutoLocalAccessName(): string {
  return generateAutoName();
}

function normalizeLocalAccessSettings(value: unknown): LocalAccessSettings {
  const raw = value && typeof value === 'object'
    ? value as { name?: unknown; shortName?: unknown; source?: unknown }
    : {};
  const source = normalizeSource(raw.source);
  const normalizedName = normalizeLocalAccessName(raw.name ?? raw.shortName);
  return {
    name: normalizedName ?? generateAutoName(),
    source: normalizedName ? source : 'auto',
  };
}

function normalizeSettings(value: unknown): SettingsDoc {
  const raw = value && typeof value === 'object'
    ? value as { preventSleep?: unknown; localAccess?: unknown; updatedAt?: unknown }
    : {};
  return {
    version: 1,
    preventSleep: raw.preventSleep === true,
    localAccess: normalizeLocalAccessSettings(raw.localAccess),
    firstRunCompleted: (raw as { firstRunCompleted?: unknown }).firstRunCompleted === true,
    updatedAt: typeof raw.updatedAt === 'number' ? raw.updatedAt : Date.now(),
  };
}

export function loadSettings(): SettingsDoc {
  try {
    if (fs.existsSync(SETTINGS_FILE)) {
      const raw = fs.readFileSync(SETTINGS_FILE, 'utf-8');
      const doc = normalizeSettings(JSON.parse(raw));
      // Persist migrated defaults (for example the first generated local-access name)
      // so the advertised hostname stays stable across restarts.
      saveSettings(doc);
      return doc;
    }
  } catch { /* ignore malformed settings */ }
  const initial = normalizeSettings(null);
  try { saveSettings(initial); } catch { /* best effort */ }
  return initial;
}

export function saveSettings(next: SettingsDoc): void {
  ensureSettingsDir();
  fs.writeFileSync(SETTINGS_FILE, JSON.stringify(next, null, 2), 'utf-8');
}

export function updateSettings(mutator: (current: SettingsDoc) => SettingsDoc | void): SettingsDoc {
  const current = loadSettings();
  const next = mutator(current) ?? current;
  next.updatedAt = Date.now();
  saveSettings(next);
  return next;
}

export function getPreventSleepSetting(): boolean {
  return loadSettings().preventSleep;
}

export function setPreventSleepSetting(enabled: boolean): SettingsDoc {
  return updateSettings((settings) => {
    settings.preventSleep = enabled;
  });
}

export function getLocalAccessSetting(): LocalAccessSettings {
  return loadSettings().localAccess;
}

export function setLocalAccessSetting(next: LocalAccessSettings): SettingsDoc {
  return updateSettings((settings) => {
    settings.localAccess = next;
  });
}

export function resetLocalAccessSetting(): SettingsDoc {
  return updateSettings((settings) => {
    settings.localAccess = { name: generateAutoName(), source: 'auto' };
  });
}

export function markFirstRunCompleted(): SettingsDoc {
  return updateSettings((settings) => {
    settings.firstRunCompleted = true;
  });
}

export function isFirstRunCompleted(): boolean {
  return loadSettings().firstRunCompleted;
}
