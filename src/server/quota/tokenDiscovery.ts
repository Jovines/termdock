/**
 * Token discovery — reads auth tokens from agent configuration files.
 *
 * Termdock's hook installers already know where each agent stores its config.
 * This module extracts OAuth tokens / API keys so the QuotaManager can call
 * provider usage APIs without asking the user to re-enter credentials.
 */

import fs from 'fs';
import path from 'path';
import { homedir } from 'os';

const HOME = homedir();

/** A discovered auth token with its source for diagnostics. */
export interface DiscoveredToken {
  token: string;
  source: string;
  /** Email or account ID when the source carries it. */
  accountId?: string;
  email?: string;
}

// ── Claude / Anthropic ──────────────────────────────────────────────

/** Read ~/.local/share/opencode/auth.json for Anthropic OAuth tokens. */
function discoverFromOpenCodeAuth(): DiscoveredToken[] {
  const results: DiscoveredToken[] = [];
  const authPath = path.join(HOME, '.local/share/opencode/auth.json');
  try {
    const raw = fs.readFileSync(authPath, 'utf-8');
    const auth = JSON.parse(raw);
    const oauths = Array.isArray(auth) ? auth : ('oauth' in auth ? auth.oauth : [auth]);
    const entries = Array.isArray(oauths) ? oauths : [oauths];
    for (const entry of entries) {
      if (entry.type === 'anthropic' && entry.access) {
        results.push({
          token: entry.access,
          source: 'opencode auth.json',
          accountId: entry.accountId || entry.accountLabel || undefined,
        });
      }
    }
  } catch {
    // File missing or unreadable — no Anthropic tokens from this source.
  }
  return results;
}

/** Read ~/.claude/settings.json for stored credentials. */
function discoverFromClaudeSettings(): DiscoveredToken[] {
  const results: DiscoveredToken[] = [];
  const settingsPath = path.join(HOME, '.claude/settings.json');
  try {
    const raw = fs.readFileSync(settingsPath, 'utf-8');
    const settings = JSON.parse(raw);
    // Claude Code stores OAuth credentials in various shapes.
    // The most reliable source is the oauth account info.
    const oauth = settings?.oauthAccount;
    if (oauth?.accessToken) {
      results.push({
        token: oauth.accessToken,
        source: 'claude settings.json',
        email: oauth.email || undefined,
        accountId: oauth.accountUuid || undefined,
      });
    }
  } catch {
    // Not found or unreadable.
  }
  return results;
}

export function discoverClaudeTokens(): DiscoveredToken[] {
  const fromOpenCode = discoverFromOpenCodeAuth().filter(
    (t) => t.source === 'opencode auth.json',
  );
  // OpenCode auth.json already covers Anthropic — avoid duplicates.
  if (fromOpenCode.length > 0) {
    // Merge with claude settings for email enrichment
    const fromClaude = discoverFromClaudeSettings();
    for (const t of fromOpenCode) {
      const match = fromClaude.find(
        (c) => c.email && c.token !== t.token,
      );
      if (match && !t.email) {
        t.email = match.email;
        t.accountId = match.accountId;
      }
    }
    return fromOpenCode;
  }
  return discoverFromClaudeSettings();
}

// ── Codex / OpenAI ───────────────────────────────────────────────────

function discoverCodexFromOpenCodeAuth(): DiscoveredToken[] {
  const results: DiscoveredToken[] = [];
  const authPath = path.join(HOME, '.local/share/opencode/auth.json');
  try {
    const raw = fs.readFileSync(authPath, 'utf-8');
    const auth = JSON.parse(raw);
    const oauths = Array.isArray(auth) ? auth : ('oauth' in auth ? auth.oauth : [auth]);
    const entries = Array.isArray(oauths) ? oauths : [oauths];
    for (const entry of entries) {
      if ((entry.type === 'openai' || entry.type === 'chatgpt' || entry.type === 'codex') && entry.access) {
        results.push({
          token: entry.access,
          source: 'opencode auth.json',
          accountId: entry.accountId || undefined,
        });
      }
    }
  } catch {
    // Not found.
  }
  return results;
}

/** Read ~/.codex/auth.json for Codex CLI native OAuth tokens. */
function discoverCodexFromCodexAuth(): DiscoveredToken[] {
  const results: DiscoveredToken[] = [];
  const authPath = path.join(HOME, '.codex', 'auth.json');
  try {
    const raw = fs.readFileSync(authPath, 'utf-8');
    const auth = JSON.parse(raw);
    const tokens = auth?.tokens;
    if (tokens?.access_token) {
      results.push({
        token: tokens.access_token,
        source: 'codex auth.json',
        accountId: tokens.account_id || undefined,
      });
    }
  } catch {
    // Not found.
  }
  return results;
}

function discoverCodexFromEnv(): DiscoveredToken[] {
  const results: DiscoveredToken[] = [];
  const envVars = ['OPENAI_API_KEY', 'CODEX_API_KEY', 'CHATGPT_TOKEN'];
  for (const v of envVars) {
    const val = process.env[v];
    if (val && val.trim()) {
      results.push({ token: val.trim(), source: `env:${v}` });
    }
  }
  return results;
}

