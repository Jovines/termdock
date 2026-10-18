import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {normalizeWorkspaceWorker} from './workspace-sw.mjs';
const root=new URL('../../',import.meta.url);
const source=new URL('../../dist/client/',import.meta.url);
const destination=new URL('../.workspace-dist/',import.meta.url);
if(!fs.existsSync(new URL('index.html',source))) throw new Error('Build the existing React client before preparing Preview workspace assets');
let revision=process.env.TERMDOCK_PREVIEW_SOURCE_REVISION,dirty=false,diffHash=null;
try {
 revision ||= execFileSync('git',['rev-parse','HEAD'],{cwd:root,encoding:'utf8'}).trim();
 const diff=execFileSync('git',['diff','HEAD','--','src','public','vite.config.ts','desktop','desktop-rust'],{cwd:root});
 dirty=diff.length>0 || execFileSync('git',['status','--porcelain','--','src','public','vite.config.ts','desktop','desktop-rust'],{cwd:root,encoding:'utf8'}).trim().length>0;diffHash=dirty?crypto.createHash('sha256').update(diff).digest('hex'):null;
} catch { if(!revision) throw new Error('An archive build needs TERMDOCK_PREVIEW_SOURCE_REVISION set to its exact source commit'); }
if(!/^[a-f0-9]{40}$/.test(revision)) throw new Error('Invalid Preview source revision');
if(process.argv.includes('--require-clean')&&dirty) throw new Error('Package Preview from a clean task commit/archive; keep unfinished WIP out of the package');
fs.rmSync(destination,{recursive:true,force:true});fs.mkdirSync(destination,{recursive:true});
const files={};
function copy(directory,prefix='') {
 for(const entry of fs.readdirSync(directory,{withFileTypes:true})) {
  if(entry.isSymbolicLink()) throw new Error('Workspace resources cannot contain symlinks');
  const name=prefix+entry.name;
  if(entry.isDirectory()) {copy(path.join(directory,entry.name),name+'/');continue;}
  if(!entry.isFile()||/\.(?:map|br|gz)$/.test(name)) continue;
  const bytes=fs.readFileSync(path.join(directory,entry.name));
  const target=new URL(name,destination);fs.mkdirSync(new URL('.',target),{recursive:true});fs.writeFileSync(target,bytes);
  files[name]={size:bytes.length,sha256:crypto.createHash('sha256').update(bytes).digest('hex')};
 }
}
copy(source.pathname);
// The existing server normally supplies these public compression resources
// from @ffmpeg/core. Include the same pinned package files in Preview too.
for(const name of ['ffmpeg-core.js','ffmpeg-core.wasm']) {
 const bytes=fs.readFileSync(new URL(`node_modules/@ffmpeg/core/dist/esm/${name}`,root));
 const key=`assets/video-compression/v2/${name}`;const target=new URL(key,destination);
 fs.mkdirSync(new URL('.',target),{recursive:true});fs.writeFileSync(target,bytes);
 files[key]={size:bytes.length,sha256:crypto.createHash('sha256').update(bytes).digest('hex')};
}
const workerPath=new URL('sw.js',destination);
const worker=normalizeWorkspaceWorker(fs.readFileSync(workerPath,'utf8'),Object.keys(files),fs.readFileSync(new URL('vite.config.ts',root),'utf8'));
const workerBytes=Buffer.from(worker.script);fs.writeFileSync(workerPath,workerBytes);
files['sw.js']={size:workerBytes.length,sha256:crypto.createHash('sha256').update(workerBytes).digest('hex')};
if(worker.removedCaseVariants.length)process.stdout.write(`Preview SW retained source cold-loading policy; omitted case variants: ${worker.removedCaseVariants.join(', ')}\n`);
fs.writeFileSync(new URL('workspace-manifest.json',destination),JSON.stringify({version:1,sourceRevision:revision,dirty,sourceDiffSha256:diffHash,clientVersion:JSON.parse(fs.readFileSync(new URL('package.json',root),'utf8')).version,files},null,2)+'\n');
