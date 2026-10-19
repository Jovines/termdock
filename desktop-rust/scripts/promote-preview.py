#!/usr/bin/env python3
"""Promote an already notarized draft; no build keys or unverified binaries."""
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import tempfile


def require(condition, message):
    if not condition:
        raise ValueError(message)


def gh(*args):
    return subprocess.check_output(['gh', *args], timeout=180)


def api(path, *args):
    return json.loads(gh('api', path, *args))


def validate(base, release, version, revision, repo):
    prefix = f'Termdock-Preview_{version}_aarch64'
    names = {prefix+'.dmg', prefix+'.app.tar.gz', prefix+'.app.tar.gz.sig', 'preview.json', 'release.json'}
    require(release['tag_name'] == f'preview-v{version}' and release['prerelease'] and release['draft'], 'Expected a Preview draft')
    assets = {asset['name']: asset for asset in release['assets']}
    require(set(assets) == names, 'Unexpected release asset inventory')
    for name, asset in assets.items():
        data = (base/name).read_bytes()
        require(asset['state'] == 'uploaded' and asset['size'] == len(data) and asset['digest'] == 'sha256:'+hashlib.sha256(data).hexdigest(), f'GitHub digest mismatch: {name}')
    metadata = json.loads((base/'release.json').read_text())
    manifest = json.loads((base/'preview.json').read_text())
    require(metadata['revision'] == revision and metadata['version'] == version and metadata['tag'] == release['tag_name'], 'Source/version mismatch')
    require(metadata['prerelease'] is True and metadata['notarizationVerified'] is True, 'Notarization is not verified')
    require(metadata['config']['identifier'] == 'com.jovines.termdock.preview', 'Wrong product identity')
    for key in ['appNotarySubmission', 'dmgNotarySubmission']:
        require(re.fullmatch(r'[a-f0-9-]{36}', metadata.get(key, '')), 'Missing App/DMG notary receipt')
    for app in [metadata['verification'], metadata['verification']['dmgApp']]:
        require(app['version'] == version and app['bundle'] == 'com.jovines.termdock.preview' and app['architecture'] == 'arm64', 'Wrong verified App identity')
        require(all(app[key] is True for key in ['gatekeeperAccepted', 'notaryTicketValidated', 'updateTrustPinned']), 'Missing Mac acceptance record')
    records = {item['name']: item for item in metadata['artifacts']}
    require(set(records) == names-{'release.json'}, 'Unexpected local artifact inventory')
    for name, item in records.items():
        data = (base/name).read_bytes()
        require(item['size'] == len(data) and item['sha256'] == hashlib.sha256(data).hexdigest(), f'Local digest mismatch: {name}')
    root = f'https://github.com/{repo}/releases/download'
    require(metadata['endpoint'] == root+'/preview-channel/preview.json' and manifest['version'] == version, 'Wrong update channel')
    require(set(manifest['platforms']) == {'darwin-aarch64'}, 'Unsupported platform')
    platform = manifest['platforms']['darwin-aarch64']
    require(platform['url'] == f'{root}/{release["tag_name"]}/{prefix}.app.tar.gz', 'Wrong update URL')
    require(platform['signature'] == (base/(prefix+'.app.tar.gz.sig')).read_text().strip(), 'Signature mismatch')
    return manifest


def main():
    version, revision = os.environ['PREVIEW_VERSION'], os.environ['PREVIEW_REVISION']
    repo = os.environ['GITHUB_REPOSITORY']
    require(os.environ['GITHUB_REF'] == 'refs/heads/master', 'Publish only from master')
    require(re.fullmatch(r'(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)', version), 'Exact numeric version required')
    require(re.fullmatch(r'[a-f0-9]{40}', revision), 'Full source SHA required')
    tag = f'preview-v{version}'
    reference = api(f'repos/{repo}/git/ref/tags/{tag}')['object']
    for _ in range(5):
        if reference['type'] == 'commit':
            break
        require(reference['type'] == 'tag', 'Unexpected tag type')
        reference = api(f'repos/{repo}/git/tags/{reference["sha"]}')['object']
    require(reference['type'] == 'commit' and reference['sha'] == revision, 'Tag points at another source revision')
    pages = json.loads(gh('api', f'repos/{repo}/releases?per_page=100', '--paginate', '--slurp'))
    matches = [release for page in pages for release in page if release['tag_name'] == tag]
    require(len(matches) == 1, 'Expected one existing release draft')
    release = matches[0]
    with tempfile.TemporaryDirectory(prefix='preview-promote-') as directory:
        base = Path(directory)
        gh('release', 'download', tag, '--repo', repo, '--dir', directory)
        validate(base, release, version, revision, repo)
        # Prevent a stale manually dispatched job from rolling the channel back.
        channel = base/'channel'; channel.mkdir()
        gh('release', 'download', 'preview-channel', '--repo', repo, '--pattern', 'preview.json', '--dir', str(channel))
        current = json.loads((channel/'preview.json').read_text())['version']
        require(re.fullmatch(r'\d+\.\d+\.\d+', current), 'Invalid current channel version')
        require(tuple(map(int, version.split('.'))) > tuple(map(int, current.split('.'))), 'Refuse channel rollback or version overwrite')
        published = api(f'repos/{repo}/releases/{release["id"]}', '--method', 'PATCH', '-f', f'target_commitish={revision}', '-F', 'draft=false', '-F', 'prerelease=true', '-f', 'make_latest=false')
        require(published['target_commitish'] == revision and not published['draft'] and published['prerelease'], 'Published identity mismatch')
        gh('release', 'upload', 'preview-channel', str(base/'preview.json'), '--repo', repo, '--clobber')
        print(published['html_url'])


if __name__ == '__main__':
    main()
