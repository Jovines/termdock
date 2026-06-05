import React, { useEffect, useRef, useState } from 'react';
import { ArrowRight as RiArrowRightLine, Loader2 as RiLoader4Line } from 'lucide-react';
import { loginWithPassword } from '../../terminal/api';
import { useI18n } from '../../i18n';

interface LoginScreenProps {
  onLoginSuccess: () => void;
}

// ASCII banner for the brand mark. Kept as a single string so the monospace
// alignment is preserved exactly and we don't accidentally let a formatter
// collapse runs of whitespace.
const ASCII_LOGO = String.raw`
 ████████ ███████ ██████  ███    ███ ██████   ██████   ██████ ██   ██
    ██    ██      ██   ██ ████  ████ ██   ██ ██    ██ ██      ██  ██
    ██    █████   ██████  ██ ████ ██ ██   ██ ██    ██ ██      █████
    ██    ██      ██   ██ ██  ██  ██ ██   ██ ██    ██ ██      ██  ██
    ██    ███████ ██   ██ ██      ██ ██████   ██████   ██████ ██   ██
`;

// Renders a fullscreen password form. Stays mounted for the lifetime of the
// "logged out" state — the parent App swaps it in/out based on auth status.
export function LoginScreen({ onLoginSuccess }: LoginScreenProps) {
  const { t } = useI18n();
  const [password, setPassword] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [retrySecondsLeft, setRetrySecondsLeft] = useState<number>(0);
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  // When rate-limited, count down so the button stays disabled and the
  // remaining seconds are visible to the user.
  useEffect(() => {
    if (retrySecondsLeft <= 0) return;
    const tick = setInterval(() => {
      setRetrySecondsLeft((s) => (s > 1 ? s - 1 : 0));
    }, 1000);
    return () => clearInterval(tick);
  }, [retrySecondsLeft]);

  const blocked = retrySecondsLeft > 0;
  const canSubmit = !submitting && !blocked && password.length > 0;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!canSubmit) return;
    setSubmitting(true);
    setError(null);
    try {
      const result = await loginWithPassword(password);
      if (result.ok) {
        setPassword('');
        onLoginSuccess();
        return;
      }
      setError(result.error || t('login.invalidPassword'));
      if (result.rateLimited && typeof result.retryAfterMs === 'number') {
        setRetrySecondsLeft(Math.max(1, Math.ceil(result.retryAfterMs / 1000)));
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : t('login.failed'));
    } finally {
      setSubmitting(false);
    }
  };

  const placeholder = blocked ? t('login.placeholderBlocked', { s: retrySecondsLeft }) : t('login.placeholder');

  return (
    <div
      className="flex w-screen flex-col items-center justify-center bg-background px-4 text-foreground"
      style={{
        height: 'var(--app-vh, 100vh)',
        // Bias the vertical center upward to ~2/5 from the top (i.e. 3/5 from
        // the bottom) by reserving extra space below. justify-center handles
        // the rest, and the form stays well above the soft-keyboard fold.
        paddingTop: 'env(safe-area-inset-top, 0px)',
        paddingBottom: '20vh',
        gap: 'clamp(20px, 4vh, 40px)',
      }}
    >
      {/* ASCII brand mark — sized so the widest line still fits within the viewport.
          Logo is ~70 monospace chars wide; in monospace, char-width ≈ 0.6em, so
          the safe upper bound for `font-size` is roughly viewport / 42. */}
      <pre
        aria-hidden
        className="max-w-full select-none overflow-hidden whitespace-pre leading-[1.05] text-primary/80 font-mono"
        style={{
          fontSize: 'clamp(5px, 2vw, 14px)',
        }}
      >
        {ASCII_LOGO}
      </pre>

      {/* Terminal-style prompt with blinking cursor for personality */}
      <div
        className="flex items-center gap-2 text-sm text-muted-foreground font-mono"
      >
        <span className="text-primary">$</span>
        <span>{t('login.prompt')}</span>
        <span className="terminal-cursor" aria-hidden>
          ▍
        </span>
      </div>

      <form onSubmit={handleSubmit} className="w-full max-w-xs">
        <div
          className={`flex items-center gap-1 rounded-full border bg-surface-2 p-1 pl-4 transition ${
            error ? 'border-red-500/60' : 'border-border'
          }`}
        >
          <input
            ref={inputRef}
            type="password"
            autoComplete="current-password"
            value={password}
            placeholder={placeholder}
            onChange={(e) => {
              setPassword(e.target.value);
              if (error) setError(null);
            }}
            disabled={submitting || blocked}
            // font-size must be >= 16px to prevent iOS Safari from auto-zooming
            // the page when the input gains focus.
            className="flex-1 bg-transparent text-foreground placeholder:text-muted-foreground/70 focus:outline-none disabled:opacity-60"
            style={{ minWidth: 0, fontSize: '16px' }}
          />
          <button
            type="submit"
            disabled={!canSubmit}
            aria-label={t('login.submit')}
            className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-primary text-primary-foreground transition hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-40"
          >
            {submitting ? (
              <RiLoader4Line size={16} className="animate-spin" />
            ) : (
              <RiArrowRightLine size={16} />
            )}
          </button>
        </div>

        {error && !blocked ? (
          <div className="mt-3 text-center text-xs text-red-400">{error}</div>
        ) : null}
      </form>

      {/* Blinking cursor keyframes scoped via a class on this page */}
      <style>{`
        @keyframes terminal-blink {
          0%, 49% { opacity: 1; }
          50%, 100% { opacity: 0; }
        }
        .terminal-cursor {
          display: inline-block;
          animation: terminal-blink 1.05s steps(1, end) infinite;
          color: var(--primary);
        }
      `}</style>
    </div>
  );
}
