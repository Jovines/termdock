import { configDefaults, defineConfig, mergeConfig } from 'vitest/config';
import viteConfig from './vite.config';

// Node's test runner owns .mjs suites and the fixture compiler test. Keeping
// runners separate avoids executing Node suites twice or reporting them empty.
export default mergeConfig(viteConfig, defineConfig({
  test: { exclude: [...configDefaults.exclude, '**/*.test.mjs', 'desktop-rust/scripts/react-terminal-fixture.test.ts'] },
}));
