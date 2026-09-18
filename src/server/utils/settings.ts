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

export interface PinnedExplorerEntry {
  path: string;
  kind: 'file' | 'directory';
}

export type PinnedExplorerRoots = Record<string, PinnedExplorerEntry[]>;

export interface CollaborationPanelState {
  groups?: Record<string, CollaborationPanelState>;
  layouts?: Record<string, unknown>;
  mode?: 'floating' | 'docked';
  size?: { width: number; height: number };
  dock?: { sessionId: string; side: 'left' | 'right' | 'top' | 'bottom' };
  floatingGroupId?: string | null;
  position?: { x: number; y: number };
  drafts?: Record<string, { content: string; targets: string[] | null }>;
}

export interface AndroidQualitySettings { id: 'low' | 'medium' | 'high' | 'custom'; maxSize: number; bitRate: number; maxFps: number }

export interface AndroidSavedPreset { id: string; name: string; maxSize: number; bitRate: number; maxFps: number }

/** 投屏面板偏好，存服务端后所有客户端/浏览器共享同一选择。 */
export interface AndroidPanelSettings {
  /** 是否在右侧栏显示「设备」Tab。 */
  enabled: boolean;
  /** 当前生效的画质（预设或自定义）。 */
  quality: AndroidQualitySettings | null;
  /** 当前选中的用户保存预设（无则为 null）。 */
  activePresetId: string | null;
  /** 用户保存的画质预设。 */
  presets: AndroidSavedPreset[];
  /** 上次 dock 到终端分屏的位置，刷新后据此恢复。 */
  docked: { sessionId: string; side: 'left' | 'right' | 'top' | 'bottom' } | null;
  deviceSerial: string | null;
}

export interface SettingsDoc {
  collaborationPanels: Record<string, CollaborationPanelState>;
  androidPanel: AndroidPanelSettings;
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
  /** Last cc-switch provider picked per agent slug; absent slug means "follow the global config". */
  ccSwitchProviders: Record<string, string>;
  /** Show the floating shortcut used to cycle through running agent sessions. */
  runningSessionButtonEnabled: boolean;
  /** Show the yellow floating shortcut for sessions awaiting attention. */
  attentionButtonEnabled: boolean;
  collaborationFloatingGroupId: string | null;
  serviceSwitcherExpanded: boolean;
  /** Explorer folders whose direct children are sorted by modification time. */
  fileSortModes: Record<string, 'modified'>;
  /**
   * Workspace roots the user marked as holding nested sub-repos. Absent means
   * single-repo, which skips the (expensive) nested discovery walk entirely.
   */
  nestedGitScanRoots: Record<string, true>;
  /** Explorer entries pinned per project root and shared by every connected client. */
  pinnedExplorerRoots: PinnedExplorerRoots;
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

export function normalizeCcSwitchProviders(value: unknown): Record<string, string> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return Object.fromEntries(Object.entries(value as Record<string, unknown>)
    .filter(([slug, providerId]) => (
      /^[a-z][a-z0-9-]{0,39}$/.test(slug)
      && typeof providerId === 'string'
      && /^[A-Za-z0-9_-]{1,128}$/.test(providerId)
    ))
    .slice(-100)) as Record<string, string>;
}

export function normalizeFileSortModes(value: unknown): Record<string, 'modified'> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return Object.fromEntries(Object.entries(value as Record<string, unknown>)
    .filter(([filePath, mode]) => (
      mode === 'modified'
      && filePath.length > 0
      && filePath.length <= 4096
      && (filePath.startsWith('/') || /^[a-zA-Z]:[\\/]/.test(filePath))
    ))
    .slice(-500)) as Record<string, 'modified'>;
}

function isAbsoluteFilePath(value: string): boolean {
  return value.length > 0
    && value.length <= 4096
    && (value.startsWith('/') || /^[a-zA-Z]:[\\/]/.test(value));
}

export function normalizeNestedGitScanRoots(value: unknown): Record<string, true> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return Object.fromEntries(Object.entries(value as Record<string, unknown>)
    .filter(([rootPath, enabled]) => enabled === true && isAbsoluteFilePath(rootPath))
    .slice(-500)) as Record<string, true>;
}

function normalizeAndroidQuality(value: unknown): AndroidQualitySettings | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const item = value as Record<string, unknown>;
  if (item.id !== 'low' && item.id !== 'medium' && item.id !== 'high' && item.id !== 'custom') return null;
  const maxSize = typeof item.maxSize === 'number' ? Math.max(360, Math.min(2160, Math.round(item.maxSize))) : 1080;
  const bitRate = typeof item.bitRate === 'number' ? Math.max(300_000, Math.min(30_000_000, Math.round(item.bitRate))) : 4_000_000;
  const maxFps = typeof item.maxFps === 'number' ? Math.max(0, Math.min(60, Math.round(item.maxFps))) : 30;
  return { id: item.id, maxSize, bitRate, maxFps };
}

