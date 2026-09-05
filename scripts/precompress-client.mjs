import fs from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { brotliCompress, gzip, constants } from 'node:zlib';

const br = promisify(brotliCompress);
const gz = promisify(gzip);
const root = path.resolve(process.argv[2] || 'dist/client');
const extensions = new Set(['.js', '.mjs', '.css', '.html', '.json', '.svg', '.webmanifest', '.txt']);

async function visit(directory) {
  // Bound compression concurrency: builds must not allocate one zlib context
  // per Mermaid chunk or compete with the running terminal server.
  for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) await visit(file);
    else if (entry.isFile() && extensions.has(path.extname(file))) {
      const raw = await fs.readFile(file);
      if (raw.length < 1024) continue;
      const compressed = await br(raw, { params: { [constants.BROTLI_PARAM_QUALITY]: 9 } });
      await fs.writeFile(`${file}.br`, compressed);
      await fs.writeFile(`${file}.gz`, await gz(raw, { level: 7 }));
    }
  }
}

await visit(root);
console.log('Prepared Brotli/gzip client assets.');
