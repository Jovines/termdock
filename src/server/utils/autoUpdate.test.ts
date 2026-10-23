import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { pathToFileURL } from 'node:url';
import { resolveRunningTermdockInstallation, verifyRunningTermdockInstallation } from './npmUpdate.js';
import { TermdockAutoUpdateManager, TermdockUpdateStateChangedError, hasPendingTermdockUpdate } from './autoUpdate.js';

const previousConnected = Object.getOwnPropertyDescriptor(process, 'connected');
beforeEach(() => { vi.stubEnv('TERMDOCK_SUPERVISED', '1'); Object.defineProperty(process,'connected',{value:true,configurable:true}); });
afterEach(() => { vi.unstubAllEnvs(); if(previousConnected) Object.defineProperty(process,'connected',previousConnected); else Reflect.deleteProperty(process,'connected'); });
describe('TermdockAutoUpdateManager', () => {
  it('rejects stale reminders and confirmations for a different version without restarting', async () => {
    const requestRestart = vi.fn();
    const manager = new TermdockAutoUpdateManager({
      currentVersion: '1.4.350', stateFilePath: null, broadcast: vi.fn(), requestRestart,
      verifyInstalled: () => {},
      updateRunner: async () => ({ status: 'updated', currentVersion: '1.4.350', latestVersion: '1.4.351', source: 'official' }),
    });
    expect(() => manager.confirmRestart('1.4.351')).toThrow(TermdockUpdateStateChangedError);
    await manager.checkNow();
    expect(() => manager.confirmRestart('1.4.349')).toThrow(TermdockUpdateStateChangedError);
    expect(manager.getState().status).toBe('ready');
    expect(requestRestart).not.toHaveBeenCalled();
    manager.confirmRestart('1.4.351');
    expect(() => manager.confirmRestart('1.4.351')).toThrow(TermdockUpdateStateChangedError);
    expect(manager.getState().status).toBe('restarting');
    expect(requestRestart).toHaveBeenCalledOnce();
  });
  it('installs automatically but waits for confirmation while a web client is active', async () => {
    const broadcast = vi.fn();
    const requestRestart = vi.fn();
    const manager = new TermdockAutoUpdateManager({
      currentVersion: '1.4.68',
      stateFilePath: null,
      verifyInstalled: () => {},
      broadcast,
      requestRestart,
      updateRunner: async (_current, _fallback, onLatest) => {
        onLatest?.('1.4.69', 'official');
        return {
          status: 'updated',
          currentVersion: '1.4.68',
          latestVersion: '1.4.69',
          source: 'official',
        };
      },
    });

    const state = await manager.checkNow();
    expect(state.status).toBe('ready');
    expect(hasPendingTermdockUpdate(state)).toBe(true);
    expect(requestRestart).not.toHaveBeenCalled();
    expect(broadcast).toHaveBeenCalledWith(expect.objectContaining({ status: 'installing' }));

    await manager.checkNow();
    expect(requestRestart).not.toHaveBeenCalled();

    manager.confirmRestart();
    expect(requestRestart).toHaveBeenCalledOnce();
    expect(manager.getState().status).toBe('restarting');
  });

  it('never restarts without confirmation, even when no web client is active', async () => {
    const requestRestart = vi.fn();
    const manager = new TermdockAutoUpdateManager({
      currentVersion: '1.4.68',
      stateFilePath: null,
      verifyInstalled: () => {},
      broadcast: vi.fn(),
      requestRestart,
      updateRunner: async (_current, _fallback, onLatest) => {
        onLatest?.('1.4.69', 'configured');
        return {
          status: 'updated',
          currentVersion: '1.4.68',
          latestVersion: '1.4.69',
          source: 'configured',
        };
      },
    });

    expect((await manager.checkNow()).status).toBe('ready');
    expect(requestRestart).not.toHaveBeenCalled();

    manager.confirmRestart();
    expect(requestRestart).toHaveBeenCalledOnce();
  });

  it('does not expose an update marker when both registry queries fail before finding a version', async () => {
    const manager = new TermdockAutoUpdateManager({
      currentVersion: '1.4.68',
      stateFilePath: null,
      verifyInstalled: () => {},
      broadcast: vi.fn(),
      requestRestart: vi.fn(),
      updateRunner: async () => { throw new Error('registry unavailable'); },
    });

    const state = await manager.checkNow();
    expect(state.status).toBe('error');
    expect(state.latestVersion).toBeNull();
    expect(hasPendingTermdockUpdate(state)).toBe(false);
  });

  it('drops a persisted failed update whose version is already the running version', () => {
    const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'td-update-equal-state-'));
    try {
      const stateFilePath = path.join(temporary, 'update-state.json');
      fs.writeFileSync(stateFilePath, JSON.stringify({
        status: 'error', currentVersion: '1.4.322', latestVersion: '1.4.322',
        source: 'official', checkedAt: Date.now(), error: 'stale failure',
      }));
      const manager = new TermdockAutoUpdateManager({
        currentVersion: '1.4.322', stateFilePath, broadcast: vi.fn(), requestRestart: vi.fn(),
        updateRunner: async () => { throw new Error('must not run during construction'); },
      });
      expect(manager.getState()).toMatchObject({ status: 'idle', currentVersion: '1.4.322', latestVersion: null, error: null });
      expect(hasPendingTermdockUpdate(manager.getState())).toBe(false);
    } finally {
      fs.rmSync(temporary, { recursive: true, force: true });
    }
  });

  it('preserves a real newer-version install failure and recovers to ready on explicit retry', async () => {
    const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'td-update-retry-state-'));
    try {
      const stateFilePath = path.join(temporary, 'update-state.json');
      let failInstall = true;
      const requestRestart = vi.fn();
      const manager = new TermdockAutoUpdateManager({
        currentVersion: '1.4.321', stateFilePath, broadcast: vi.fn(), requestRestart,
        verifyInstalled: () => {},
        updateRunner: async (_current, _fallback, onLatest) => {
          onLatest?.('1.4.322', 'official');
          if (failInstall) throw new Error('controlled npm install failure');
          return { status: 'updated', currentVersion: '1.4.321', latestVersion: '1.4.322', source: 'official' };
        },
      });

      const failed = await manager.checkNow();
      expect(failed).toMatchObject({ status: 'error', currentVersion: '1.4.321', latestVersion: '1.4.322', error: 'controlled npm install failure' });
      expect(hasPendingTermdockUpdate(failed)).toBe(true);
      expect(JSON.parse(fs.readFileSync(stateFilePath, 'utf8'))).toMatchObject({ status: 'error', latestVersion: '1.4.322' });
      expect(requestRestart).not.toHaveBeenCalled();

      failInstall = false;
      const recovered = await manager.checkNow();
      expect(recovered).toMatchObject({ status: 'ready', currentVersion: '1.4.321', latestVersion: '1.4.322', error: null });
      expect(hasPendingTermdockUpdate(recovered)).toBe(true);
      expect(requestRestart).not.toHaveBeenCalled();
    } finally {
      fs.rmSync(temporary, { recursive: true, force: true });
    }
  });
});


