// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
const state = vi.hoisted(() => ({ target: { url: 'https://remote.test', targetPeerId: 'C' } }));
vi.mock('../federation/clientScope', () => ({ selectedTarget: () => state.target }));
const upload = vi.hoisted(() => vi.fn());
vi.mock('../terminal/api', () => ({ uploadFiles: upload }));
import { canUseLocalDroppedPaths, installEncryptedFileDrops } from './encryptedFileDrops';

afterEach(() => { vi.useRealTimers(); document.body.replaceChildren(); upload.mockReset(); state.target = { url: 'https://remote.test', targetPeerId: 'C' }; });
it('only preserves original paths for the same local service, never a relay target behind localhost', () => {
  const target = { url: 'https://localhost:9834', targetPeerId: 'B' };
  expect(canUseLocalDroppedPaths(target.url, target)).toBe(true);
  expect(canUseLocalDroppedPaths(target.url, { ...target, serviceOrigin: 'https://remote.test' })).toBe(false);
  expect(canUseLocalDroppedPaths(target.url, { ...target, targetPeerId: 'C', routes: [{ url: target.url, targetPeerId: 'B' }] })).toBe(false);
  expect(canUseLocalDroppedPaths(target.url, null)).toBe(false);
});
it('uploads a remote drop in the renderer before the legacy preload can transmit it', async () => {
  const zone = document.createElement('div'); zone.dataset.termdockTerminalDropzone = 'session-C'; document.body.append(zone);
  const delivered = vi.fn(), legacy = vi.fn();
  document.addEventListener('drop', legacy, true);
  const dispose = installEncryptedFileDrops(delivered);
  upload.mockResolvedValue({ files: [{ path: '/tmp/uploaded.txt' }] });
  const file = new File(['private bytes'], 'original.txt');
  const event = new Event('drop', { bubbles: true, cancelable: true });
  Object.defineProperty(event, 'dataTransfer', { value: { files: [file] } });
  zone.dispatchEvent(event);
  await vi.waitFor(() => expect(delivered).toHaveBeenCalledWith({ sessionKey: 'session-C', paths: ['/tmp/uploaded.txt'] }));
  expect(upload).toHaveBeenCalledWith('/tmp', [file], expect.any(AbortSignal), expect.any(Function), expect.any(Function)); expect(legacy).not.toHaveBeenCalled();
  dispose(); document.removeEventListener('drop', legacy, true);
});

it('ignores an older drop failure and its timer after a newer operation takes ownership', async () => {
  vi.useFakeTimers();
  const zone = document.createElement('div'); zone.dataset.termdockTerminalDropzone = 'session-C'; document.body.append(zone);
  const delivered = vi.fn(), dispose = installEncryptedFileDrops(delivered), errors: string[] = [];
  zone.addEventListener('termdock:file-drop-error', event => errors.push(String((event as CustomEvent).detail)));
  const pending: Array<{ reject: (error: Error) => void; resolve: (value: any) => void }> = [];
  upload.mockImplementation(() => new Promise((resolve, reject) => pending.push({ resolve, reject })));
  const drop = () => {
    const event = new Event('drop', { bubbles: true, cancelable: true });
    Object.defineProperty(event, 'dataTransfer', { value: { files: [new File(['x'], 'x.txt')] } });
    zone.dispatchEvent(event);
  };
  drop();
  await vi.waitFor(() => expect(pending).toHaveLength(1));
  pending[0].reject(new Error('first failure'));
  await vi.waitFor(() => expect(errors).toEqual(['first failure']));
  drop();
  await vi.waitFor(() => expect(pending).toHaveLength(2));
  expect(zone.dataset.nativeFileDropState).toBe('uploading');
  await vi.advanceTimersByTimeAsync(3000);
  expect(zone.dataset.nativeFileDropState).toBe('uploading');
  pending[1].reject(new Error('second failure'));
  await vi.waitFor(() => expect(errors).toEqual(['first failure', 'second failure']));
  expect(zone.dataset.nativeFileDropState).toBe('error');
  dispose();
});

it('does not deliver a successful upload after its selected target changes', async () => {
  const zone = document.createElement('div'); zone.dataset.termdockTerminalDropzone = 'session-C'; document.body.append(zone);
  const delivered = vi.fn(), dispose = installEncryptedFileDrops(delivered);
  let resolve!: (value: any) => void;
  upload.mockImplementation(() => new Promise(value => { resolve = value; }));
  const event = new Event('drop', { bubbles: true, cancelable: true });
  Object.defineProperty(event, 'dataTransfer', { value: { files: [new File(['x'], 'x.txt')] } });
  zone.dispatchEvent(event);
  await vi.waitFor(() => expect(resolve).toBeTypeOf('function'));
  state.target = { url: 'https://other.test', targetPeerId: 'D' };
  resolve({ files: [{ path: '/tmp/stale.txt' }] });
  await Promise.resolve(); await Promise.resolve();
  expect(delivered).not.toHaveBeenCalled();
  dispose();
});

