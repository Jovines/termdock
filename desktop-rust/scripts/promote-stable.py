#!/usr/bin/env python3
"""Publish a notarized Rust draft, then move the stable updater pointer.

The legacy ZIP contains the fixed macOS 12 bridge; the Rust ZIP is consumed by
that bridge on macOS 14+. Preview's final bridge uses the same signed Tauri feed.
"""
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import tempfile

REPO = 'Jovines/termdock'

def require(condition, message):
    if not condition:
        raise ValueError(message)

def gh(*args):
    return subprocess.check_output(['gh', *args], timeout=180)

def api(path, *args):
    return json.loads(gh('api', path, *args))

def validate(base, release, version, revision):
    prefix = f'Termdock_{version}_aarch64'
    names = {prefix+'.dmg', prefix+'.app.tar.gz', prefix+'.app.tar.gz.sig', 'latest.json', 'release.json',
             f'Termdock-Rust-darwin-arm64-{version}.zip', f'Termdock-darwin-arm64-{version}.zip'}
    require(release['tag_name']==f'v{version}' and release['draft'] and not release['prerelease'], 'Expected a stable draft')
    assets={a['name']:a for a in release['assets']}
    require(set(assets)==names, 'Wrong release asset inventory')
    metadata=json.loads((base/'release.json').read_text())
    require(metadata['version']==version and metadata['tag']==f'v{version}' and metadata['revision']==revision, 'Source/version mismatch')
    require(metadata['notarizationVerified'] is True and metadata['prerelease'] is False, 'Stable notarization missing')
    require(metadata['config']['identifier']=='com.jovines.termdock' and metadata['config']['productName']=='Termdock', 'Wrong product identity')
    root=f'https://github.com/{REPO}/releases/download'
    require(metadata['endpoint']==root+'/stable-channel/latest.json', 'Wrong stable endpoint')
    for key in ['appNotarySubmission','dmgNotarySubmission']:
        require(re.fullmatch(r'[a-f0-9-]{36}',metadata.get(key,'')), 'Missing App/DMG notary receipt')
    for app in [metadata['verification'],metadata['verification']['dmgApp'],metadata['verification']['rustZipApp']]:
        require(app['version']==version and app['bundle']=='com.jovines.termdock' and app['minimumMacOS']=='14.0' and app['architecture']=='arm64', 'Wrong verified identity/platform')
        require(all(app[k] is True for k in ['gatekeeperAccepted','notaryTicketValidated','updateTrustPinned']), 'Missing Mac verification')
    bridge=metadata['verification']['legacyBridge']
    require(bridge['version']=='1.4.357' and bridge['minimumMacOS']=='12.0' and bridge['gatekeeperAccepted'] and bridge['notaryTicketValidated'], 'Missing compatibility bridge verification')
    records={a['name']:a for a in metadata['artifacts']}
    require(set(records)==names-{'release.json'}, 'Wrong artifact records')
    for name,asset in assets.items():
        data=(base/name).read_bytes(); digest=hashlib.sha256(data).hexdigest()
        require(asset['state']=='uploaded' and asset['size']==len(data) and asset['digest']=='sha256:'+digest, 'GitHub digest mismatch: '+name)
        if name in records:
            require(records[name]['size']==len(data) and records[name]['sha256']==digest, 'Local digest mismatch: '+name)
    manifest=json.loads((base/'latest.json').read_text())
    require(manifest['version']==version and set(manifest['platforms'])=={'darwin-aarch64'}, 'Wrong updater platform/version')
    platform=manifest['platforms']['darwin-aarch64']
    require(platform['url']==f'{root}/v{version}/{prefix}.app.tar.gz' and platform['signature']==(base/(prefix+'.app.tar.gz.sig')).read_text().strip(), 'Wrong signed updater asset')
    return manifest

def commit_for_tag(tag):
    obj=api(f'repos/{REPO}/git/ref/tags/{tag}')['object']
    for _ in range(5):
        if obj['type']=='commit': return obj['sha']
        require(obj['type']=='tag','Invalid tag object')
        obj=api(f'repos/{REPO}/git/tags/{obj["sha"]}')['object']
    raise ValueError('Tag did not resolve to a commit')

def main():
    version,revision=os.environ['STABLE_VERSION'],os.environ['STABLE_REVISION']
    require(re.fullmatch(r'(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)',version),'Exact version required')
    require(re.fullmatch(r'[a-f0-9]{40}',revision),'Exact source SHA required')
    tag='v'+version
    require(commit_for_tag(tag)==revision,'Tag/source mismatch')
    pages=json.loads(gh('api',f'repos/{REPO}/releases?per_page=100','--paginate','--slurp'))
    releases=[r for page in pages for r in page]
    matches=[r for r in releases if r['tag_name']==tag]
    require(len(matches)==1,'Expected one release draft')
    release=matches[0]
    with tempfile.TemporaryDirectory(prefix='stable-promote-') as directory:
        base=Path(directory)
        gh('release','download',tag,'--repo',REPO,'--dir',directory)
        validate(base,release,version,revision)
        channels=[r for r in releases if r['tag_name']=='stable-channel']
        if channels:
            current_dir=base/'current';current_dir.mkdir()
            gh('release','download','stable-channel','--repo',REPO,'--pattern','latest.json','--dir',str(current_dir))
            current=json.loads((current_dir/'latest.json').read_text())['version']
            require(tuple(map(int,version.split('.')))>tuple(map(int,current.split('.'))),'Refuse stable channel rollback/overwrite')
        published=api(f'repos/{REPO}/releases/{release["id"]}','--method','PATCH','-F','draft=false','-F','prerelease=false','-f','make_latest=true')
        require(not published['draft'] and not published['prerelease'] and commit_for_tag(tag)==revision,'Published source/state mismatch')
        if not channels:
            gh('release','create','stable-channel','--repo',REPO,'--target',revision,'--prerelease','--latest=false','--title','Termdock stable update channel','--notes','Signed Rust update manifest. Versioned binaries live in stable releases.')
        gh('release','upload','stable-channel',str(base/'latest.json'),'--repo',REPO,'--clobber')
        require(api(f'repos/{REPO}/releases/latest')['tag_name']==tag,'Latest release mismatch')
        print(published['html_url'])

if __name__=='__main__':
    main()