describe('pending installation verification',()=>{
 it.each(['ready','restarting'] as const)('rejects stale %s without restart and repairs only on an explicit check',async(status)=>{
  const temporary=fs.mkdtempSync(path.join(os.tmpdir(),'td-update-state-'));
  try{
   const packageRoot=path.join(temporary,'prefix/lib/node_modules/termdock'),moduleFile=path.join(packageRoot,'dist/server/utils/npmUpdate.js'),entry=path.join(packageRoot,'dist/server/cli.js');
   fs.mkdirSync(path.dirname(moduleFile),{recursive:true});fs.writeFileSync(moduleFile,'');fs.writeFileSync(entry,'');
   const writeVersion=(version:string)=>fs.writeFileSync(path.join(packageRoot,'package.json'),JSON.stringify({name:'termdock',version}));writeVersion('1.4.318');
   const installation=resolveRunningTermdockInstallation(pathToFileURL(moduleFile).href,entry);
   const stateFilePath=path.join(temporary,'update-state.json');fs.writeFileSync(stateFilePath,JSON.stringify({status,currentVersion:'1.4.318',latestVersion:'1.4.319',source:'official'}));
   const restart=vi.fn(),broadcast=vi.fn();let runnerCalls=0;
   const manager=new TermdockAutoUpdateManager({currentVersion:'1.4.318',stateFilePath,broadcast,requestRestart:restart,verifyInstalled:version=>verifyRunningTermdockInstallation(version,installation),updateRunner:async()=>{runnerCalls++;writeVersion('1.4.319');return{status:'updated',currentVersion:'1.4.318',latestVersion:'1.4.319',source:'official'};}});
   expect(manager.getState()).toMatchObject({status:'error',latestVersion:'1.4.319',error:expect.stringContaining('not completed')});expect(()=>manager.confirmRestart()).toThrow();expect(restart).not.toHaveBeenCalled();
   await manager.checkNow(false);expect(runnerCalls).toBe(0);expect(manager.getState().status).toBe('error');
   expect((await manager.checkNow()).status).toBe('ready');expect(runnerCalls).toBe(1);expect(restart).not.toHaveBeenCalled();
   // A later external replacement is re-read; loaded/cached ready is insufficient.
   writeVersion('1.4.318');expect(()=>manager.confirmRestart()).toThrow(/not completed/);expect(manager.getState().status).toBe('error');expect(restart).not.toHaveBeenCalled();
   expect(JSON.parse(fs.readFileSync(stateFilePath,'utf8')).status).toBe('error');
   await manager.checkNow();manager.confirmRestart();expect(restart).toHaveBeenCalledOnce();
   expect(broadcast).toHaveBeenCalledWith(expect.objectContaining({status:'error'}));
  }finally{fs.rmSync(temporary,{recursive:true,force:true});}
 });
 it('does not mark an unverified install ready, cannot bypass supervision, and broadcasts a synchronous restart failure',async()=>{
  const restart=vi.fn(()=>{throw Error('controlled restart dispatch failure');});const additional=vi.fn();let installed=false;
  const manager=new TermdockAutoUpdateManager({currentVersion:'1.4.318',stateFilePath:null,broadcast:vi.fn(),requestRestart:restart,verifyInstalled:()=>{if(!installed)throw Error('missing installed version');},verifyRestartEntry:additional,updateRunner:async()=>({status:'updated',currentVersion:'1.4.318',latestVersion:'1.4.319',source:'official'})});
  expect((await manager.checkNow()).status).toBe('error');installed=true;await manager.checkNow();
  Object.defineProperty(process,'connected',{value:false,configurable:true});expect(()=>manager.confirmRestart()).toThrow(/supervised/);expect(additional).not.toHaveBeenCalled();expect(restart).not.toHaveBeenCalled();
  Object.defineProperty(process,'connected',{value:true,configurable:true});await manager.checkNow();expect(()=>manager.confirmRestart()).toThrow(/dispatch failure/);expect(manager.getState()).toMatchObject({status:'error',error:'controlled restart dispatch failure'});expect(restart).toHaveBeenCalledOnce();
 });
});
