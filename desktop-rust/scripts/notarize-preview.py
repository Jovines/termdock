#!/usr/bin/env python3
"""Finish an existing Tauri Developer ID build; never install or restart services."""
import hashlib
import json
import os
from pathlib import Path
import plistlib
import re
import subprocess
import sys
import tempfile


def run(*args):
    return subprocess.check_output(args, stderr=subprocess.STDOUT, text=True)


def require(value, message):
    if not value:
        raise ValueError(message)


def verify_app(app, metadata, public_key):
    run('codesign', '--verify', '--deep', '--strict', str(app))
    signature = run('codesign', '-dv', '--verbose=4', str(app))
    require('Authority='+os.environ['APPLE_SIGNING_IDENTITY'] in signature
            and 'Timestamp=' in signature and 'runtime' in signature, 'Invalid release signature')
    info = plistlib.loads((app/'Contents/Info.plist').read_bytes())
    require(info['CFBundleIdentifier'] == metadata['config']['identifier']
            and info['CFBundleShortVersionString'] == metadata['version']
            and info['LSMinimumSystemVersion'] == '14.0', 'Wrong App identity/version/minimum OS')
    binary = app/'Contents/MacOS'/info['CFBundleExecutable']
    require(run('lipo', '-archs', str(binary)).strip() == 'arm64', 'Expected arm64 App')
    require(re.findall(r'\bminos\s+(\S+)', run('xcrun', 'vtool', '-show-build', str(binary))) == ['14.0'], 'Wrong Mach-O minimum OS')
    raw = binary.read_bytes()
    require(public_key.encode() in raw and b'https://github.com/Jovines/termdock/releases/download/stable-channel/latest.json' in raw, 'Updater trust is not pinned')
    require(not (app/'Contents/Resources/native-terminal').exists() and b'ghostty_surface_new' not in raw, 'Unexpected native terminal resource')
    resources = app/'Contents/Resources/workspace'
    manifest = json.loads((resources/'workspace-manifest.json').read_text())
    require(manifest['sourceRevision'] == metadata['revision'] and not manifest['dirty'], 'Wrong embedded source revision')
    for name, record in manifest['files'].items():
        target = (resources/name).resolve()
        require(target.is_relative_to(resources.resolve()), 'Invalid workspace resource path')
        data = target.read_bytes()
        require(len(data) == record['size'] and hashlib.sha256(data).hexdigest() == record['sha256'], 'Workspace resource digest mismatch')
    run('xcrun', 'stapler', 'validate', str(app))
    require('accepted' in run('spctl', '-a', '-vv', '-t', 'exec', str(app)), 'App Gatekeeper rejection')
    return dict(bundle=info['CFBundleIdentifier'], version=metadata['version'], architecture='arm64',
                minimumMacOS='14.0', resourceCount=len(manifest['files']), gatekeeperAccepted=True,
                notaryTicketValidated=True, updateTrustPinned=True)


