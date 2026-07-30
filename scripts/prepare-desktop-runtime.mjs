import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(scriptDir, '..');
const stage = path.join(root, '.desktop-runtime');
const runtimeDir = path.join(stage, 'runtime');
const serverDir = path.join(stage, 'server');
const toolchainDir = path.join(stage, 'toolchain');
const toolchainBinDir = path.join(toolchainDir, 'bin');
const toolchainLibDir = path.join(toolchainDir, 'lib');
const nodeDownloadDir = path.join(stage, 'node-download');
const desktopBuildNodeMajor = 22;

const buildNodeMajor = Number.parseInt(process.versions.node.split('.')[0], 10);
if (buildNodeMajor !== desktopBuildNodeMajor) {
  throw new Error(
    `macOS desktop packaging requires Node.js ${desktopBuildNodeMajor}.x; `
      + `current build runtime is ${process.version}.`,
  );
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? root,
    env: options.env ?? process.env,
    encoding: 'utf8',
    stdio: options.stdio ?? 'inherit',
  });
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(' ')} failed with exit code ${result.status}`);
  }
  return result.stdout ?? '';
}

function executableOnPath(name) {
  if (process.platform === 'darwin') {
    for (const candidate of [
      `/opt/homebrew/bin/${name}`,
      `/usr/local/bin/${name}`,
    ]) {
      if (fs.existsSync(candidate)) return candidate;
    }
  }
  try {
    return execFileSync('/usr/bin/which', [name], { encoding: 'utf8' }).trim() || null;
  } catch {
    return null;
  }
}

function isSystemLibrary(libraryPath) {
  return libraryPath.startsWith('/System/Library/')
    || libraryPath.startsWith('/usr/lib/');
}

function linkedLibraries(binaryPath) {
  if (process.platform !== 'darwin') return [];
  const output = execFileSync('/usr/bin/otool', ['-L', binaryPath], { encoding: 'utf8' });
  return output
    .split('\n')
    .slice(1)
    .map((line) => line.trim().split(/\s+\(/)[0])
    .filter((entry) => entry && !entry.startsWith('@') && !isSystemLibrary(entry));
}

function copyMacBinary(sourcePath, destinationPath) {
  fs.copyFileSync(sourcePath, destinationPath);
  fs.chmodSync(destinationPath, 0o755);
  if (process.platform !== 'darwin') return;

  const queue = [{ source: sourcePath, destination: destinationPath, inLibDir: false }];
  const copiedLibraries = new Map();
  while (queue.length > 0) {
    const current = queue.shift();
    for (const dependency of linkedLibraries(current.source)) {
      const basename = path.basename(dependency);
      const bundledDependency = path.join(toolchainLibDir, basename);
      if (!copiedLibraries.has(dependency)) {
        if (!fs.existsSync(dependency)) {
          throw new Error(`Missing linked library ${dependency} required by ${current.source}`);
        }
        fs.copyFileSync(dependency, bundledDependency);
        fs.chmodSync(bundledDependency, 0o755);
        copiedLibraries.set(dependency, bundledDependency);
        queue.push({ source: dependency, destination: bundledDependency, inLibDir: true });
      }
      const relativeReference = current.inLibDir
        ? `@loader_path/${basename}`
        : `@loader_path/../lib/${basename}`;
      run('/usr/bin/install_name_tool', ['-change', dependency, relativeReference, current.destination]);
    }
    if (current.inLibDir) {
      run('/usr/bin/install_name_tool', ['-id', `@loader_path/${path.basename(current.destination)}`, current.destination]);
    }
  }
}

function makeSpawnHelpersExecutable(directory) {
  if (!fs.existsSync(directory)) return;
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      makeSpawnHelpersExecutable(entryPath);
    } else if (entry.isFile() && entry.name === 'spawn-helper') {
      fs.chmodSync(entryPath, 0o755);
    }
  }
}

fs.rmSync(stage, { recursive: true, force: true });
fs.mkdirSync(path.join(runtimeDir, 'bin'), { recursive: true });
fs.mkdirSync(serverDir, { recursive: true });
fs.mkdirSync(toolchainBinDir, { recursive: true });
fs.mkdirSync(toolchainLibDir, { recursive: true });

const runtimeNode = path.join(runtimeDir, 'bin', 'node');
const nodePlatform = process.platform === 'win32' ? 'win' : process.platform;
const nodeArch = process.arch === 'x64' ? 'x64' : process.arch;
const nodeArchiveExt = process.platform === 'win32' ? 'zip' : 'tar.gz';
const nodeArchiveName = `node-${process.version}-${nodePlatform}-${nodeArch}.${nodeArchiveExt}`;
const nodeArchiveUrl = `https://nodejs.org/dist/${process.version}/${nodeArchiveName}`;
fs.mkdirSync(nodeDownloadDir, { recursive: true });
const nodeArchivePath = path.join(nodeDownloadDir, nodeArchiveName);
run('/usr/bin/curl', ['-fL', '--retry', '4', '--output', nodeArchivePath, nodeArchiveUrl]);
if (nodeArchiveExt !== 'tar.gz') {
  throw new Error(`Desktop runtime preparation is not implemented for ${process.platform}`);
}
run('/usr/bin/tar', ['-xzf', nodeArchivePath, '-C', nodeDownloadDir]);
const extractedNode = path.join(
  nodeDownloadDir,
  `node-${process.version}-${nodePlatform}-${nodeArch}`,
  'bin',
  'node',
);
copyMacBinary(extractedNode, runtimeNode);

