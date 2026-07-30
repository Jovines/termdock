import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(scriptDir, '..');
const sourcePath = path.join(root, 'src', 'index.css');
const outputPath = path.join(root, 'desktop', 'renderer', 'tokens.css');
const source = fs.readFileSync(sourcePath, 'utf8');

function extractBlock(selector) {
  const start = source.indexOf(`${selector} {`);
  if (start < 0) throw new Error(`Missing ${selector} token block in ${sourcePath}`);
  let depth = 0;
  let bodyStart = -1;
  for (let index = start; index < source.length; index += 1) {
    if (source[index] === '{') {
      depth += 1;
      if (depth === 1) bodyStart = index + 1;
    } else if (source[index] === '}') {
      depth -= 1;
      if (depth === 0) return `${selector} {${source.slice(bodyStart, index)}}`;
    }
  }
  throw new Error(`Unclosed ${selector} token block in ${sourcePath}`);
}

const generated = [
  '/* Generated from src/index.css. Do not edit. */',
  extractBlock(':root'),
  extractBlock("html[data-theme='light']"),
  '',
].join('\n\n');

fs.writeFileSync(outputPath, generated);
