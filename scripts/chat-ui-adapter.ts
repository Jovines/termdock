import type { Plugin } from 'vite';
import { fileURLToPath } from 'node:url';
/** Use the vendor's unbundled ESM so every nested Markdown surface goes through
 * the same encrypted media/link renderer, and all components share one theme. */
export function chatUIAdapter(): Plugin {
  const vendor = fileURLToPath(new URL('../node_modules/@openuidev/react-ui/dist/', import.meta.url));
  const markdown = fileURLToPath(new URL('../src/lib/components/chat/ChatMarkdownBridge.tsx', import.meta.url));
  return {
    name: 'termdock-chat-ui-adapter', enforce: 'pre',
    config: () => ({
      resolve: { alias: [
        { find: /^@openuidev\/react-ui\/genui-lib$/, replacement: `${vendor}genui-lib/index.js` },
        { find: /^@openuidev\/react-ui\/ThemeProvider$/, replacement: `${vendor}components/ThemeProvider/index.js` },
      ] },
      ssr: { noExternal: ['@openuidev/react-ui'] },
      optimizeDeps: { exclude: ['@openuidev/react-ui'] },
    }),
    resolveId(source, importer) {
      if (importer?.includes('/@openuidev/react-ui/dist/') && !importer.includes('/components/Table/') && (importer.includes('/dist/components/') || source.includes('/components/Table')) && /(?:^|\/)Table(?:\/index)?(?:\.js)?$/.test(source)) return fileURLToPath(new URL('../src/lib/components/chat/ChatUITableBridge.tsx', import.meta.url));
      if (importer?.includes('/@openuidev/react-ui/dist/') && !importer.includes('/components/Select/') && (importer.includes('/dist/components/') || source.includes('/components/Select')) && /(?:^|\/)Select(?:\/index)?(?:\.js)?$/.test(source)) return fileURLToPath(new URL('../src/lib/components/chat/ChatUISelectBridge.tsx', import.meta.url));
      if (source.endsWith('/lucide/lucideDynamicImports.mjs') && importer?.includes('@openuidev/react-ui')) return fileURLToPath(new URL('../node_modules/lucide-react/dynamicIconImports.mjs', import.meta.url));
      if (importer?.replaceAll('\\', '/').includes('/@openuidev/react-ui/dist/') && (importer.includes('/dist/components/') || /\/components\/(?:MarkDownRenderer|CodeBlock|DatePicker)/.test(source)) && /(?:^|\/)(?:MarkDownRenderer|CodeBlock|DatePicker)(?:\/index)?(?:\.js)?$/.test(source)) return markdown;
    },
  };
}
