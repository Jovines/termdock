// @vitest-environment jsdom
import React from 'react';
import { cleanup, render, waitFor } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import { createServer } from 'node:http';
import { once } from 'node:events';
import express from 'express';
import { createReactTerminalFixture } from './react-terminal-fixture';
import { FilePreview } from '../../src/lib/components/sidebar/RightSidebar';
import { I18nProvider } from '../../src/lib/i18n';
import { useSidebarStore } from '../../src/lib/stores/useSidebarStore';
import { clearPreviewResourceCache } from '../../src/lib/utils/previewResourceCache';

it('actual FilePreview renders owned content through the production cache URL and exact fixture route',async()=>{
 const model=createReactTerminalFixture({interactions:true,authorized:req=>req.header('x-owned-test')==='yes'}),app=express();model.install(app);
 const server=createServer(app);server.listen(0,'127.0.0.1');await once(server,'listening');const origin=`http://127.0.0.1:${(server.address() as {port:number}).port}`;
 const originalFetch=globalThis.fetch,state=useSidebarStore.getState(),requests:URL[]=[];
 vi.stubGlobal('fetch',async(input:string|URL|Request,init?:RequestInit)=>{
  const requested=new URL(String(input),origin);if(requested.pathname!=='/api/terminal/fs/read')return new Response('{}',{headers:{'Content-Type':'application/json'}});
  requests.push(requested);const headers=new Headers(init?.headers);headers.set('x-owned-test','yes');
  return originalFetch(origin+requested.pathname+requested.search,{...init,headers});
 });
 try{
  clearPreviewResourceCache();useSidebarStore.setState({rootPath:'/controlled'});
  const view=render(<I18nProvider><FilePreview filePath="/controlled/owned.txt" isMobile={false} onInsertReference={()=>{}} onInsertText={()=>{}} onReferenceCopied={()=>{}} markdownOutlineOpen={false} markdownImageLightboxOpen={false} lineRange={null} onLineRangeChange={()=>{}} insertedReferenceKey={null} copiedReferenceKey={null}/></I18nProvider>);
  await waitFor(()=>expect(view.container.querySelector('[data-file-preview-line]')?.textContent).toContain('Owned file preview'));
  expect(requests).toHaveLength(1);expect(requests[0].searchParams.get('path')).toBe('/controlled/owned.txt');expect(requests[0].searchParams.has('action')).toBe(false);expect(requests[0].searchParams.has('requestSlotId')).toBe(false);
  expect(model.inspect().events.filter(event=>event.type==='controlled-file-read')).toEqual([expect.objectContaining({encrypted:true,owned:true,pathMatches:true,actionAbsent:true,realFilesystem:false})]);
 }finally{cleanup();clearPreviewResourceCache();useSidebarStore.setState(state);vi.unstubAllGlobals();server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));}
});
