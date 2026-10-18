import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';

export const repository = 'Jovines/termdock';
export const previewEndpoint = `https://github.com/${repository}/releases/download/preview-channel/preview.json`;
export function outsideSource(root, target) {
  const relative = path.relative(root, target);
  return relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative);
}
export function releasePlan(version, publicKey) {
  if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(version ?? '')) throw Error('A separate numeric Preview version is required (for example 0.1.1)');
  if (!publicKey || Buffer.from(publicKey, 'base64').toString('base64') !== publicKey) throw Error('Preview updater public key is required');
  const lines = Buffer.from(publicKey, 'base64').toString('utf8').trim().split(/\r?\n/);
  if (lines.length !== 2 || !lines[0].startsWith('untrusted comment: ')) throw Error('Invalid Preview updater public key');
  const key = Buffer.from(lines[1], 'base64');
  if (key.length !== 42 || key.subarray(0, 2).toString() !== 'Ed') throw Error('Invalid Preview updater public key');
  return {
    tag: `preview-v${version}`, version, prerelease: true,
    endpoint: previewEndpoint,
    environment: { TERMDOCK_PREVIEW_UPDATE_ENDPOINT: previewEndpoint, TERMDOCK_PREVIEW_UPDATE_PUBLIC_KEY: publicKey },
    config: { productName: 'Termdock Preview', identifier: 'com.jovines.termdock.preview', version,
      bundle: { createUpdaterArtifacts: true },
      plugins: { updater: { pubkey: publicKey, endpoints: [], requireSignedVersion: true } } },
  };
}
export function updateManifest(plan, artifacts, notes = '', now = new Date()) {
  const platforms = {};
  for (const { platform, filename, signature } of artifacts) {
    if (!['darwin-aarch64', 'darwin-x86_64'].includes(platform) || platforms[platform]) throw Error('Invalid or duplicate Preview platform');
    const arch = platform.slice('darwin-'.length);
    if (filename !== `Termdock-Preview_${plan.version}_${arch}.app.tar.gz` || !signature?.trim()) throw Error('Invalid Preview update asset');
    platforms[platform] = { signature: signature.trim(), url: `https://github.com/${repository}/releases/download/${plan.tag}/${filename}` };
  }
  if (!artifacts.length) throw Error('No signed Preview update assets');
  return { version: plan.version, notes, pub_date: now.toISOString(), platforms };
}
function run(command, args, options = {}) {
  const result = spawnSync(command, args, { stdio: 'inherit', ...options });
  if (result.error) throw result.error;
  if (result.status !== 0) throw Error(`${command} failed (${result.status})`);
}
function output(command, args, options = {}) {
  return fsSafeOutput(spawnSync(command, args, { encoding: 'utf8', ...options }));
}
function fsSafeOutput(result) {
  if (result.error) throw result.error;
  if (result.status !== 0) throw Error('Release identity check failed');
  return result.stdout.trim();
}
export function buildPreview(version, destination, env = process.env) {
  if (process.platform !== 'darwin') throw Error('Preview release packaging requires macOS');
  const root = fileURLToPath(new URL('../../', import.meta.url));
  const cwd = path.join(root, 'desktop-rust');
  if (env.CARGO_BUILD_TARGET) throw Error('Use a native macOS release environment without CARGO_BUILD_TARGET');
  if (env.CARGO_TARGET_DIR && !path.isAbsolute(env.CARGO_TARGET_DIR)) throw Error('CARGO_TARGET_DIR must be absolute for release packaging');
  const out = path.resolve(destination);
  if (!outsideSource(root, out)) throw Error('Release output must be outside the source tree');
  if (fs.existsSync(out)) throw Error('Use a new output directory for each Preview release');
  const parent = path.dirname(out);
  if (!fs.existsSync(parent)) throw Error('Create the release output parent directory first');
  const realParent = fs.realpathSync(parent), realRoot = fs.realpathSync(root);
  if (!outsideSource(realRoot, realParent)) throw Error('Release output cannot resolve inside the source tree');
  const hasGit = fs.existsSync(path.join(root, '.git'));
  const revision = hasGit ? output('git', ['rev-parse', 'HEAD'], { cwd: root }) : env.TERMDOCK_PREVIEW_SOURCE_REVISION;
  if (!/^[a-f0-9]{40}$/.test(revision ?? '')) throw Error('Archive release requires an exact TERMDOCK_PREVIEW_SOURCE_REVISION');
  if (hasGit && output('git', ['status', '--porcelain'], { cwd: root })) throw Error('Preview release requires a clean source revision');
  const plan = releasePlan(version, env.TERMDOCK_PREVIEW_UPDATE_PUBLIC_KEY);
  if (!env.TAURI_SIGNING_PRIVATE_KEY) throw Error('A private updater signing key must be supplied by the release environment');
  if (!env.APPLE_SIGNING_IDENTITY?.startsWith('Developer ID Application:')) throw Error('Preview release requires a Developer ID Application identity');
  const buildEnv = { ...env, ...plan.environment };
  fs.mkdirSync(out, { recursive: true });
  const config = path.join(out, 'preview-build.json');
  fs.writeFileSync(config, JSON.stringify(plan.config, null, 2));
  for (const step of ['prepare:workspace', 'prepare:native', 'prepare:renderer']) run('npm', ['run', step], { cwd, env: buildEnv });
  run(process.execPath, ['scripts/prepare-workspace.mjs', '--require-clean'], { cwd, env: buildEnv });
  run(path.join(cwd, 'node_modules/.bin/tauri'), ['build', '--bundles', 'app,dmg', '--config', config], { cwd, env: buildEnv });
  const target = env.CARGO_TARGET_DIR ? path.resolve(cwd, env.CARGO_TARGET_DIR) : path.join(cwd, 'src-tauri/target');
  const bundle = path.join(target, 'release/bundle');
  const app = path.join(bundle, 'macos/Termdock Preview.app');
  const plist = path.join(app, 'Contents/Info.plist');
  if (output('/usr/libexec/PlistBuddy', ['-c', 'Print :CFBundleIdentifier', plist]) !== plan.config.identifier
    || output('/usr/libexec/PlistBuddy', ['-c', 'Print :CFBundleShortVersionString', plist]) !== version) throw Error('Preview bundle identity/version mismatch');
  run('/usr/bin/codesign', ['--verify', '--deep', '--strict', app]);
  const identity = spawnSync('/usr/bin/codesign', ['-dv', '--verbose=4', app], { encoding: 'utf8' });
  if (identity.status !== 0 || !identity.stderr.includes('Authority=Developer ID Application:')) throw Error('Preview app is not Developer ID signed');
  const executable = output('/usr/libexec/PlistBuddy', ['-c', 'Print :CFBundleExecutable', plist]);
  const arch = output('/usr/bin/lipo', ['-archs', path.join(app, 'Contents/MacOS', executable)]);
  const platform = { arm64: 'darwin-aarch64', x86_64: 'darwin-x86_64' }[arch];
  if (!platform) throw Error('Only single-architecture release assets are supported');
  const name = `Termdock-Preview_${version}_${platform.slice(7)}`;
  const tar = path.join(out, `${name}.app.tar.gz`);
  fs.copyFileSync(`${app}.tar.gz`, tar);
  fs.copyFileSync(`${app}.tar.gz.sig`, `${tar}.sig`);
  const signature = fs.readFileSync(`${tar}.sig`, 'utf8');
  const manifest = updateManifest(plan, [{ platform, filename: path.basename(tar), signature }]);
  fs.writeFileSync(path.join(out, 'preview.json'), JSON.stringify(manifest, null, 2));
  const dmgFiles = fs.readdirSync(path.join(bundle, 'dmg')).filter(name => name.endsWith('.dmg'));
  if (dmgFiles.length !== 1) throw Error('Expected one Preview DMG');
  fs.copyFileSync(path.join(bundle, 'dmg', dmgFiles[0]), path.join(out, `${name}.dmg`));
  const artifacts = [path.basename(tar), `${path.basename(tar)}.sig`, `${name}.dmg`, 'preview.json'];
  fs.writeFileSync(path.join(out, 'release.json'), JSON.stringify({ ...plan, environment: undefined,
    revision, notarizationVerified: false,
    artifacts: artifacts.map(name => ({ name, sha256: createHash('sha256').update(fs.readFileSync(path.join(out, name))).digest('hex') })) }, null, 2));
  console.log(`Prepared ${plan.tag}; publish as a GitHub prerelease, then update preview-channel/preview.json. No service or installed app was changed.`);
}
if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  try {
    const [version, destination] = process.argv.slice(2);
    if (!version || !destination) throw Error('Usage: node scripts/preview-release.mjs VERSION NEW_OUTPUT_DIRECTORY');
    buildPreview(version, destination);
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
