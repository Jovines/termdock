import { defineConfig } from 'vitest/config';
import base from './vitest.terminal-peek.config';

export default defineConfig({
  ...base,
  cacheDir: 'node_modules/.vite/tmux-output-tests',
  test: { ...base.test, include: ['src/lib/components/terminal/tmuxLiveOutput.browser.tsx'] },
});