export function discoverCodexTokens(): DiscoveredToken[] {
  // Priority: Codex CLI auth > OpenCode auth > env
  const fromCodex = discoverCodexFromCodexAuth();
  if (fromCodex.length > 0) return fromCodex;
  const fromOpenCode = discoverCodexFromOpenCodeAuth();
  if (fromOpenCode.length > 0) return fromOpenCode;
  return discoverCodexFromEnv();
}

// ── Kimi ─────────────────────────────────────────────────────────────

/** Kimi Code CLI stores OAuth device-code credentials here (`kimi login`). */
function discoverKimiFromCredentials(): DiscoveredToken[] {
  const credPath = path.join(HOME, '.kimi-code', 'credentials', 'kimi-code.json');
  try {
    const raw = fs.readFileSync(credPath, 'utf-8');
    const cred = JSON.parse(raw);
    if (typeof cred.access_token !== 'string' || !cred.access_token.trim()) {
      return [];
    }
    // expires_at: epoch seconds (or ms on some versions); expired → skip so
    // the env/opencode fallbacks still get a chance.
    const exp = Number(cred.expires_at);
    if (Number.isFinite(exp) && exp > 0) {
      const expMs = exp > 1e12 ? exp : exp * 1000;
      if (Date.now() >= expMs) return [];
    }
    return [{ token: cred.access_token.trim(), source: 'kimi-code credentials' }];
  } catch {
    return [];
  }
}

export function discoverKimiTokens(): DiscoveredToken[] {
  const results: DiscoveredToken[] = [];

  // Priority: kimi-code OAuth credentials > env > legacy config > OpenCode auth
  results.push(...discoverKimiFromCredentials());

  // Check KIMI_API_KEY env
  const envKey = process.env.KIMI_API_KEY;
  if (envKey?.trim()) {
    results.push({ token: envKey.trim(), source: 'env:KIMI_API_KEY' });
  }

  // Check ~/.kimi-code config
  const configPath = path.join(HOME, '.kimi-code', 'config.json');
  try {
    const raw = fs.readFileSync(configPath, 'utf-8');
    const cfg = JSON.parse(raw);
    if (cfg.apiKey) {
      results.push({ token: cfg.apiKey, source: 'kimi-code config.json' });
    }
  } catch {
    // Not found.
  }

  // Check OpenCode auth.json for kimi type
  const authPath = path.join(HOME, '.local/share/opencode/auth.json');
  try {
    const raw = fs.readFileSync(authPath, 'utf-8');
    const auth = JSON.parse(raw);
    const entries = Array.isArray(auth) ? auth : [auth];
    for (const entry of entries) {
      if (entry.type === 'kimi' && entry.access) {
        results.push({ token: entry.access, source: 'opencode auth.json' });
      }
    }
  } catch {
    // Not found.
  }

  return results;
}

// ── GitHub Copilot ───────────────────────────────────────────────────

export function discoverCopilotTokens(): DiscoveredToken[] {
  const results: DiscoveredToken[] = [];

  // OpenCode auth.json
  const authPath = path.join(HOME, '.local/share/opencode/auth.json');
  try {
    const raw = fs.readFileSync(authPath, 'utf-8');
    const auth = JSON.parse(raw);
    const entries = Array.isArray(auth) ? auth : [auth];
    for (const entry of entries) {
      if ((entry.type === 'github' || entry.type === 'copilot') && entry.access) {
        results.push({
          token: entry.access,
          source: 'opencode auth.json',
          accountId: entry.accountId || entry.accountLabel || undefined,
        });
      }
    }
  } catch {
    // Not found.
  }

  // Copilot CLI config
  const cliConfigPath = path.join(HOME, '.copilot', 'config.json');
  try {
    const raw = fs.readFileSync(cliConfigPath, 'utf-8');
    const cfg = JSON.parse(raw);
    if (cfg.token) {
      results.push({ token: cfg.token, source: 'copilot config.json' });
    }
  } catch {
    // Not found.
  }

  // GH_TOKEN env
  const ghToken = process.env.GH_TOKEN || process.env.GITHUB_TOKEN;
  if (ghToken?.trim()) {
    results.push({ token: ghToken.trim(), source: 'env:GITHUB_TOKEN' });
  }

  return results;
}

// ── Gemini ────────────────────────────────────────────────────────────

export function discoverGeminiTokens(): DiscoveredToken[] {
  const results: DiscoveredToken[] = [];
  const envKey = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY;
  if (envKey?.trim()) {
    results.push({ token: envKey.trim(), source: `env:GEMINI_API_KEY` });
  }
  return results;
}

// ── Grok ──────────────────────────────────────────────────────────────

export function discoverGrokTokens(): DiscoveredToken[] {
  const results: DiscoveredToken[] = [];
  const envKey = process.env.GROK_API_KEY || process.env.XAI_API_KEY;
  if (envKey?.trim()) {
    results.push({ token: envKey.trim(), source: `env:GROK_API_KEY` });
  }
  return results;
}