it('does not let an older successful drop clear a newer drop or deliver its paths', async () => {
  const zone = document.createElement('div'); zone.dataset.termdockTerminalDropzone = 'session-C'; document.body.append(zone);
  const delivered = vi.fn(), dispose = installEncryptedFileDrops(delivered);
  const pending: Array<(value: any) => void> = [];
  upload.mockImplementation(() => new Promise(resolve => pending.push(resolve)));
  const drop = () => {
    const event = new Event('drop', { bubbles: true, cancelable: true });
    Object.defineProperty(event, 'dataTransfer', { value: { files: [new File(['x'], 'x.txt')] } });
    zone.dispatchEvent(event);
  };
  drop(); await vi.waitFor(() => expect(pending).toHaveLength(1));
  drop(); await vi.waitFor(() => expect(pending).toHaveLength(2));
  pending[0]({ files: [{ path: '/tmp/old.txt' }] });
  await Promise.resolve(); await Promise.resolve();
  expect(delivered).not.toHaveBeenCalled();
  expect(zone.dataset.nativeFileDropState).toBe('uploading');
  pending[1]({ files: [{ path: '/tmp/new.txt' }] });
  await vi.waitFor(() => expect(delivered).toHaveBeenCalledWith({ sessionKey: 'session-C', paths: ['/tmp/new.txt'] }));
  expect(delivered).toHaveBeenCalledWith({ sessionKey: 'session-C', paths: ['/tmp/new.txt'] });
  expect(zone.dataset.nativeFileDropState).toBe('uploaded');
  dispose();
});

it('a backend rebound within the same terminal element cannot receive an old upload',async()=>{
 const zone=document.createElement('div');zone.dataset.termdockTerminalDropzone='session-C';zone.dataset.termdockTerminalOwner='backend-old:1';document.body.append(zone);
 const delivered=vi.fn(),dispose=installEncryptedFileDrops(delivered);let resolve!:(v:any)=>void;upload.mockImplementation(()=>new Promise(r=>{resolve=r;}));
 const event=new Event('drop',{bubbles:true,cancelable:true});Object.defineProperty(event,'dataTransfer',{value:{files:[new File(['x'],'owned.txt')]}});zone.dispatchEvent(event);
 await vi.waitFor(()=>expect(resolve).toBeTypeOf('function'));zone.dataset.termdockTerminalOwner='backend-new:2';resolve({files:[{path:'/tmp/old'}]});await Promise.resolve();await Promise.resolve();expect(delivered).not.toHaveBeenCalled();dispose();
});

it('target change before dynamic import completes never invokes upload',async()=>{
 const zone=document.createElement('div');zone.dataset.termdockTerminalDropzone='old';document.body.append(zone);const dispose=installEncryptedFileDrops(vi.fn());
 const event=new Event('drop',{bubbles:true,cancelable:true});Object.defineProperty(event,'dataTransfer',{value:{files:[new File(['private'],'owned.txt')]}});zone.dispatchEvent(event);
 state.target={url:'https://changed.test',targetPeerId:'new'};window.dispatchEvent(new Event('termdock:secure-state'));await Promise.resolve();await Promise.resolve();expect(upload).not.toHaveBeenCalled();dispose();
});
it('a real secure target change aborts an already-started encrypted drop upload',async()=>{
 const zone=document.createElement('div');zone.dataset.termdockTerminalDropzone='old';document.body.append(zone);const dispose=installEncryptedFileDrops(vi.fn());let signal:AbortSignal|undefined;upload.mockImplementation((_dir,_files,value)=>{signal=value;return new Promise((_resolve,reject)=>signal!.addEventListener('abort',()=>reject(new DOMException('aborted','AbortError'))));});
 const event=new Event('drop',{bubbles:true,cancelable:true});Object.defineProperty(event,'dataTransfer',{value:{files:[new File(['private'],'owned.txt')]}});zone.dispatchEvent(event);await vi.waitFor(()=>expect(signal).toBeDefined());
 state.target={url:'https://changed.test',targetPeerId:'new'};window.dispatchEvent(new Event('termdock:secure-state'));expect(signal!.aborted).toBe(true);await Promise.resolve();dispose();
});
it('reports encrypted upload progress and cancels without inserting paths',async()=>{
 const zone=document.createElement('div');zone.dataset.termdockTerminalDropzone='view';document.body.append(zone);
 let signal:AbortSignal|undefined;upload.mockImplementation((_dir,_files,value,progress)=>{signal=value;progress(37);return new Promise((_resolve,reject)=>value.addEventListener('abort',()=>reject(new DOMException('cancelled','AbortError'))));});
 const deliver=vi.fn(),dispose=installEncryptedFileDrops(deliver);
 const event=new Event('drop',{bubbles:true,cancelable:true});Object.defineProperty(event,'dataTransfer',{value:{files:[new File(['test'],'test.txt')]}});zone.dispatchEvent(event);
 await vi.waitFor(()=>expect(zone.dataset.nativeFileDropProgress).toBe('37'));
 zone.dispatchEvent(new CustomEvent('termdock:file-drop-cancel',{bubbles:true}));
 await vi.waitFor(()=>expect(signal?.aborted).toBe(true));expect(deliver).not.toHaveBeenCalled();expect(zone.dataset.nativeFileDropState).toBe('cancelled');dispose();
});
