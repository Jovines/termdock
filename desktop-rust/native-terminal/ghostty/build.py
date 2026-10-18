#!/usr/bin/env python3
"""Locked source/toolchain/deps -> full external-only lib. All caches outside Git."""
import argparse
from contextlib import contextmanager
import hashlib
import json
import os
from pathlib import Path
import platform
import re
import shlex
import shutil
import subprocess
import tarfile
import tempfile
import sys
import urllib.request

HERE = Path(__file__).resolve().parent
LOCK_TEXT = (HERE / 'lock.json').read_text()
LOCK = json.loads(LOCK_TEXT)

def sha(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()

def verify(path, digest):
    if sha(path) != digest:
        raise RuntimeError(f'checksum mismatch: {path}')

def verify_source(archive, source):
    # Validate EVERY original source file, including unchanged files, even when
    # reusing cache. A marker alone is not provenance for a locally modified tree.
    with tarfile.open(archive) as contents:
        for member in contents.getmembers():
            if not member.isfile():
                continue
            relative = str(Path(*Path(member.name).parts[1:]))
            if relative in LOCK['patched_files']:
                continue
            expected = hashlib.sha256(contents.extractfile(member).read()).hexdigest()
            verify(source / relative, expected)
    for relative, digest in LOCK['patched_files'].items():
        verify(source / relative, digest)

def download(url, path, digest):
    if path.exists() and sha(path) == digest:
        return
    temp = path.with_suffix(path.suffix + '.download')
    request = urllib.request.Request(url, headers={'User-Agent': 'Termdock-locked-Ghostty-build'})
    with urllib.request.urlopen(request, timeout=120) as response, temp.open('wb') as output:
        shutil.copyfileobj(response, output)
    verify(temp, digest)
    temp.replace(path)

def extract(archive, directory):
    with tarfile.open(archive) as source:
        source.extractall(directory, filter='data')
        roots = {Path(m.name).parts[0] for m in source.getmembers() if m.name}
    if len(roots) != 1:
        raise RuntimeError('archive must contain one root')
    return directory / next(iter(roots))

def notices(source, cache, prefix):
    # Include the full upstream MIT, font licenses, C/Zig dependency licenses
    # and notices from this build's isolated global cache, not just identifiers.
    paths = subprocess.check_output(['rg', '--files', '--hidden', str(source), str(cache / 'p')], text=True).splitlines()
    output = prefix / 'share' / 'termdock-ghostty' / 'licenses'
    output.mkdir(parents=True, exist_ok=True)
    index = []
    for path in sorted(paths):
        p = Path(path)
        if not re.match(r'^(LICENSE|LICENCE|NOTICE|COPYING|COPYRIGHT|OFL|AUTHORS|UNLICENSE)([._-].*)?$', p.name, re.I):
            continue
        if '.zig-cache' in p.parts:
            continue
        base = source if p.is_relative_to(source) else cache
        relative = str(p.relative_to(base))
        destination = output / ('source' if base == source else 'zig-cache') / relative
        destination.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(p, destination)
        index.append({'source': relative, 'sha256': sha(p), 'bundle_path': str(destination.relative_to(prefix))})
    (output / 'index.json').write_text(json.dumps(index, indent=2) + '\n')
    if not any(x['source'] == 'LICENSE' for x in index):
        raise RuntimeError('upstream MIT license missing')

# Zig 0.15.2 Darwin SDK detection resolves xcrun through PATH, not SDKROOT.
# Never map an iOS selector to a macOS SDK: missing iOS remains a real error.
XCRUN_DRIVER = """import os,sys
args=sys.argv[1:]
sdk=os.environ['TERMDOCK_GHOSTTY_SDK']
found=False
for i,arg in enumerate(args[:-1]):
    if arg in ('--sdk','-sdk'):
        found=True
        if args[i+1].startswith('macosx') or args[i+1]==sdk:
            args[i+1]=sdk
if not found:
    args=['--sdk',sdk]+args
os.execv('/usr/bin/xcrun',['/usr/bin/xcrun']+args)
"""

@contextmanager
def build_environment(sdk, cache):
    env = os.environ.copy()
    if sdk is None:
        yield env
        return
    sdk = sdk.expanduser().resolve(strict=True)
    if not sdk.is_dir() or not (sdk / 'usr/lib/libSystem.tbd').is_file():
        raise RuntimeError('--sdk must name an existing macOS SDK directory')
    with tempfile.TemporaryDirectory(prefix='sdk-xcrun-', dir=cache) as directory:
        wrapper = Path(directory) / 'xcrun'
        wrapper.write_text('#!/bin/sh\nexec ' + shlex.quote(sys.executable) +
                           ' -c ' + shlex.quote(XCRUN_DRIVER) + ' "$@"\n')
        wrapper.chmod(0o700)
        env['SDKROOT'] = str(sdk)
        env['TERMDOCK_GHOSTTY_SDK'] = str(sdk)
        env['PATH'] = directory + os.pathsep + env.get('PATH', '')
        yield env

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--cache', required=True, type=Path, help='outside repository')
    parser.add_argument('--prepare-only', action='store_true', help='verify and patch; no Mac access')
    parser.add_argument('--zig', type=Path, help='explicit pinned Zig binary; version checked')
    parser.add_argument('--sdk', type=Path, help='existing macOS SDK path; process-only xcrun/SDKROOT selection')
    parser.add_argument('--jobs', type=int, default=4)
    args = parser.parse_args()
    cache = args.cache.expanduser().resolve()
    repository = HERE.parents[2]
    if cache.is_relative_to(repository):
        raise RuntimeError('Ghostty caches/third-party sources may not live in the repository')
    cache.mkdir(parents=True, exist_ok=True)
    verify(HERE / 'ghostty.h', LOCK['header_sha256'])
    verify(HERE / 'termdock.patch', LOCK['patch_sha256'])
    verify(HERE / 'baseline-test.patch', LOCK['baseline_test_patch_sha256'])
    verify(HERE / 'build.zig.zon.lock', LOCK['build_zon_sha256'])
    archive = cache / 'source.tar.gz'
    download(LOCK['source_url'], archive, LOCK['source_sha256'])
    source_parent = cache / 'source'
    patch_digest = LOCK['patch_sha256']
    marker = source_parent / 'patch-digest'
    if not marker.exists() or marker.read_text() != patch_digest:
        if source_parent.exists():
            # Only our exact dedicated cache path, never an arbitrary source dir.
            shutil.rmtree(source_parent)
        source_parent.mkdir()
        source = extract(archive, source_parent)
        verify(source / 'include/ghostty.h', LOCK['header_sha256'])
        verify(source / 'src/renderer/shaders/shaders.metal', LOCK['shader_sha256'])
        for path, digest in LOCK['build_zon_files'].items():
            verify(source / path, digest)
        with (HERE / 'termdock.patch').open('rb') as patch:
            subprocess.run(['patch', '-p1', '--batch', '--fuzz=0'], cwd=source, stdin=patch, check=True)
        marker.write_text(patch_digest)
    else:
        roots = [p for p in source_parent.iterdir() if p.is_dir()]
        if len(roots) != 1:
            raise RuntimeError('invalid prepared cache')
        source = roots[0]
    verify_source(archive, source)
    print(f'Prepared {LOCK["revision"]} + patch {patch_digest} at {source}', flush=True)
    if args.prepare_only:
        return
    if platform.system() != 'Darwin' or platform.machine() not in ('arm64', 'aarch64'):
        raise RuntimeError('full Metal library build must run on the designated arm64 Mac operator')
    if args.jobs < 1 or args.jobs > 16:
        raise RuntimeError('jobs must be 1..16')
    if args.zig:
        zig = args.zig.expanduser().resolve()
    else:
        distribution = LOCK['zig_distributions']['aarch64-macos']
        zig_archive = cache / 'zig.tar.xz'
        download(distribution['tarball'], zig_archive, distribution['shasum'])
        toolchain = cache / 'toolchain'
        toolchain.mkdir(exist_ok=True)
        zig = extract(zig_archive, toolchain) / 'zig'
    if subprocess.check_output([str(zig), 'version'], text=True).strip() != LOCK['zig_version']:
        raise RuntimeError('Zig version must be exactly 0.15.2')
    prefix = cache / 'prefix'
    prefix.mkdir(exist_ok=True)
    global_cache = cache / 'zig-global'
    command = [str(zig), 'build', 'td-lib', '-Dtarget=' + LOCK['target'], '-Doptimize=' + LOCK['optimize'],
               '-Dapp-runtime=none', '-Drenderer=metal', '-Dfont-backend=coretext', '-Dsentry=false',
               '-Di18n=false', '-Demit-docs=false', '-Demit-xcframework=false', '-Demit-macos-app=false',
               '-Demit-exe=false', '-Dstrip=false', f'-j{args.jobs}', '--prefix', str(prefix),
               '--global-cache-dir', str(global_cache)]
    with build_environment(args.sdk, cache) as build_env:
        build_env["TERMDOCK_GHOSTTY_PYTHON"] = sys.executable
        sdk_path = Path(subprocess.check_output(
            ['xcrun', '--sdk', 'macosx', '--show-sdk-path'], env=build_env, text=True).strip()).resolve()
        sdk_version = subprocess.check_output(
            ['xcrun', '--sdk', 'macosx', '--show-sdk-version'], env=build_env, text=True).strip()
        if args.sdk and sdk_path != args.sdk.expanduser().resolve():
            raise RuntimeError('xcrun did not select the explicitly requested SDK')
        attempt = {
            'sdk': sdk_version, 'sdk_path': str(sdk_path),
            'sdk_selection': 'explicit-process-xcrun' if args.sdk else 'inherited-xcrun',
            'libsystem_tbd_sha256': sha(sdk_path / 'usr/lib/libSystem.tbd'),
            'sdk_settings_sha256': sha(sdk_path / 'SDKSettings.json') if (sdk_path / 'SDKSettings.json').is_file() else None,
            'zig_sha256': sha(zig), 'command': command,
        }
        # Retain the exact SDK even if Zig fails before it produces a library.
        (prefix / 'termdock-build-attempt.json').write_text(json.dumps(attempt, indent=2) + '\n')
        print(f'Build SDK {sdk_version}: {sdk_path} ({attempt["sdk_selection"]})', flush=True)
        print('Building full Ghostty core/font/Metal (default shader MSL runtime compile):', ' '.join(command), flush=True)
        subprocess.run(command, cwd=source, env=build_env, check=True)
        if not (prefix / 'lib/libghostty.a').is_file():
            raise RuntimeError('full static library not produced')
        verify(prefix / 'include/ghostty.h', LOCK['header_sha256'])
        archive_audit = prefix / 'share/termdock-ghostty/archive-members.json'
        audit = json.loads(archive_audit.read_text())
        if audit['library_sha256'] != sha(prefix / 'lib/libghostty.a') or audit['objects'] != len(audit['members']) or audit['objects'] == 0:
            raise RuntimeError('archive preservation audit does not match the installed library')
        notices(source, global_cache, prefix)
        (prefix / 'termdock-artifacts.json').write_text(json.dumps({
            **attempt, 'library_sha256': sha(prefix / 'lib/libghostty.a'),
            'archive_audit_sha256': sha(archive_audit), 'archive_objects': audit['objects'],
        }, indent=2) + '\n')
    (prefix / 'lib/libghostty.a.sha256').write_text(sha(prefix / 'lib/libghostty.a') + '\n')
    (prefix / 'termdock-build.json').write_text(LOCK_TEXT)
    print(f'TERMDOCK_GHOSTTY_PREFIX={prefix}', flush=True)
    print('Bundle prefix/share/termdock-ghostty/licenses with the final app; no font/source artifacts in Git.', flush=True)

if __name__ == '__main__':
    main()
