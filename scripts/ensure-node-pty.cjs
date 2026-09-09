// Pinned node-pty 1.1.0 macOS FD fix. Runs before loading the native addon.
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { spawnSync } = require('node:child_process');
const hash = data => createHash('sha256').update(data).digest('hex');
const upstreamHash = '5e1005d6bdcfbe97b486ee415419fe7adae99035047f07340fbad36419e0bae6';

function patchSource(source) {
  if (hash(source) !== upstreamHash) throw new Error('Unrecognized node-pty source; review the macOS FD patch before upgrading');
  const start = source.indexOf('static void\npty_posix_spawn(char** argv', source.indexOf('pty_getproc(int fd)'));
  const end = source.indexOf('\n#endif', start);
  if (start < 0 || end < 0) throw new Error('node-pty spawn implementation missing');
  source = source.slice(0, start) + fs.readFileSync(path.join(__dirname, 'node-pty-darwin-spawn.inc'), 'utf8').trimEnd() + source.slice(end);
  source = source.replace('    int stat_loc;', '    int stat_loc = 0;');
  source = source.replace('    }\n#else\n    while (true)', '    }\n    if (kq >= 0) close(kq);\n#else\n    while (true)');
  source = source.replace('throw Napi::Error::New(napiEnv, "posix_spawnp failed.");',
    'throw Napi::Error::New(napiEnv, std::string("posix_spawnp failed: errno=") + std::to_string(err) + " (" + strerror(err) + ")");');
  source = source.replace('  if (pty_nonblock(master) == -1) {\n    throw',
    '  if (pty_nonblock(master) == -1) {\n    close(master);\n    kill(pid, SIGKILL);\n    HANDLE_EINTR(waitpid(pid, NULL, 0));\n    throw');
  return source;
}

const checked = new Set();
function ensureNodePty(ptyRoot = path.dirname(require.resolve('node-pty/package.json'))) {
  if (process.platform !== 'darwin' || checked.has(ptyRoot)) return;
  const sourcePath = path.join(ptyRoot, 'src/unix/pty.cc');
  const backupPath = path.join(ptyRoot, 'src/unix/pty.cc.termdock-original');
  const markerPath = path.join(ptyRoot, '.termdock-fd-fix.json');
  const binaryPath = path.join(ptyRoot, 'build/Release/pty.node');
  const helperPath = path.join(ptyRoot, 'build/Release/spawn-helper');
  const original = fs.readFileSync(fs.existsSync(backupPath) ? backupPath : sourcePath, 'utf8');
  const patched = patchSource(original);
  const sourceHash = hash(patched);
  try {
    const marker = JSON.parse(fs.readFileSync(markerPath, 'utf8'));
    if (marker.source === sourceHash && marker.binary === hash(fs.readFileSync(binaryPath))
        && hash(fs.readFileSync(sourcePath)) === sourceHash && fs.existsSync(helperPath)) {
      const helperMode = fs.statSync(helperPath).mode;
      if ((helperMode & 0o111) !== 0o111) fs.chmodSync(helperPath, helperMode | 0o111);
      checked.add(ptyRoot);
      return;
    }
  } catch { /* First install or replaced binary: rebuild, never accept a spawn-only probe. */ }
  fs.writeFileSync(backupPath, original);
  fs.writeFileSync(sourcePath, patched);
  fs.rmSync(markerPath, { force: true });
  // Prevent the native loader from silently falling back to a leaking prebuild.
  fs.rmSync(path.join(ptyRoot, 'prebuilds', `darwin-${process.arch}`), { recursive: true, force: true });
  fs.rmSync(path.join(ptyRoot, 'build/Debug'), { recursive: true, force: true });
  console.log('Rebuilding node-pty with the Termdock macOS FD cleanup fix...');
  const result = spawnSync('npx', ['--yes', 'node-gyp', 'rebuild'], {
    cwd: ptyRoot, stdio: 'inherit', timeout: 180_000,
  });
  if (result.error || result.status !== 0) {
    throw new Error('Patched node-pty rebuild failed; install Xcode Command Line Tools and retry. ' + (result.error?.message || ''));
  }
  fs.chmodSync(helperPath, fs.statSync(helperPath).mode | 0o111);
  fs.writeFileSync(markerPath, JSON.stringify({ source: sourceHash, binary: hash(fs.readFileSync(binaryPath)) }));
  checked.add(ptyRoot);
}
module.exports = { ensureNodePty, patchSource };
if (require.main === module) ensureNodePty(process.argv[2]);
