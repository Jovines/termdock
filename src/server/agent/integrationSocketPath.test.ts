// @vitest-environment node
import { createServer, createConnection } from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import { expect, it } from 'vitest';
import { integrationSocketPath } from './integrationServer';

it('retains existing addresses but bounds long and multibyte home paths for real IPC', async () => {
  expect(integrationSocketPath(9834, '/Users/test')).toBe('/Users/test/.termdock/integration-9834.sock');
  const socket=integrationSocketPath(53219,`/long-${process.pid}/`+'目录'.repeat(80));
  expect(Buffer.byteLength(socket)).toBeLessThan(100);
  expect(integrationSocketPath(53219,'/other/'+'目录'.repeat(80))).not.toBe(socket);
  const directory=path.dirname(socket);fs.mkdirSync(directory,{mode:0o700});
  const server=createServer(peer=>peer.end('IPC_OK'));
  try {
    await new Promise<void>((resolve,reject)=>{server.once('error',reject);server.listen(socket,resolve);});
    const reply=await new Promise<string>((resolve,reject)=>{
      const peer=createConnection(socket);let text='';peer.on('data',chunk=>text+=chunk);peer.once('end',()=>resolve(text));peer.once('error',reject);
    });
    expect(reply).toBe('IPC_OK');
  } finally { await new Promise<void>(resolve=>server.close(()=>resolve()));fs.rmSync(directory,{recursive:true,force:true}); }
});