export function normalizeAndroidPanel(value: unknown): AndroidPanelSettings {
  const raw = value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
  // 默认关闭：设备 Tab 需用户在右侧栏「更多」菜单里显式开启。
  const enabled = raw.enabled === true;
  const quality = normalizeAndroidQuality(raw.quality);
  const presets: AndroidSavedPreset[] = [];
  if (Array.isArray(raw.presets)) {
    const seen = new Set<string>();
    for (const entry of raw.presets.slice(0, 12)) {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
      const item = entry as Record<string, unknown>;
      if (typeof item.id !== 'string' || !/^[a-z0-9-]{1,40}$/.test(item.id) || seen.has(item.id)) continue;
      const name = typeof item.name === 'string' ? item.name.trim().slice(0, 40) : '';
      if (!name) continue;
      const values = normalizeAndroidQuality({ ...item, id: 'custom' });
      if (!values) continue;
      seen.add(item.id);
      presets.push({ id: item.id, name, maxSize: values.maxSize, bitRate: values.bitRate, maxFps: values.maxFps });
    }
  }
  const activePresetId = typeof raw.activePresetId === 'string' && presets.some(preset => preset.id === raw.activePresetId)
    ? raw.activePresetId
    : null;
  let docked: AndroidPanelSettings['docked'] = null;
  const dockCandidate = raw.docked;
  if (dockCandidate && typeof dockCandidate === 'object' && !Array.isArray(dockCandidate)) {
    const item = dockCandidate as Record<string, unknown>;
    const side = item.side;
    if (typeof item.sessionId === 'string' && /^[0-9a-zA-Z_.:\-]{1,128}$/.test(item.sessionId)
      && (side === 'left' || side === 'right' || side === 'top' || side === 'bottom')) {
      docked = { sessionId: item.sessionId, side };
    }
  }
  const deviceSerial = typeof raw.deviceSerial === 'string' && /^[0-9a-zA-Z_.:\-]{1,128}$/.test(raw.deviceSerial) ? raw.deviceSerial : null;
  return { enabled, quality, activePresetId, presets, docked, deviceSerial };
}

