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
    require(info['CFBundleIdentifier'] == 'com.jovines.termdock.preview'
            and info['CFBundleShortVersionString'] == metadata['version']
            and info['LSMinimumSystemVersion'] == '14.0', 'Wrong App identity/version/minimum OS')
    binary = app/'Contents/MacOS'/info['CFBundleExecutable']
    require(run('lipo', '-archs', str(binary)).strip() == 'arm64', 'Expected arm64 App')
    require(re.findall(r'\bminos\s+(\S+)', run('xcrun', 'vtool', '-show-build', str(binary))) == ['14.0'], 'Wrong Mach-O minimum OS')
    raw = binary.read_bytes()
    require(public_key.encode() in raw and metadata['endpoint'].encode() in raw, 'Updater trust is not pinned')
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
    dmg = out/f'Termdock-Preview_{metadata["version"]}_aarch64.dmg'
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
            result['dmgApp'] = verify_app(mount/'Termdock Preview.app', metadata, public)
        finally:
            run('hdiutil', 'detach', str(mount), '-quiet')
        archive = out/f'Termdock-Preview_{metadata["version"]}_aarch64.app.tar.gz'
        extracted = Path(temporary)/'archive'; extracted.mkdir()
        run('tar', '-xzf', str(archive), '-C', str(extracted))
        verify_app(extracted/'Termdock Preview.app', metadata, public)
    metadata.update(notarizationVerified=True, appNotarySubmission=receipts[0],
                    dmgNotarySubmission=receipt['id'], verification=result)
    for record in metadata['artifacts']:
        data = (out/record['name']).read_bytes()
        record.update(size=len(data), sha256=hashlib.sha256(data).hexdigest())
    (out/'release.json').write_text(json.dumps(metadata, indent=2)+'\n')
    print('App, updater archive and DMG signatures, notarization, Gatekeeper and embedded source verified')


if __name__ == '__main__':
    main()
