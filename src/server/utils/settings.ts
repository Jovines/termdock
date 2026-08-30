import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { LOCAL_ACCESS } from '../config.js';

const SETTINGS_DIR = path.join(os.homedir(), '.termdock');
const SETTINGS_FILE = path.join(SETTINGS_DIR, 'settings.json');
const SETTINGS_BACKUP_FILE = `${SETTINGS_FILE}.bak`;

export type LocalAccessNameSource = 'auto' | 'manual';

export interface LocalAccessSettings {
  name: string;
  source: LocalAccessNameSource;
}

export interface SettingsDoc {
  [key: string]: unknown;
  version: 1;
  preventSleep: boolean;
  localAccess: LocalAccessSettings;
  firstRunCompleted: boolean;
  /** 'zh' | 'en' — persisted server-side so all connected clients share one choice. */
  locale: string;
  /** 上下文草稿坞手动拖出的输入框高度（px），手机/桌面分别存。 */
  contextDraftHeight: { mobile: number | null; desktop: number | null };
  /** Agent slugs whose completed turns may automatically update the Termdock tab title. */
  autoRenameAgents: string[];
  /** `auto` follows the active session when its CLI is supported. */
  autoRenameNamer: string;
  /** Per-CLI model choices. Missing means use that CLI's current default. */
  autoRenameModels: Record<string, string>;
  /** Minimum delay before an existing automatic title may be reconsidered. */
  autoRenameIntervalMinutes: number;
  /** Optional user preferences appended to Termdock's built-in title prompt. */
  autoRenamePromptPreference: string;
  /** Total characters of raw prompt-submit payloads retained for title generation. */
  autoRenamePromptPayloadChars: number;
  /** Agent launched by default from the left-sidebar new-session action. */
  newSessionAgentSlug: string | null;
  /** Show the floating shortcut used to cycle through running agent sessions. */
  runningSessionButtonEnabled: boolean;
  updatedAt: number;
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

function normalizeContextDraftHeight(value: unknown): { mobile: number | null; desktop: number | null } {
  const raw = value && typeof value === 'object'
    ? value as { mobile?: unknown; desktop?: unknown }
    : {};
  const normalizeOne = (input: unknown): number | null =>
    typeof input === 'number' && Number.isFinite(input) && input >= 56 && input <= 4000
      ? Math.round(input)
      : null;
  return { mobile: normalizeOne(raw.mobile), desktop: normalizeOne(raw.desktop) };
}

export function normalizeNewSessionAgentSlug(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const slug = value.trim().toLowerCase();
  return /^[a-z][a-z0-9-]{0,39}$/.test(slug) ? slug : null;
}

function normalizeSettings(value: unknown): SettingsDoc {
  const raw = value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
  const autoRenameAgents = Array.isArray(raw.autoRenameAgents)
    ? [...new Set(raw.autoRenameAgents
      .filter((slug): slug is string => typeof slug === 'string')
      .map((slug) => slug.trim().toLowerCase())
      .filter((slug) => /^[a-z0-9][a-z0-9-]{0,63}$/.test(slug)))]
    : [];
  return {
    // Keep fields introduced by a newer Termdock binary. During a rolling
    // restart an older process must not erase settings it does not know yet.
    ...raw,
    version: 1,
    preventSleep: raw.preventSleep === true,
    localAccess: normalizeLocalAccessSettings(raw.localAccess),
    firstRunCompleted: (raw as { firstRunCompleted?: unknown }).firstRunCompleted === true,
    locale: typeof (raw as { locale?: unknown }).locale === 'string' && (raw as { locale: string }).locale === 'zh' ? 'zh' : 'en',
    contextDraftHeight: normalizeContextDraftHeight(raw.contextDraftHeight),
    autoRenameAgents,
    autoRenameNamer: typeof raw.autoRenameNamer === 'string' && /^(?:auto|[a-z][a-z0-9-]{0,39})$/.test(raw.autoRenameNamer)
      ? raw.autoRenameNamer : 'auto',
    autoRenameModels: raw.autoRenameModels && typeof raw.autoRenameModels === 'object'
      ? Object.fromEntries(Object.entries(raw.autoRenameModels as Record<string, unknown>)
        .filter((entry): entry is [string, string] => (
          /^[a-z][a-z0-9-]{0,39}$/.test(entry[0])
          && typeof entry[1] === 'string'
          && /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,119}$/.test(entry[1])
        )))
      : {},
    autoRenameIntervalMinutes: typeof raw.autoRenameIntervalMinutes === 'number'
      && Number.isInteger(raw.autoRenameIntervalMinutes)
      && raw.autoRenameIntervalMinutes >= 5
      && raw.autoRenameIntervalMinutes <= 1440
      ? raw.autoRenameIntervalMinutes
      : 10,
    autoRenamePromptPreference: typeof raw.autoRenamePromptPreference === 'string'
      ? raw.autoRenamePromptPreference.trim().slice(0, 2000)
      : '',
    autoRenamePromptPayloadChars: typeof raw.autoRenamePromptPayloadChars === 'number'
      && Number.isInteger(raw.autoRenamePromptPayloadChars)
      && raw.autoRenamePromptPayloadChars >= 1000
      && raw.autoRenamePromptPayloadChars <= 64_000
      ? raw.autoRenamePromptPayloadChars
      : 12_000,
    newSessionAgentSlug: normalizeNewSessionAgentSlug(raw.newSessionAgentSlug),
    runningSessionButtonEnabled: raw.runningSessionButtonEnabled === true,
    updatedAt: typeof raw.updatedAt === 'number' ? raw.updatedAt : Date.now(),
  };
}

