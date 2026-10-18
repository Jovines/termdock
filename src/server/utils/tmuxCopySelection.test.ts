import { test } from 'vitest';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { copyTmuxSelection, TMUX_COPY_MAX_BYTES } from './tmuxCopySelection';
const exec=promisify(execFile);
function model(options:{mode?:boolean;selection?:boolean;large?:boolean;changed?:boolean;readFailure?:boolean;cleanupFailure?:boolean}={}){
 const calls:string[][]=[];let prefix='',states=0;
 const run=async(args:string[],limit?:{maxBuffer:number})=>{
  calls.push(args);
  if(args[0]==='display-message'){states++;return `$1\t%${options.changed&&states>1?2:1}\t${options.mode===false?0:1}\t${options.selection===false?0:1}\n`;}
  if(args[0]==='send-keys'){assert.equal(args[4],'copy-selection-no-clear');prefix=args[5];return '';}
  if(args[0]==='list-buffers'){assert(args.includes('-f'));return `${prefix}0\t${options.large?TMUX_COPY_MAX_BYTES+1:5}\n`;}
  if(args[0]==='save-buffer'){assert.equal(limit?.maxBuffer,TMUX_COPY_MAX_BYTES+1);if(options.readFailure)throw Error('owned read failed');return 'owned';}
  if(args[0]==='delete-buffer'){assert.equal(args[2],prefix+'0');if(options.cleanupFailure)throw Error('owned cleanup failed');return '';}
  throw Error('unexpected command');
 };return{run,calls};
}
test('bounded current selection is read from the uniquely filtered buffer and cleaned',async()=>{const m=model();assert.deepEqual(await copyTmuxSelection('owned',m.run),{status:'copied',paneId:'%1',text:'owned',bytes:5});assert.equal(m.calls[0][2],'=owned:');assert.equal(m.calls.at(-1)?.[0],'delete-buffer');});
for(const options of [{mode:false},{selection:false}])test('no current selection does not read an old global buffer '+JSON.stringify(options),async()=>{const m=model(options);assert.equal((await copyTmuxSelection('owned',m.run)).status,'empty');assert.equal(m.calls.length,1);});
for(const options of [{large:true},{changed:true},{readFailure:true},{cleanupFailure:true}])test('copy rejects without truncation/success and cleans only its own buffer '+JSON.stringify(options),async()=>{const m=model(options);await assert.rejects(copyTmuxSelection('owned',m.run));assert.equal(m.calls.at(-1)?.[0],'delete-buffer');if(options.large)assert(!m.calls.some(args=>args[0]==='save-buffer'));});
test('real isolated tmux preserves exact pane, selection and unrelated buffers',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'termdock-copy-owned-')),socket=join(dir,'socket');
 const run=async(args:string[],options?:{maxBuffer:number})=>(await exec('tmux',['-S',socket,'-f','/dev/null',...args],{maxBuffer:options?.maxBuffer??1024*1024,timeout:3000})).stdout;
 try{
  await run(['new-session','-d','-s','owned','/bin/sleep 120']);
  const pane=(await run(['display-message','-t','=owned:','-p','#{pane_id}'])).trim();
  await run(['set-buffer','-b','unrelated','old unrelated']);
  assert.equal((await copyTmuxSelection('owned',run)).status,'empty');
  await run(['respawn-pane','-k','-t',pane,"printf 'owned alpha\\nowned beta\\n'; exec /bin/sleep 120"]);
  const end=Date.now()+2000;while(!(await run(['capture-pane','-t',pane,'-p'])).includes('owned beta')){assert(Date.now()<end);await new Promise(resolve=>setImmediate(resolve));}
  await run(['set-window-option','-t','=owned:','mode-keys','emacs']);
  for(const command of ['history-top','start-of-line','begin-selection']){if(command==='history-top')await run(['copy-mode','-t',pane]);await run(['send-keys','-t',pane,'-X',command]);}
  await run(['send-keys','-t',pane,'-X','-N','5','cursor-right']);
  const result=await copyTmuxSelection('owned',run);assert.equal(result.text,'owned');assert.equal(result.paneId,pane);
  assert.equal((await run(['display-message','-t',pane,'-p','#{pane_in_mode}:#{selection_present}'])).trim(),'1:1');
  assert.equal(await run(['save-buffer','-b','unrelated','-']),'old unrelated');
  assert(!(await run(['list-buffers','-F','#{buffer_name}'])).includes('termdock-copy-'));
  await run(['new-session','-d','-s','other','/bin/sleep 120']);assert.equal((await copyTmuxSelection('other',run)).status,'empty');
  const otherPane=(await run(['split-window','-h','-t','=owned:','-P','-F','#{pane_id}','/bin/sleep 120'])).trim();
  const otherSelected=await copyTmuxSelection('owned',run);assert.equal(otherSelected.status,'empty');assert.equal(otherSelected.paneId,otherPane);assert.equal((await run(['display-message','-t',pane,'-p','#{pane_in_mode}'])).trim(),'1');
 }finally{await run(['kill-session','-t','=other']).catch(()=>{});await run(['kill-session','-t','=owned']).catch(()=>{});await rm(dir,{recursive:true,force:true});}
});