export function normalizePinnedExplorerRoots(value: unknown): PinnedExplorerRoots {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const normalized: PinnedExplorerRoots = {};
  for (const [rootPath, rawEntries] of Object.entries(value as Record<string, unknown>).slice(-200)) {
    if (!isAbsoluteFilePath(rootPath) || !Array.isArray(rawEntries)) continue;
    const seen = new Set<string>();
    const entries: PinnedExplorerEntry[] = [];
    for (const rawEntry of rawEntries) {
      if (!rawEntry || typeof rawEntry !== 'object' || Array.isArray(rawEntry)) continue;
      const entry = rawEntry as { path?: unknown; kind?: unknown };
      if (typeof entry.path !== 'string'
        || !isAbsoluteFilePath(entry.path)
        || (entry.kind !== 'file' && entry.kind !== 'directory')
        || seen.has(entry.path)) continue;
      seen.add(entry.path);
      entries.push({ path: entry.path, kind: entry.kind });
      if (entries.length >= 12) break;
    }
    if (entries.length > 0) normalized[rootPath] = entries;
  }
  return normalized;
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
    ccSwitchProviders: normalizeCcSwitchProviders(raw.ccSwitchProviders),
    runningSessionButtonEnabled: raw.runningSessionButtonEnabled === true,
    attentionButtonEnabled: raw.attentionButtonEnabled !== false,
    collaborationPanels: normalizeCollaborationPanels(raw.collaborationPanels),
    androidPanel: normalizeAndroidPanel(raw.androidPanel),
    collaborationFloatingGroupId: typeof raw.collaborationFloatingGroupId === 'string' && raw.collaborationFloatingGroupId.trim() ? raw.collaborationFloatingGroupId.trim() : null,
    serviceSwitcherExpanded: raw.serviceSwitcherExpanded === true,
    fileSortModes: normalizeFileSortModes(raw.fileSortModes),
    nestedGitScanRoots: normalizeNestedGitScanRoots(raw.nestedGitScanRoots),
    pinnedExplorerRoots: normalizePinnedExplorerRoots(raw.pinnedExplorerRoots),
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

export function getCcSwitchProvidersSetting(): Record<string, string> {
  return { ...loadSettings().ccSwitchProviders };
}

export function setCcSwitchProviderSetting(slug: string, providerId: string | null): SettingsDoc {
  return updateSettings((settings) => {
    const next = { ...settings.ccSwitchProviders };
    if (providerId === null) delete next[slug];
    else next[slug] = providerId;
    settings.ccSwitchProviders = normalizeCcSwitchProviders(next);
  });
}

export function setNewSessionAgentSlugSetting(slug: string | null): SettingsDoc {
  return updateSettings((settings) => {
    settings.newSessionAgentSlug = normalizeNewSessionAgentSlug(slug);
  });
}

export function getCollaborationFloatingGroupIdSetting(): string | null {
  return loadSettings().collaborationFloatingGroupId;
}

export function setCollaborationFloatingGroupIdSetting(groupId: string | null): SettingsDoc {
  return updateSettings(settings => { settings.collaborationFloatingGroupId = groupId; });
}

export function getServiceSwitcherExpandedSetting(): boolean {
  return loadSettings().serviceSwitcherExpanded;
}

export function setServiceSwitcherExpandedSetting(expanded: boolean): SettingsDoc {
  return updateSettings((settings) => {
    settings.serviceSwitcherExpanded = expanded;
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

export function getAttentionButtonEnabledSetting(): boolean {
  return loadSettings().attentionButtonEnabled;
}

export function setAttentionButtonEnabledSetting(enabled: boolean): SettingsDoc {
  return updateSettings((settings) => {
    settings.attentionButtonEnabled = enabled;
  });
}

export function getFileSortModesSetting(): Record<string, 'modified'> {
  return { ...loadSettings().fileSortModes };
}

export function setFileSortModesSetting(modes: Record<string, unknown>): SettingsDoc {
  return updateSettings((settings) => {
    settings.fileSortModes = normalizeFileSortModes(modes);
  });
}

export function setFileSortModeSetting(filePath: string, mode: 'name' | 'modified'): SettingsDoc {
  return updateSettings((settings) => {
    const next = { ...settings.fileSortModes };
    if (mode === 'modified') next[filePath] = mode;
    else delete next[filePath];
    settings.fileSortModes = normalizeFileSortModes(next);
  });
}

export function getNestedGitScanRootsSetting(): Record<string, true> {
  return { ...loadSettings().nestedGitScanRoots };
}

export function setNestedGitScanRootSetting(rootPath: string, enabled: boolean): SettingsDoc {
  return updateSettings((settings) => {
    const next = { ...settings.nestedGitScanRoots };
    // Only the non-default (opted-in) state is stored, so `{}` means "all single-repo".
    if (enabled) next[rootPath] = true;
    else delete next[rootPath];
    settings.nestedGitScanRoots = normalizeNestedGitScanRoots(next);
  });
}

export function getPinnedExplorerRootsSetting(): PinnedExplorerRoots {
  return loadSettings().pinnedExplorerRoots;
}

export function setPinnedExplorerRootsSetting(roots: unknown): SettingsDoc {
  return updateSettings((settings) => {
    settings.pinnedExplorerRoots = normalizePinnedExplorerRoots(roots);
  });
}

export function setPinnedExplorerRootSetting(
  rootPath: string,
  entryPath: string,
  kind: 'file' | 'directory',
  pinned: boolean,
): SettingsDoc {
  return updateSettings((settings) => {
    const roots = { ...settings.pinnedExplorerRoots };
    const current = roots[rootPath] ?? [];
    if (pinned) {
      if (!current.some((entry) => entry.path === entryPath)) {
        roots[rootPath] = [{ path: entryPath, kind }, ...current].slice(0, 12);
      }
    } else {
      const next = current.filter((entry) => entry.path !== entryPath);
      if (next.length > 0) roots[rootPath] = next;
      else delete roots[rootPath];
    }
    settings.pinnedExplorerRoots = normalizePinnedExplorerRoots(roots);
  });
}

/**
 * Watch the settings file through its parent directory because atomic saves
 * replace the file inode. This lets sibling Termdock server processes sharing
 * the same home directory relay pin changes to their own connected clients.
 */
export function watchPinnedExplorerRootsSetting(
  listener: (roots: PinnedExplorerRoots) => void,
  settingsFile = SETTINGS_FILE,
): () => void {
  const initial = loadSettingsFile(settingsFile);
  let previous = JSON.stringify(initial.pinnedExplorerRoots);
  let timer: NodeJS.Timeout | null = null;
  let closed = false;
  const refresh = (): void => {
    timer = null;
    if (closed) return;
    try {
      const roots = loadSettingsFile(settingsFile).pinnedExplorerRoots;
      const serialized = JSON.stringify(roots);
      if (serialized === previous) return;
      previous = serialized;
      listener(roots);
    } catch (error) {
      console.warn('[settings] failed to refresh pinned explorer roots:', error);
    }
  };
  let watcher: fs.FSWatcher;
  try {
    watcher = fs.watch(path.dirname(settingsFile), (_eventType, filename) => {
      if (filename && filename.toString() !== path.basename(settingsFile)) return;
      if (timer) clearTimeout(timer);
      timer = setTimeout(refresh, 40);
      timer.unref?.();
    });
    watcher.unref();
  } catch (error) {
    console.warn('[settings] failed to watch pinned explorer roots:', error);
    return () => undefined;
  }
  return () => {
    closed = true;
    if (timer) clearTimeout(timer);
    watcher.close();
  };
}

export function normalizeCollaborationPanels(value: unknown, depth = 0): Record<string, CollaborationPanelState> {
  const result: Record<string, CollaborationPanelState> = Object.create(null);
  if (!value || typeof value !== 'object' || Array.isArray(value)) return result;
  for (const [id, raw] of Object.entries(value).slice(-100)) {
    if (!/^[a-zA-Z0-9_-]{1,100}$/.test(id) || !raw || typeof raw !== 'object') continue;
    const state: CollaborationPanelState = {};
    if (depth === 0 && raw.groups) state.groups = normalizeCollaborationPanels(raw.groups, 1);
    if (raw.layouts && typeof raw.layouts === 'object' && !Array.isArray(raw.layouts)) {
      state.layouts = Object.fromEntries(Object.entries(raw.layouts).slice(-100).filter(([, tree]) => JSON.stringify(tree).length < 50000));
    }
    if (raw.mode === 'floating' || raw.mode === 'docked') state.mode = raw.mode;
    if (raw.size && Number.isFinite(raw.size.width) && Number.isFinite(raw.size.height)) state.size = {
      width: Math.max(0.15, Math.min(1, raw.size.width)), height: Math.max(0.15, Math.min(1, raw.size.height)),
    };
    if (raw.dock && typeof raw.dock.sessionId === 'string' && ['left', 'right', 'top', 'bottom'].includes(raw.dock.side)) {
      state.dock = { sessionId: raw.dock.sessionId, side: raw.dock.side };
    }
    if (raw.floatingGroupId === null || typeof raw.floatingGroupId === 'string') state.floatingGroupId = raw.floatingGroupId;
    if (raw.position && Number.isFinite(raw.position.x) && Number.isFinite(raw.position.y)) {
      state.position = { x: Math.max(0, Math.min(1, raw.position.x)), y: Math.max(0, Math.min(1, raw.position.y)) };
    }
    if (raw.drafts && typeof raw.drafts === 'object' && !Array.isArray(raw.drafts)) {
      state.drafts = Object.create(null);
      for (const [groupId, draft] of Object.entries(raw.drafts).slice(-100)) {
        const entry = draft as { content?: unknown; targets?: unknown } | null;
        if (!entry || typeof entry.content !== 'string' || !(entry.targets === null || Array.isArray(entry.targets))) continue;
        state.drafts![groupId] = { content: entry.content, targets: entry.targets === null ? null : [...new Set(entry.targets.filter((id): id is string => typeof id === 'string'))] };
      }
    }
    result[id] = state;
  }
  return result;
}

export function getAndroidPanelSetting(): AndroidPanelSettings { return loadSettings().androidPanel; }

export function setAndroidPanelSetting(patch: Partial<AndroidPanelSettings>): SettingsDoc {
  return updateSettings((settings) => {
    settings.androidPanel = normalizeAndroidPanel({ ...settings.androidPanel, ...patch });
  });
}

export function getCollaborationPanelsSetting() { return loadSettings().collaborationPanels; }
export function setCollaborationPanelSetting(clientId: string, patch: unknown) {
  const normalized = normalizeCollaborationPanels({ [clientId]: patch })[clientId];
  if (!normalized) return;
  return updateSettings(settings => {
    const previous = settings.collaborationPanels[clientId] ?? {};
    settings.collaborationPanels[clientId] = { ...previous, ...normalized,
      groups: { ...previous.groups, ...Object.fromEntries(Object.entries(normalized.groups ?? {}).map(([id, group]) => [id, { ...previous.groups?.[id], ...group }])) },
      drafts: { ...previous.drafts, ...normalized.drafts }, layouts: { ...previous.layouts, ...normalized.layouts } };
  });
}