function serializeSettings(next: SettingsDoc): string {
  return `${JSON.stringify(next, null, 2)}\n`;
}

function tempFileFor(target: string): string {
  return path.join(
    path.dirname(target),
    `.${path.basename(target)}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`,
  );
}

function atomicWriteFileSync(target: string, content: string): void {
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const temp = tempFileFor(target);
  try {
    fs.writeFileSync(temp, content, 'utf-8');
    fs.renameSync(temp, target);
  } finally {
    try { fs.unlinkSync(temp); } catch { /* renamed or best-effort cleanup */ }
  }
}

async function atomicWriteFile(target: string, content: string): Promise<void> {
  await fs.promises.mkdir(path.dirname(target), { recursive: true });
  const temp = tempFileFor(target);
  try {
    await fs.promises.writeFile(temp, content, 'utf-8');
    await fs.promises.rename(temp, target);
  } finally {
    try { await fs.promises.unlink(temp); } catch { /* renamed or best-effort cleanup */ }
  }
}

function isMissingFile(error: unknown): boolean {
  return (error as NodeJS.ErrnoException)?.code === 'ENOENT';
}

function validJsonOrNull(raw: string): unknown | null {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

export function saveSettingsFile(
  next: SettingsDoc,
  settingsFile: string,
  backupFile = `${settingsFile}.bak`,
  backupCurrent = true,
): void {
  if (backupCurrent) {
    try {
      const current = fs.readFileSync(settingsFile, 'utf-8');
      if (validJsonOrNull(current) !== null) atomicWriteFileSync(backupFile, current);
    } catch (error) {
      if (!isMissingFile(error)) throw error;
    }
  }
  atomicWriteFileSync(settingsFile, serializeSettings(next));
}

export async function saveSettingsFileAsync(
  next: SettingsDoc,
  settingsFile: string,
  backupFile = `${settingsFile}.bak`,
  backupCurrent = true,
): Promise<void> {
  if (backupCurrent) {
    try {
      const current = await fs.promises.readFile(settingsFile, 'utf-8');
      if (validJsonOrNull(current) !== null) await atomicWriteFile(backupFile, current);
    } catch (error) {
      if (!isMissingFile(error)) throw error;
    }
  }
  await atomicWriteFile(settingsFile, serializeSettings(next));
}

export function loadSettingsFile(
  settingsFile: string,
  backupFile = `${settingsFile}.bak`,
): SettingsDoc {
  let raw: string;
  try {
    raw = fs.readFileSync(settingsFile, 'utf-8');
  } catch (error) {
    if (!isMissingFile(error)) throw error;
    const initial = normalizeSettings(null);
    saveSettingsFile(initial, settingsFile, backupFile, false);
    return initial;
  }

  const parsed = validJsonOrNull(raw);
  if (parsed !== null) {
    const doc = normalizeSettings(parsed);
    // Only persist an actual migration. Ordinary reads must remain read-only.
    if (serializeSettings(doc) !== raw) saveSettingsFile(doc, settingsFile, backupFile);
    return doc;
  }

  try {
    const backupRaw = fs.readFileSync(backupFile, 'utf-8');
    const backupParsed = validJsonOrNull(backupRaw);
    if (backupParsed === null) throw new Error('backup contains invalid JSON');
    const recovered = normalizeSettings(backupParsed);
    saveSettingsFile(recovered, settingsFile, backupFile, false);
    console.warn(`[settings] recovered malformed ${settingsFile} from ${backupFile}`);
    return recovered;
  } catch (backupError) {
    throw new Error(`Refusing to overwrite malformed settings file ${settingsFile}; no valid backup is available`, {
      cause: backupError,
    });
  }
}

export async function loadSettingsFileAsync(
  settingsFile: string,
  backupFile = `${settingsFile}.bak`,
): Promise<SettingsDoc> {
  let raw: string;
  try {
    raw = await fs.promises.readFile(settingsFile, 'utf-8');
  } catch (error) {
    if (!isMissingFile(error)) throw error;
    const initial = normalizeSettings(null);
    await saveSettingsFileAsync(initial, settingsFile, backupFile, false);
    return initial;
  }

  const parsed = validJsonOrNull(raw);
  if (parsed !== null) {
    const doc = normalizeSettings(parsed);
    if (serializeSettings(doc) !== raw) await saveSettingsFileAsync(doc, settingsFile, backupFile);
    return doc;
  }

  try {
    const backupRaw = await fs.promises.readFile(backupFile, 'utf-8');
    const backupParsed = validJsonOrNull(backupRaw);
    if (backupParsed === null) throw new Error('backup contains invalid JSON');
    const recovered = normalizeSettings(backupParsed);
    await saveSettingsFileAsync(recovered, settingsFile, backupFile, false);
    console.warn(`[settings] recovered malformed ${settingsFile} from ${backupFile}`);
    return recovered;
  } catch (backupError) {
    throw new Error(`Refusing to overwrite malformed settings file ${settingsFile}; no valid backup is available`, {
      cause: backupError,
    });
  }
}

export function loadSettings(): SettingsDoc {
  return loadSettingsFile(SETTINGS_FILE, SETTINGS_BACKUP_FILE);
}

export async function loadSettingsAsync(): Promise<SettingsDoc> {
  return loadSettingsFileAsync(SETTINGS_FILE, SETTINGS_BACKUP_FILE);
}

export function saveSettings(next: SettingsDoc): void {
  saveSettingsFile(next, SETTINGS_FILE, SETTINGS_BACKUP_FILE);
}

export async function saveSettingsAsync(next: SettingsDoc): Promise<void> {
  await saveSettingsFileAsync(next, SETTINGS_FILE, SETTINGS_BACKUP_FILE);
}

export function updateSettings(mutator: (current: SettingsDoc) => SettingsDoc | void): SettingsDoc {
  const current = loadSettings();
  const next = mutator(current) ?? current;
  next.updatedAt = Date.now();
  saveSettings(next);
  return next;
}

export async function updateSettingsAsync(mutator: (current: SettingsDoc) => SettingsDoc | void): Promise<SettingsDoc> {
  const current = await loadSettingsAsync();
  const next = mutator(current) ?? current;
  next.updatedAt = Date.now();
  await saveSettingsAsync(next);
  return next;
}

export function getPreventSleepSetting(): boolean {
  return loadSettings().preventSleep;
}

export async function getPreventSleepSettingAsync(): Promise<boolean> {
  return (await loadSettingsAsync()).preventSleep;
}

export function setPreventSleepSetting(enabled: boolean): SettingsDoc {
  return updateSettings((settings) => {
    settings.preventSleep = enabled;
  });
}

export async function setPreventSleepSettingAsync(enabled: boolean): Promise<SettingsDoc> {
  return updateSettingsAsync((settings) => {
    settings.preventSleep = enabled;
  });
}

export function getLocalAccessSetting(): LocalAccessSettings {
  return loadSettings().localAccess;
}

export async function getLocalAccessSettingAsync(): Promise<LocalAccessSettings> {
  return (await loadSettingsAsync()).localAccess;
}

export function setLocalAccessSetting(next: LocalAccessSettings): SettingsDoc {
  return updateSettings((settings) => {
    settings.localAccess = next;
  });
}

export async function setLocalAccessSettingAsync(next: LocalAccessSettings): Promise<SettingsDoc> {
  return updateSettingsAsync((settings) => {
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

export function getLocaleSetting(): string {
  return loadSettings().locale ?? 'en';
}

export function setLocaleSetting(locale: string): SettingsDoc {
  return updateSettings((settings) => {
    settings.locale = locale;
  });
}

export function getContextDraftHeightSetting(): { mobile: number | null; desktop: number | null } {
  return loadSettings().contextDraftHeight;
}

export function setContextDraftHeightSetting(device: 'mobile' | 'desktop', height: number | null): SettingsDoc {
  return updateSettings((settings) => {
    settings.contextDraftHeight[device] = height;
  });
}

export function getAutoRenameAgentsSetting(): string[] {
  return loadSettings().autoRenameAgents.slice();
}

export function setAutoRenameAgentsSetting(slugs: string[]): SettingsDoc {
  return updateSettings((settings) => {
    settings.autoRenameAgents = [...new Set(slugs
      .map((slug) => slug.trim().toLowerCase())
      .filter((slug) => /^[a-z0-9][a-z0-9-]{0,63}$/.test(slug)))];
  });
}

export function getAutoRenameNamerSetting(): string {
  return loadSettings().autoRenameNamer;
}

export function setAutoRenameNamerSetting(namer: string): SettingsDoc {
  return updateSettings((settings) => {
    settings.autoRenameNamer = namer;
  });
}

export function getAutoRenameModelsSetting(): Record<string, string> {
  return { ...loadSettings().autoRenameModels };
}

export function getAutoRenameIntervalMinutesSetting(): number {
  return loadSettings().autoRenameIntervalMinutes;
}

export function setAutoRenameIntervalMinutesSetting(minutes: number): SettingsDoc {
  return updateSettings((settings) => {
    settings.autoRenameIntervalMinutes = Math.max(5, Math.min(1440, Math.round(minutes)));
  });
}

export function getAutoRenamePromptPreferenceSetting(): string {
  return loadSettings().autoRenamePromptPreference;
}

export function setAutoRenamePromptPreferenceSetting(preference: string): SettingsDoc {
  return updateSettings((settings) => {
    settings.autoRenamePromptPreference = preference.trim().slice(0, 2000);
  });
}

export function getAutoRenamePromptPayloadCharsSetting(): number {
  return loadSettings().autoRenamePromptPayloadChars;
}

export function setAutoRenamePromptPayloadCharsSetting(chars: number): SettingsDoc {
  return updateSettings((settings) => {
    settings.autoRenamePromptPayloadChars = Math.max(1000, Math.min(64_000, Math.round(chars)));
  });
}

export function setAutoRenameModelsSetting(models: Record<string, string>): SettingsDoc {
  return updateSettings((settings) => {
    settings.autoRenameModels = Object.fromEntries(Object.entries(models)
      .filter(([slug, model]) => (
        /^[a-z][a-z0-9-]{0,39}$/.test(slug)
        && /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,119}$/.test(model)
      )));
  });
}

export function getNewSessionAgentSlugSetting(): string | null {
  return loadSettings().newSessionAgentSlug;
}

export function setNewSessionAgentSlugSetting(slug: string | null): SettingsDoc {
  return updateSettings((settings) => {
    settings.newSessionAgentSlug = normalizeNewSessionAgentSlug(slug);
  });
}

export function getRunningSessionButtonEnabledSetting(): boolean {
  return loadSettings().runningSessionButtonEnabled;
}

export function setRunningSessionButtonEnabledSetting(enabled: boolean): SettingsDoc {
  return updateSettings((settings) => {
    settings.runningSessionButtonEnabled = enabled;
  });
}
