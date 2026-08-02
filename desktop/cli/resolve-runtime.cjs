#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const resources = process.argv[2];
if (!resources) process.exit(2);

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function compareVersions(left, right) {
  const parse = (value) => {
    const match = String(value).match(/^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/);
    if (!match) throw new Error('invalid version');
    return { numbers: match.slice(1, 4).map(Number), prerelease: match[4] || null };
  };
  const a = parse(left);
  const b = parse(right);
  for (let index = 0; index < 3; index += 1) {
    if (a.numbers[index] !== b.numbers[index]) return a.numbers[index] - b.numbers[index];
  }
  if (a.prerelease === b.prerelease) return 0;
  if (a.prerelease === null) return 1;
  if (b.prerelease === null) return -1;
  return a.prerelease.localeCompare(b.prerelease, 'en', { numeric: true });
}

const bundledRoot = path.join(resources, 'server');
const bundledManifest = readJson(path.join(bundledRoot, 'runtime-manifest.json'));
let selectedRoot = bundledRoot;
let selectedManifest = bundledManifest;

try {
  const runtimeRoot = path.join(os.homedir(), '.termdock', 'desktop-runtime');
  const versionsRoot = fs.realpathSync(path.join(runtimeRoot, 'versions'));
  const versionRoot = fs.realpathSync(path.join(runtimeRoot, 'current'));
  const relative = path.relative(versionsRoot, versionRoot);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('unsafe path');
  const packageRoot = path.join(versionRoot, 'package');
  const candidate = readJson(path.join(packageRoot, 'runtime-manifest.json'));
  const compatible = candidate.schemaVersion === 1
    && candidate.packageName === 'termdock'
    && candidate.runtimeProtocolVersion === bundledManifest.runtimeProtocolVersion
    && candidate.nodeMajor === bundledManifest.nodeMajor
    && candidate.dependencyHash === bundledManifest.dependencyHash
    && compareVersions(bundledManifest.version, candidate.minimumDesktopVersion) >= 0
    && candidate.entrypoint === 'dist/server/cli.js'
    && fs.existsSync(path.join(packageRoot, candidate.entrypoint));
  if (compatible) {
    selectedRoot = packageRoot;
    selectedManifest = candidate;
  }
} catch {
  // Invalid, missing, or incompatible downloads fall back to the app bundle.
}

process.stdout.write(`${selectedManifest.version}\n${path.join(selectedRoot, selectedManifest.entrypoint)}\n`);
