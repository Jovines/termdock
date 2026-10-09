import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { CollaborationStore } from './collaborationStore.js';
import { collaborationGroupRoutes } from './collaborationGroupRoutes.js';
import { completedExecution, ExecutionArchiveStore, type ExecutionArchive } from './executionArchives.js';
import { ensureTeam } from './collaborationTeam.js';
import type { CollaborationTask } from './collaborationTaskTypes.js';
let dir: string;
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'termdock-lifecycle-')); });
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));
it('creates an empty project over HTTP and retains it and discussions after the last terminal leaves', async () => {
 const store = new CollaborationStore(path.join(dir,'groups.json'));
 const app = express(); app.use(express.json()); app.use(collaborationGroupRoutes({store,sessions:()=>[{sessionId:'a'},{sessionId:'b'}]}));
 const server = app.listen(0,'127.0.0.1'); await new Promise<void>(done=>server.once('listening',done));
 const url = `http://127.0.0.1:${(server.address() as {port:number}).port}/collaboration-groups`;
 try {
  const response=await fetch(url,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({name:'Project',sessionIds:[]})});
  expect(response.status).toBe(200);const {group}=await response.json();
  store.save({...group,sessionIds:['a','b']});store.send({groupId:group.id,fromSessionId:'a',toSessionIds:['b'],kind:'message',content:'Result remains'});
  store.removeSession('a'); store.removeSession('b');
  const restarted = new CollaborationStore(path.join(dir,'groups.json'));
  expect(restarted.getGroup(group.id)?.sessionIds).toEqual([]);expect(restarted.listMessages(group.id)).toHaveLength(1);
 } finally { await new Promise<void>((done,reject)=>server.close(error=>error?reject(error):done())); }
});
it('moving the last member keeps the project and history',()=>{
 const store=new CollaborationStore(path.join(dir,'groups.json'));const a=store.save({name:'A',sessionIds:['a']}),b=store.save({name:'B',sessionIds:[]});
 store.moveMember({sourceGroupId:a.id,targetGroupId:b.id,sessionId:'a',expectedSourceUpdatedAt:a.updatedAt,expectedTargetUpdatedAt:b.updatedAt});
 expect(store.getGroup(a.id)?.sessionIds).toEqual([]);expect(store.getGroup(b.id)?.sessionIds).toEqual(['a']);
});
it('retries a partially provisioned team without duplicating the first member',async()=>{
 const members: Array<{id:string;role:string;cwd:string}> = [];let calls=0,fail=true;
 const options={members:()=>members,agentSlug:'codex',cwd:'/project',spawn:async(role:string)=>{calls++;if(role.startsWith('自动执行')&&fail){fail=false;throw Error('startup failed')}const id='member-'+members.length;members.push({id,role,cwd:'/project'});return id;}};
 await expect(ensureTeam(options)).rejects.toThrow('startup failed');expect(members).toHaveLength(1);
 const team=await ensureTeam(options);expect(team).toEqual({coordinatorSessionId:'member-0',reviewerSessionIds:['member-1']});
 expect(await ensureTeam(options)).toEqual(team);expect(calls).toBe(3);
 await expect(ensureTeam({...options,cwd:'/another'})).rejects.toThrow('原 Agent 和目录');expect(calls).toBe(3);
});
it('reuses existing agents, but does not assign one session to both roles',async()=>{
 const ids=await ensureTeam({members:()=>[{id:'lead',cwd:'/project',agentSlug:'codex'},{id:'worker',cwd:'/project',agentSlug:'codex'}],cwd:'/project',agentSlug:'codex',spawn:async()=>{throw Error('unexpected launch')}});
 expect(ids).toEqual({coordinatorSessionId:'lead',reviewerSessionIds:['worker']});
});
const archive=(i=0):ExecutionArchive=>({sessionId:'terminal-'+i,title:'Task',agent:{slug:'codex',sessionId:'actual-native-'+i,launchArgv:['codex','--model','test-model'],updatedAt:1},cwd:'/workspace',groups:[{id:'project'}],taskIds:['task'],workspace:{cwd:'/workspace',repository:'/repo',branch:'branch',base:'base'},archivedAt:1,cleanup:{state:'pending',commit:'commit'}});
it('keeps exact native conversation and launch arguments beyond the recent-history limit and across restarts',()=>{
 const file=path.join(dir,'archives.json');const store=new ExecutionArchiveStore(file);
 for(let i=0;i<45;i++)store.save(archive(i));
 const restarted=new ExecutionArchiveStore(file);expect(restarted.list()).toHaveLength(45);expect(restarted.get('terminal-0')?.agent).toEqual(archive().agent);
 const copy=restarted.get('terminal-0')!;copy.agent.sessionId='changed';expect(restarted.get('terminal-0')?.agent.sessionId).toBe('actual-native-0');
});
it('rejects archives without a real native ID and refuses to overwrite a corrupt archive file',()=>{
 const file=path.join(dir,'archives.json'),store=new ExecutionArchiveStore(file);expect(()=>store.save({...archive(),agent:{...archive().agent,sessionId:null}})).toThrow('原生会话 ID');
 fs.writeFileSync(file,'invalid');expect(()=>new ExecutionArchiveStore(file)).toThrow();expect(fs.readFileSync(file,'utf8')).toBe('invalid');
});
it('only archives completed isolated workers and protects active tasks, reviewers and coordinators',()=>{
 const member={serviceId:'local',sessionId:'worker'};
 const task={status:'accepted',workspace:archive().workspace,workflow:{kind:'step',isolated:true,reviewers:[]},attempts:[{id:'attempt',assignee:member}],activeAttemptId:'attempt',coordinator:null} as unknown as CollaborationTask;
 expect(completedExecution([task],'local','worker')).toEqual([task]);
 for(const protectedTask of [{...task,status:'open'},{...task,coordinator:member},{...task,workflow:{...task.workflow,reviewers:[member]}},{...task,workspace:undefined}]) expect(()=>completedExecution([protectedTask as CollaborationTask],'local','worker')).toThrow();
 expect(()=>completedExecution([task],'another','worker')).toThrow();
});
