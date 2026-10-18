import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ list: vi.fn(), target: { targetPeerId: 'A', url: 'https://a.example' } }));
vi.mock('../terminal/api', () => ({ listCollaborationTasks: mocks.list }));
vi.mock('../federation/browserIntegration', () => ({ savedConnection: () => mocks.target }));

import { useCollaborationTaskInbox } from './useCollaborationTaskInbox';

beforeEach(() => {
  vi.clearAllMocks();
  mocks.target = { targetPeerId: 'A', url: 'https://a.example' };
  useCollaborationTaskInbox.setState({ tasks: [], allTasks: [], error: null });
});

describe('collaboration task inbox request ownership', () => {
  it('aborts and ignores an older target response', async () => {
    const requests: Array<{ signal: AbortSignal; resolve: (value: { tasks: never[] }) => void }> = [];
    mocks.list.mockImplementation((_group: undefined, signal: AbortSignal) => new Promise(resolve => requests.push({ signal, resolve })));

    const oldRefresh = useCollaborationTaskInbox.getState().refresh();
    mocks.target = { targetPeerId: 'B', url: 'https://b.example' };
    const currentRefresh = useCollaborationTaskInbox.getState().refresh();
    expect(requests).toHaveLength(2);
    expect(requests[0].signal.aborted).toBe(true);

    requests[0].resolve({ tasks: [] });
    requests[1].resolve({ tasks: [] });
    await Promise.all([oldRefresh, currentRefresh]);
    expect(useCollaborationTaskInbox.getState().error).toBeNull();
    expect(mocks.list).toHaveBeenNthCalledWith(1, undefined, expect.any(AbortSignal));
    expect(mocks.list).toHaveBeenNthCalledWith(2, undefined, expect.any(AbortSignal));
  });

  it('keeps a final secure-read failure visible and allows a later refresh to recover', async () => {
    const error = Object.assign(new Error('Unexpected EOF - stream closed while reading 0/1 bytes'), { name: 'UnexpectedEOFError' });
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    mocks.list.mockRejectedValueOnce(error)
      .mockResolvedValueOnce({ tasks: [] });

    await useCollaborationTaskInbox.getState().refresh();
    expect(useCollaborationTaskInbox.getState().error).toBe('连接中断，待处理事项暂时无法加载；恢复后会自动重试。');
    expect(log).toHaveBeenCalledWith('[CollaborationTaskInbox] refresh failed', error);
    await useCollaborationTaskInbox.getState().refresh();
    expect(useCollaborationTaskInbox.getState().error).toBeNull();
    expect(mocks.list).toHaveBeenCalledTimes(2);
    log.mockRestore();
  });
});

for(const late of ['resolve','reject'] as const)it(`clears published A tasks while B loads or fails, rejecting late A ${late}`,async()=>{
 const log=vi.spyOn(console,'error').mockImplementation(()=>{});
 const task={id:'owned-A',status:'open',purpose:'task',decisions:[{status:'pending'}]};
 mocks.list.mockResolvedValueOnce({tasks:[task]});await useCollaborationTaskInbox.getState().refresh();
 expect(useCollaborationTaskInbox.getState().tasks).toHaveLength(1);
 let finishA!:(value:any)=>void,failA!:(error:Error)=>void,failB!:(error:Error)=>void;
 mocks.list.mockImplementationOnce(()=>new Promise((resolve,reject)=>{finishA=resolve;failA=reject;}));
 const old=useCollaborationTaskInbox.getState().refresh();
 mocks.target={targetPeerId:'B',url:'https://b.example'};
 mocks.list.mockImplementationOnce(()=>new Promise((_resolve,reject)=>{failB=reject;}));
 const current=useCollaborationTaskInbox.getState().refresh();
 expect(useCollaborationTaskInbox.getState()).toMatchObject({tasks:[],allTasks:[],error:null});
 if(late==='resolve')finishA({tasks:[task]});else failA(Error('old A failure'));
 await old;expect(useCollaborationTaskInbox.getState()).toMatchObject({tasks:[],allTasks:[],error:null});
 failB(Error('B unavailable'));await current;
 expect(useCollaborationTaskInbox.getState()).toMatchObject({tasks:[],allTasks:[],error:'B unavailable'});log.mockRestore();
});
