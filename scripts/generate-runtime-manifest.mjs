import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const packageJson = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const packageLock = JSON.parse(fs.readFileSync(path.join(root, 'package-lock.json'), 'utf8'));
const compatibility = JSON.parse(
  fs.readFileSync(path.join(root, 'desktop', 'runtime-compatibility.json'), 'utf8'),
);

function stableObject(value) {
  if (Array.isArray(value)) return value.map(stableObject);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.keys(value).sort().map((key) => [key, stableObject(value[key])]),
  );
}

function hashDirectory(directory) {
  const hash = crypto.createHash('sha256');
  const visit = (current, relative = '') => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })
      .sort((left, right) => left.name.localeCompare(right.name))) {
      const entryPath = path.join(current, entry.name);
      const relativePath = path.join(relative, entry.name).split(path.sep).join('/');
      if (entry.isDirectory()) visit(entryPath, relativePath);
      else if (entry.isFile()) {
        hash.update(relativePath);
        hash.update('\0');
        hash.update(fs.readFileSync(entryPath));
        hash.update('\0');
      }
    }
  };
  visit(directory);
  return `sha256-${hash.digest('base64')}`;
}

const productionPackages = Object.fromEntries(
  Object.entries(packageLock.packages ?? {})
    .filter(([packagePath, entry]) => packagePath && entry?.dev !== true)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([packagePath, entry]) => [packagePath, {
      version: entry.version ?? null,
      integrity: entry.integrity ?? null,
      optional: entry.optional === true,
    }]),
);
const dependencyInput = stableObject({
  dependencies: packageJson.dependencies ?? {},
  packages: productionPackages,
});
const dependencyHash = `sha256-${crypto
  .createHash('sha256')
  .update(JSON.stringify(dependencyInput))
  .digest('base64')}`;

const manifest = {
  schemaVersion: compatibility.schemaVersion,
  packageName: packageJson.name,
  version: packageJson.version,
  runtimeProtocolVersion: compatibility.runtimeProtocolVersion,
  minimumDesktopVersion: compatibility.minimumDesktopVersion,
  nodeMajor: compatibility.nodeMajor,
  dependencyHash,
  serverBundleHash: hashDirectory(path.join(root, 'dist', 'server')),
  entrypoint: 'dist/server/cli.js',
  clientEntrypoint: 'dist/client/index.html',
};

fs.writeFileSync(
  path.join(root, 'runtime-manifest.json'),
  `${JSON.stringify(manifest, null, 2)}\n`,
);
console.log(`[runtime-manifest] ${manifest.version} ${manifest.dependencyHash}`);
