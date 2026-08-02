import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function git(args) {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
}

function stable(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])]));
}

function latestDesktopTag() {
  return git(['tag', '--merged', 'HEAD', '--list', 'v*', '--sort=-version:refname'])
    .split('\n')
    .find(Boolean);
}

const requestedBase = process.argv.slice(2).find((argument) => !argument.startsWith('--'));
const base = requestedBase || latestDesktopTag();
if (!base) {
  throw new Error('No desktop release tag found. Fetch tags or pass a base ref explicitly.');
}

const changedFiles = git(['diff', '--name-only', base, '--'])
  .split('\n')
  .map((file) => file.trim())
  .filter(Boolean);
const currentPackage = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const basePackage = JSON.parse(git(['show', `${base}:package.json`]));
const dependencyChanged = JSON.stringify(stable({
  dependencies: currentPackage.dependencies ?? {},
  engines: currentPackage.engines ?? {},
})) !== JSON.stringify(stable({
  dependencies: basePackage.dependencies ?? {},
  engines: basePackage.engines ?? {},
}));

const desktopPatterns = [
  /^desktop\//,
  /^forge\.config\.cjs$/,
  /^tsconfig\.desktop\.json$/,
  /^scripts\/prepare-desktop-runtime\.mjs$/,
  /^scripts\/prepare-desktop-tokens\.mjs$/,
  /^\.github\/workflows\/release-macos\.yml$/,
];
const runtimePatterns = [
  /^src\//,
  /^public\//,
  /^index\.html$/,
  /^vite\.config\.ts$/,
  /^tailwind\.config\.js$/,
  /^postcss\.config\.js$/,
  /^package(?:-lock)?\.json$/,
  /^scripts\/generate-runtime-manifest\.mjs$/,
];
const testFile = /(?:^|\/)\w[^/]*\.test\.[cm]?[jt]sx?$/;
const noReleaseFile = /^(?:docs\/|README|LICENSE|AGENTS|\.gitignore$|scripts\/classify-release\.mjs$)/;
const desktopFiles = changedFiles.filter((file) =>
  !testFile.test(file) && desktopPatterns.some((pattern) => pattern.test(file)));
const runtimeFiles = changedFiles.filter((file) =>
  !testFile.test(file) && runtimePatterns.some((pattern) => pattern.test(file)));
const codeFiles = changedFiles.filter((file) => !noReleaseFile.test(file) && !testFile.test(file));
const classified = new Set([...desktopFiles, ...runtimeFiles]);
const unknownCodeFiles = codeFiles.filter((file) => !classified.has(file));
const requiresDesktop = dependencyChanged || desktopFiles.length > 0 || unknownCodeFiles.length > 0;
const requiresRuntime = runtimeFiles.length > 0 || requiresDesktop;
const result = {
  base,
  requiresRuntime,
  requiresDesktop,
  dependencyChanged,
  desktopFiles,
  runtimeFiles,
  unknownCodeFiles,
};

console.log(JSON.stringify(result, null, 2));
if (process.argv.includes('--github-output') && process.env.GITHUB_OUTPUT) {
  fs.appendFileSync(
    process.env.GITHUB_OUTPUT,
    `requires_runtime=${requiresRuntime}\nrequires_desktop=${requiresDesktop}\n`,
  );
}
