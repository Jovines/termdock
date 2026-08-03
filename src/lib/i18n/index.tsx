import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { en } from './en';
import { zh } from './zh';
import { DEFAULT_LOCALE, SUPPORTED_LOCALES, type Locale, type TranslationDictionary } from './types';

const STORAGE_KEY = 'termdock:locale';

const dictionaries: Record<Locale, TranslationDictionary> = {
  en,
  zh,
};

function isLocale(value: unknown): value is Locale {
  return typeof value === 'string' && (SUPPORTED_LOCALES as string[]).includes(value);
}

function detectInitialLocale(): Locale {
  if (typeof window === 'undefined') return DEFAULT_LOCALE;
  try {
    const stored = window.localStorage.getItem(STORAGE_KEY);
    if (isLocale(stored)) return stored;
  } catch {
    // localStorage may be disabled — fall through to browser detection.
  }
  const browser = window.navigator?.language?.toLowerCase() ?? '';
  if (browser.startsWith('zh')) return 'zh';
  return DEFAULT_LOCALE;
}

type Path<T, P extends string = ''> = {
  [K in keyof T & string]: T[K] extends Record<string, unknown>
    ? Path<T[K], `${P}${P extends '' ? '' : '.'}${K}`>
    : `${P}${P extends '' ? '' : '.'}${K}`;
}[keyof T & string];

export type TranslationKey = Path<TranslationDictionary>;

export type InterpolationParams = Record<string, string | number>;

interface I18nContextValue {
  locale: Locale;
  setLocale: (next: Locale) => void;
  /** Resolve a translation key. Functions are called with the params object. */
  t: <K extends TranslationKey>(key: K, params?: InterpolationParams) => string;
  /** Subscribe to re-renders when the locale changes. */
}

const I18nContext = createContext<I18nContextValue | null>(null);

function resolveKey(dictionary: TranslationDictionary, key: string): unknown {
  const segments = key.split('.');
  let current: unknown = dictionary;
  for (const segment of segments) {
    if (current && typeof current === 'object' && segment in (current as Record<string, unknown>)) {
      current = (current as Record<string, unknown>)[segment];
    } else {
      return undefined;
    }
  }
  return current;
}

function format(template: unknown, params?: InterpolationParams): string {
  if (typeof template === 'function') {
    // Function-typed entries (e.g. `closeSession: (name) => "Close " + name`)
    // receive the params object as a single argument. The dictionary types
    // declare positional params in the type, so a TS caller that passes
    // `{ name: 'foo' }` will get a string back as expected. The cast keeps
    // the type system happy without us hard-coding the function signature.
    return template((params ?? {}) as never);
  }
  if (typeof template !== 'string') return String(template);
  if (!params) return template;
  return template.replace(/\{(\w+)\}/g, (match, name: string) => {
    if (Object.prototype.hasOwnProperty.call(params, name)) {
      return String(params[name]);
    }
    return match;
  });
}

export function I18nProvider({ children }: { children: React.ReactNode }) {
  const [locale, setLocaleState] = useState<Locale>(() => detectInitialLocale());

  // Sync locale from server on mount (server-authoritative, shared across clients).
  // 仅在服务端返回非默认值（'zh'）或与当前一致时才接受；服务端默认值 'en'
  // 不覆盖用户已显式选择的语言，防止因上次 PUT 失败导致强制刷新后回退成英文。
  useEffect(() => {
    if (typeof window === 'undefined') return;
    fetch('/api/terminal/settings')
      .then((r) => r.json())
      .then((s) => {
        if (s?.locale === 'zh' || s?.locale === 'en') {
          if (s.locale === locale) return;
          if (s.locale === 'en' && locale !== 'en') return;
          setLocaleState(s.locale);
          try { window.localStorage.setItem(STORAGE_KEY, s.locale); } catch { /* ignore */ }
        }
      })
      .catch(() => { /* keep local default */ });
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Persist to localStorage + server when locale changes.
  useEffect(() => {
    if (typeof window === 'undefined') return;
    try {
      window.localStorage.setItem(STORAGE_KEY, locale);
    } catch {
      // ignore
    }
    // Push to server so other connected clients pick up the change.
    (async () => {
      try {
        // Read CSRF token from cookie (server sets XSRF-TOKEN cookie).
        const cookies = document.cookie.split('; ');
        const csrfCookie = cookies.find((c) => c.startsWith('XSRF-TOKEN='));
        const csrfToken = csrfCookie ? decodeURIComponent(csrfCookie.split('=')[1]) : '';
        await fetch('/api/terminal/settings', {
          method: 'PUT',
          headers: {
            'Content-Type': 'application/json',
            ...(csrfToken ? { 'X-XSRF-TOKEN': csrfToken } : {}),
          },
          body: JSON.stringify({ locale }),
        });
      } catch { /* best effort */ }
    })();
    // Reflect on <html lang> for accessibility tools and CSS selectors.
    document.documentElement.lang = locale === 'zh' ? 'zh-CN' : 'en';
  }, [locale]);

  const setLocale = useCallback((next: Locale) => {
    setLocaleState(next);
  }, []);

  const dictionary = dictionaries[locale] ?? dictionaries[DEFAULT_LOCALE];

  const t = useCallback(
    <K extends TranslationKey>(key: K, params?: InterpolationParams): string => {
      const value = resolveKey(dictionary, key);
      if (value === undefined) {
        // Fall back to English so missing translations still render something useful.
        const fallback = resolveKey(dictionaries[DEFAULT_LOCALE], key);
        if (fallback === undefined) return key;
        return format(fallback, params);
      }
      return format(value, params);
    },
    [dictionary],
  );

  const value = useMemo<I18nContextValue>(() => ({ locale, setLocale, t }), [locale, setLocale, t]);

  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useI18n(): I18nContextValue {
  const ctx = useContext(I18nContext);
  if (!ctx) {
    // Provide a safe default so components rendered outside the provider (e.g.
    // unit tests) still render strings rather than throwing.
    return {
      locale: DEFAULT_LOCALE,
      setLocale: () => {},
      t: (key, params) => {
        const value = resolveKey(dictionaries[DEFAULT_LOCALE], key);
        return value === undefined ? key : format(value, params);
      },
    };
  }
  return ctx;
}

export type { Locale } from './types';
export { DEFAULT_LOCALE, SUPPORTED_LOCALES } from './types';
export type { TranslationDictionary } from './types';