def main():
    require(sys.platform == 'darwin', 'Notarization verification requires macOS')
    out, app, log = map(Path, sys.argv[1:])
    metadata = json.loads((out/'release.json').read_text())
    require(metadata['revision'] == os.environ['GITHUB_SHA'], 'Build source mismatch')
    public = os.environ['TERMDOCK_PREVIEW_UPDATE_PUBLIC_KEY'].strip()
    result = verify_app(app, metadata, public)
    receipts = re.findall(r'Accepted for id ([a-f0-9-]{36})', log.read_text())
    require(len(receipts) == 1, 'Expected one accepted Tauri App notarization receipt')
    prefix = ('Termdock-Preview' if metadata['prerelease'] else 'Termdock')+f'_{metadata["version"]}_aarch64'
    product = metadata['config']['productName']+'.app'
    dmg = out/(prefix+'.dmg')
    receipt = json.loads(run('xcrun', 'notarytool', 'submit', str(dmg), '--key', os.environ['APPLE_API_KEY_PATH'],
                             '--key-id', os.environ['APPLE_API_KEY'], '--issuer', os.environ['APPLE_API_ISSUER'],
                             '--wait', '--output-format', 'json'))
    require(receipt['status'] == 'Accepted', 'DMG notarization was not accepted')
    run('xcrun', 'stapler', 'staple', str(dmg))
    run('xcrun', 'stapler', 'validate', str(dmg))
    require('accepted' in run('spctl', '-a', '-vv', '-t', 'open', '--context', 'context:primary-signature', str(dmg)), 'DMG Gatekeeper rejection')
    with tempfile.TemporaryDirectory(prefix='preview-verify-') as temporary:
        mount = Path(temporary)/'mount'; mount.mkdir()
        run('hdiutil', 'attach', str(dmg), '-nobrowse', '-readonly', '-mountpoint', str(mount), '-quiet')
        try:
            result['dmgApp'] = verify_app(mount/product, metadata, public)
        finally:
            run('hdiutil', 'detach', str(mount), '-quiet')
        archive = out/(prefix+'.app.tar.gz')
        extracted = Path(temporary)/'archive'; extracted.mkdir()
        run('tar', '-xzf', str(archive), '-C', str(extracted))
        verify_app(extracted/product, metadata, public)
        if not metadata['prerelease']:
            rust_zip = out/f'Termdock-Rust-darwin-arm64-{metadata["version"]}.zip'
            zipped = Path(temporary)/'rust-zip'; zipped.mkdir()
            run('ditto', '-x', '-k', str(rust_zip), str(zipped))
            result['rustZipApp'] = verify_app(zipped/product, metadata, public)
            bridge_zip = out/f'Termdock-darwin-arm64-{metadata["version"]}.zip'
            bridge_root = Path(temporary)/'bridge'; bridge_root.mkdir()
            run('ditto', '-x', '-k', str(bridge_zip), str(bridge_root))
            bridge = bridge_root/'Termdock.app'
            run('codesign', '--verify', '--deep', '--strict', str(bridge))
            bridge_signature = run('codesign', '-dv', '--verbose=4', str(bridge))
            require('Authority='+os.environ['APPLE_SIGNING_IDENTITY'] in bridge_signature and 'Timestamp=' in bridge_signature and 'runtime' in bridge_signature, 'Bridge signing identity mismatch')
            bridge_info = plistlib.loads((bridge/'Contents/Info.plist').read_bytes())
            require(bridge_info['CFBundleIdentifier']=='com.jovines.termdock' and bridge_info['CFBundleShortVersionString']=='1.4.357' and bridge_info['LSMinimumSystemVersion']=='12.0', 'Wrong compatibility bridge')
            for binary in [bridge/'Contents/MacOS'/bridge_info['CFBundleExecutable'], bridge/'Contents/Frameworks/Electron Framework.framework/Versions/A/Electron Framework']:
                require(re.findall(r'\bminos\s+(\S+)', run('xcrun','vtool','-show-build',str(binary)))==['12.0'], 'Bridge does not support macOS 12')
            asar = (bridge/'Contents/Resources/app.asar').read_bytes()
            require(b'Termdock-Rust-' in asar and b'minimumSystemVersion' in asar and b'14' in asar, 'Bridge migration logic missing')
            run('xcrun','stapler','validate',str(bridge))
            require('accepted' in run('spctl','-a','-vv','-t','exec',str(bridge)), 'Bridge Gatekeeper rejection')
            result['legacyBridge'] = dict(version='1.4.357', minimumMacOS='12.0', gatekeeperAccepted=True, notaryTicketValidated=True)

    metadata.update(notarizationVerified=True, appNotarySubmission=receipts[0],
                    dmgNotarySubmission=receipt['id'], verification=result)
    for record in metadata['artifacts']:
        data = (out/record['name']).read_bytes()
        record.update(size=len(data), sha256=hashlib.sha256(data).hexdigest())
    (out/'release.json').write_text(json.dumps(metadata, indent=2)+'\n')
    print('App, updater archive and DMG signatures, notarization, Gatekeeper and embedded source verified')


if __name__ == '__main__':
    main()
