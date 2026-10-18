// @vitest-environment node
import { expect, it, vi } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import { isConfirmedEmptyTmuxServer } from './tmuxEmptyServerProbe';
const exec = promisify(execFile);
it('accepts only exit 1 exact no-current-target with a nonempty target and a successful empty listing',async()=>{
 const run=vi.fn(async()=> '');
 expect(await isConfirmedEmptyTmuxServer({code:1,stderr:'no current target\n'},'owned',run)).toBe(true);
 expect(run).toHaveBeenCalledWith(['list-sessions','-F','#{session_id}']);
 for(const [error,target]of [[{code:1,stderr:'no current target'},' '],[{code:2,stderr:'no current target'},'owned'],[{code:1,stderr:'permission denied'},'owned'],[{code:1,stderr:'no current target\nother error'},'owned']]){
  run.mockClear();expect(await isConfirmedEmptyTmuxServer(error,target as string,run)).toBe(false);expect(run).not.toHaveBeenCalled();
 }
 expect(await isConfirmedEmptyTmuxServer({code:1,stderr:'no current target'},'owned',async()=>'$0\n')).toBe(false);
 expect(await isConfirmedEmptyTmuxServer({code:1,stderr:'no current target'},'owned',async()=>{throw Error('read failed');})).toBe(false);
});
it('recognizes a real live empty tmux server and permits a subsequent owned session creation',async()=>{
 const socket='td-empty-regression-'+randomUUID(),env={...process.env};delete env.TMUX;
 const run=async(args:string[])=>(await exec('tmux',['-L',socket,'-f','/dev/null',...args],{env,timeout:5000})).stdout;
 try{
  await run(['new-session','-d','-s','owned-seed','/bin/sleep 30']);await run(['set-option','-g','exit-empty','off']);
  let missing:unknown;try{await run(['has-session','-t','=owned-missing']);}catch(error){missing=error;}
  expect(await isConfirmedEmptyTmuxServer(missing,'owned-missing',run)).toBe(false);
  await run(['kill-session','-t','=owned-seed']);
  let empty:unknown;try{await run(['has-session','-t','=owned-missing']);}catch(error){empty=error;}
  expect(await isConfirmedEmptyTmuxServer(empty,'owned-missing',run)).toBe(true);
  await run(['new-session','-d','-s','owned-created','/bin/sleep 30']);await expect(run(['has-session','-t','=owned-created'])).resolves.toBe('');
 }finally{await run(['kill-server']).catch(()=>{});}
});
