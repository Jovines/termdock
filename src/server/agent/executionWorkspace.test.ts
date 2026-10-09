import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
const state=vi.hoisted(()=>({home:''}));
vi.mock('node:os',async(original)=>{const real=await original<typeof import('node:os')>();return {...real,default:{...real,homedir:()=>state.home},homedir:()=>state.home};});
const exec=promisify(execFile);const git=async(cwd:string,args:string[])=> (await exec('git',['-C',cwd,...args])).stdout.trim();
let dir:string,workspace:import('./collaborationTaskTypes').TaskWorkspace;
let archive:typeof import('./collaborationTaskWorkspace').archiveTaskWorkspace,restore:typeof import('./collaborationTaskWorkspace').restoreTaskWorkspace;
beforeEach(async()=>{
 dir=await fs.mkdtemp(path.join(os.tmpdir(),'termdock-execution-'));state.home=dir;vi.resetModules();({archiveTaskWorkspace:archive,restoreTaskWorkspace:restore}=await import('./collaborationTaskWorkspace'));
 const repo=path.join(dir,'repo');await fs.mkdir(repo);await git(repo,['init']);await git(repo,['config','user.email','test@example.local']);await git(repo,['config','user.name','Test']);await fs.writeFile(path.join(repo,'file'),'original');await fs.writeFile(path.join(repo,'.gitignore'),'ignored\n');await git(repo,['add','file','.gitignore']);await git(repo,['commit','-m','base']);
 const branch='termdock/task/'+'a'.repeat(32)+'-'+'b'.repeat(8);const cwd=path.join(dir,'.termdock/task-workspaces','goal','worker');await fs.mkdir(path.dirname(cwd),{recursive:true});await git(repo,['worktree','add','-b',branch,cwd]);workspace={cwd,repository:repo,branch,base:await git(repo,['rev-parse','HEAD'])};
});
afterEach(async()=>{await fs.rm(dir,{recursive:true,force:true});vi.resetModules();});
it('reclaims a clean execution directory and rebuilds its exact branch and commit',async()=>{
 const result=await archive(workspace);expect(result).toEqual({state:'removed',commit:workspace.base});await expect(fs.stat(workspace.cwd)).rejects.toMatchObject({code:'ENOENT'});
 expect(await git(workspace.repository,['rev-parse',workspace.branch])).toBe(workspace.base);await restore(workspace,result);expect(await git(workspace.cwd,['rev-parse','HEAD'])).toBe(workspace.base);expect(await fs.readFile(path.join(workspace.cwd,'file'),'utf8')).toBe('original');
});
it.each(['file','untracked','ignored'])('retains %s data and resumes using the same directory',async filename=>{
 await fs.writeFile(path.join(workspace.cwd,filename),'keep me');const result=await archive(workspace);expect(result.state).toBe('retained');await restore(workspace,result);expect(await fs.readFile(path.join(workspace.cwd,filename),'utf8')).toBe('keep me');
});
it('refuses to remove a foreign checkout or reset a changed archive branch',async()=>{
 expect((await archive({...workspace,cwd:workspace.repository})).state).toBe('retained');expect(await fs.readFile(path.join(workspace.repository,'file'),'utf8')).toBe('original');
 const result=await archive(workspace);await fs.writeFile(path.join(workspace.repository,'file'),'new user work');await git(workspace.repository,['commit','-am','another commit']);await git(workspace.repository,['branch','-f',workspace.branch,'HEAD']);
 await expect(restore(workspace,result)).rejects.toThrow('不会重置');expect(await git(workspace.repository,['rev-parse',workspace.branch])).toBe(await git(workspace.repository,['rev-parse','HEAD']));
});
it('restores an interrupted pending cleanup from its saved commit',async()=>{
 const result=await archive(workspace);await restore(workspace,{...result,state:'pending'});expect(await git(workspace.cwd,['rev-parse','HEAD'])).toBe(workspace.base);
});

it('reuses a restored directory after further work without resetting it',async()=>{
 const result=await archive(workspace);await restore(workspace,result);
 await fs.writeFile(path.join(workspace.cwd,'file'),'further work');await git(workspace.cwd,['commit','-am','continue']);const updated=await git(workspace.cwd,['rev-parse','HEAD']);
 await restore(workspace,result);expect(await git(workspace.cwd,['rev-parse','HEAD'])).toBe(updated);expect(await fs.readFile(path.join(workspace.cwd,'file'),'utf8')).toBe('further work');
});