const rootPackage = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const runtimePackage = {
  name: 'termdock-desktop-runtime',
  version: rootPackage.version,
  private: true,
  type: 'module',
  dependencies: rootPackage.dependencies,
};
fs.writeFileSync(path.join(serverDir, 'package.json'), `${JSON.stringify(runtimePackage, null, 2)}\n`);
fs.cpSync(path.join(root, 'dist'), path.join(serverDir, 'dist'), { recursive: true });

run(process.platform === 'win32' ? 'npm.cmd' : 'npm', [
  'install',
  '--omit=dev',
  '--no-audit',
  '--no-fund',
], {
  cwd: serverDir,
  env: {
    ...process.env,
    PATH: `${path.dirname(process.execPath)}${path.delimiter}${process.env.PATH ?? ''}`,
  },
});

makeSpawnHelpersExecutable(path.join(serverDir, 'node_modules', 'node-pty'));
run(runtimeNode, [
  '-e',
  [
    "const {createRequire}=require('node:module')",
    "const req=createRequire(process.cwd()+'/desktop-runtime-probe.cjs')",
    "const pty=req('node-pty')",
    "const child=pty.spawn(process.platform==='win32'?'cmd.exe':'/bin/sh',process.platform==='win32'?['/d','/s','/c','echo termdock-desktop-pty-ok']:['-lc','printf termdock-desktop-pty-ok'],{name:'xterm',cols:80,rows:24})",
    "let output=''",
    "child.onData((data)=>{output+=data})",
    "child.onExit(()=>{if(!output.includes('termdock-desktop-pty-ok')){console.error(output);process.exit(1)}})",
  ].join(';'),
], { cwd: serverDir });

for (const name of ['tmux', 'rg', 'git', 'mkcert']) {
  const source = executableOnPath(name);
  if (!source) {
    console.warn(`[desktop-runtime] optional bundled tool not found: ${name}`);
    continue;
  }
  const destination = path.join(toolchainBinDir, name);
  copyMacBinary(source, destination);
  console.log(`[desktop-runtime] bundled ${name} from ${source}`);
}

const manifest = {
  version: rootPackage.version,
  platform: process.platform,
  arch: process.arch,
  nodeVersion: process.version,
  createdAt: new Date().toISOString(),
  tools: fs.readdirSync(toolchainBinDir).sort(),
};
fs.writeFileSync(path.join(stage, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
console.log(`[desktop-runtime] ready at ${stage}`);
