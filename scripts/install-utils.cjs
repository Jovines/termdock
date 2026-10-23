// Shared by npm postinstall and the first-start checks. Never invoke a shell or
// open a sudo password prompt from an npm lifecycle/background process.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

function findExecutable(command, { env = process.env, home = os.homedir(), platform = process.platform } = {}) {
  const extra = [path.join(home, '.termdock/bin'), path.join(home, '.local/bin'), '/usr/local/bin', '/usr/bin', '/bin', '/usr/sbin', '/sbin'];
  if (platform === 'darwin') extra.push('/opt/homebrew/bin', '/opt/local/bin');
  const candidates = command.includes(path.sep) ? [path.resolve(command)] : [...new Set([...(env.PATH || '').split(path.delimiter).filter(Boolean), ...extra])].map(dir => path.resolve(dir, command));
  for (const candidate of candidates) {
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      if (fs.statSync(candidate).isFile()) return candidate;
    } catch { /* Continue through the actual executable paths. */ }
  }
  return null;
}

function runFile(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 120_000, ...options });
  return { ok: !result.error && result.status === 0, stdout: result.stdout || '', stderr: result.stderr || '',
    error: result.error?.message || (result.status !== 0 ? `exit status=${result.status ?? 'none'}${result.signal ? `; signal=${result.signal}` : ''}` : '') };
}

function tmuxInstallPlan(platform = process.platform, find = findExecutable) {
  const candidates = platform === 'darwin' ? [
    ['brew', ['install', 'tmux'], false], ['port', ['install', 'tmux'], true], ['nix-env', ['-iA', 'nixpkgs.tmux'], false],
  ] : platform === 'linux' ? [
    ['apt-get', ['install', '-y', 'tmux'], true], ['dnf', ['install', '-y', 'tmux'], true],
    ['yum', ['install', '-y', 'tmux'], true], ['apk', ['add', 'tmux'], true],
    ['pacman', ['-S', '--noconfirm', 'tmux'], true], ['zypper', ['--non-interactive', 'install', 'tmux'], true],
    ['nix-env', ['-iA', 'nixpkgs.tmux'], false],
  ] : [];
  for (const [name, args, needsRoot] of candidates) {
    const command = find(name);
    if (command) return { command, args, needsRoot, hint: `${needsRoot ? 'sudo ' : ''}${name} ${args.join(' ')}` };
  }
  return null;
}

function checkTmux({ platform = process.platform, uid = process.getuid?.(), find = findExecutable, run = runFile } = {}) {
  const probe = () => {
    const command = find('tmux');
    if (!command) return null;
    const result = run(command, ['-V'], { timeout: 5000 });
    return result.ok && /^tmux\s+\d/.test(result.stdout.trim()) ? result.stdout.trim() : null;
  };
  const version = probe();
  if (version) return { ok: true, installed: false, version };
  const plan = tmuxInstallPlan(platform, find);
  if (!plan) return { ok: false, installed: false, error: 'tmux is unavailable. Install it with your system package manager (Windows: use WSL).' };
  let command = plan.command, args = plan.args;
  if (plan.needsRoot && uid !== 0) {
    const sudo = find('sudo');
    if (!sudo || !run(sudo, ['-n', 'true'], { timeout: 5000 }).ok) {
      return { ok: false, installed: false, error: `tmux is unavailable; automatic installation needs root or passwordless sudo. Run: ${plan.hint}` };
    }
    command = sudo; args = ['-n', plan.command, ...args];
  }
  const installed = run(command, args);
  const checked = probe();
  return checked ? { ok: true, installed: true, version: checked }
    : { ok: false, installed: false, error: `tmux installation did not produce a usable executable. Run: ${plan.hint}. ${(installed.stderr || installed.error || 'Installer returned without a working tmux').trim().slice(-1500)}` };
}

function probeNodePty(ptyRoot) {
  const pty = require(ptyRoot);
  // A stale/nonexistent $SHELL (or a minimal distro without bash) does not mean
  // the native addon needs recompiling. Probe the portable system shell.
  const child = pty.spawn(process.platform === 'win32' ? process.env.ComSpec || 'cmd.exe' : '/bin/sh',
    process.platform === 'win32' ? ['/c', 'exit', '0'] : ['-c', 'exit 0'], { name: 'xterm', cols: 80, rows: 24 });
  child.kill();
}

function clearPtyModuleCache(ptyRoot) {
  for (const file of Object.keys(require.cache)) if (file.startsWith(ptyRoot + path.sep)) delete require.cache[file];
}

module.exports = { findExecutable, runFile, tmuxInstallPlan, checkTmux, probeNodePty, clearPtyModuleCache };