test('metadata failure still enumerates only its UUID buffers, attempts every delete and preserves the primary failure',async()=>{
 let prefix='',lists=0;const deleted:string[]=[],primary=new Error('metadata failed');
 const run=async(args:string[])=>{
  if(args[0]==='display-message')return '$1\t%1\t1\t1\n';
  if(args[0]==='send-keys'){prefix=args[5];return '';}
  if(args[0]==='list-buffers'){assert.equal(args[2],`#{m:${prefix}*,#{buffer_name}}`);if(++lists===1)throw primary;return `${prefix}0\t5\n${prefix}1\t5\nunrelated\t5\n`;}
  if(args[0]==='delete-buffer'){assert(args[2].startsWith(prefix));deleted.push(args[2]);if(deleted.length===1)throw Error('first cleanup failed');return '';}
  throw Error('unexpected command');
 };
 await assert.rejects(copyTmuxSelection('owned',run),error=>error===primary);assert.equal(lists,2);assert.equal(deleted.length,2);assert(deleted.every(name=>name.startsWith(prefix)));assert(primary.cause instanceof AggregateError);assert.equal(primary.cause.errors.length,2);
});
test('real oversized selection rejects without truncating and removes only its own buffer',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'termdock-copy-large-owned-')),socket=join(dir,'socket');
 const run=async(args:string[],options?:{maxBuffer:number})=>(await exec('tmux',['-S',socket,'-f','/dev/null',...args],{maxBuffer:options?.maxBuffer??1024*1024,timeout:3000})).stdout;
 try{
  await run(['new-session','-d','-s','bootstrap','/bin/sleep','120']);
  await run(['set-option','-g','history-limit','20000']);await run(['set-buffer','-b','unrelated','preserve']);
  await run(['new-session','-d','-s','large','/usr/bin/python3','-c',"import time; print(('owned-'+('q'*80)+'\\n')*4000, flush=True); print('OWNED-END', flush=True); time.sleep(120)"]);
  const pane=(await run(['display-message','-t','=large:','-p','#{pane_id}'])).trim();
  const end=Date.now()+5000;while(!(await run(['capture-pane','-t',pane,'-p'])).includes('OWNED-END')){assert(Date.now()<end);await new Promise(resolve=>setImmediate(resolve));}
  await run(['copy-mode','-t',pane]);for(const command of ['history-top','start-of-line','begin-selection','history-bottom','end-of-line'])await run(['send-keys','-t',pane,'-X',command]);
  await assert.rejects(copyTmuxSelection('large',run),/256 KiB/);
  assert.equal((await run(['display-message','-t',pane,'-p','#{pane_in_mode}:#{selection_present}'])).trim(),'1:1');
  assert.equal(await run(['save-buffer','-b','unrelated','-']),'preserve');assert(!(await run(['list-buffers','-F','#{buffer_name}'])).includes('termdock-copy-'));
  await assert.rejects(copyTmuxSelection('not-an-owned-session',run));
 }finally{await run(['kill-session','-t','=large']).catch(()=>{});await run(['kill-session','-t','=bootstrap']).catch(()=>{});await rm(dir,{recursive:true,force:true});}
});
