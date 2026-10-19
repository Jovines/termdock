(() => {
  'use strict';
  const boot = window.__TD_PREVIEW_BOOT__;
  if (!boot || window !== window.top || location.origin !== boot.origin) return;
  const invoke = (op, args = {}) => window.__TAURI_INTERNALS__.invoke('preview_dispatch', { op, args });
  // Bounded startup diagnostics contain fixed categories only, never URLs,
  // identities, credentials, request bodies or terminal contents.
  if (!boot.local) {
    let observations = 0;
    const report = category => { if (observations++ < 24) void invoke('startupObservation', {category}).catch(()=>{}); };
    if (typeof indexedDB !== 'undefined') {
      const open = indexedDB.open.bind(indexedDB);
      indexedDB.open = (...args) => {
        const request = open(...args);
        if(args[0]==='termdock-device-identity'){
          report('identity-open');
          for(const name of ['success','error','blocked'])request.addEventListener(name,()=>report('identity-'+name),{once:true});
        }
        return request;
      };
    }
    const originalError=console.error.bind(console);
    console.error=(...args)=>{originalError(...args);if(args[0]==='Terminal error caught by boundary:')report('react-error');};
    const debug = console.debug?.bind(console) || (()=>{});
    console.debug = (...args) => {
      debug(...args);
      if (args[0] !== '[connection] retry') return;
      const reason = String(args[1]?.reason || '');
      const categories = [
        ['identity', /identity|身份|peer.*mismatch/i], ['authorization', /unauthor|permission|denied|授权|pairing/i],
        ['timeout', /timeout|timed out|超时/i], ['socket', /socket|closed|handshake/i],
        ['bootstrap', /auth status|open service|parameters|不可用/i], ['network', /fetch|network|load failed|连不上/i],
        ['route', /route|路由|中转/i], ['crypto', /crypto|secure context|subtle/i],
      ];
      report('retry-' + (categories.find(([,pattern])=>pattern.test(reason))?.[0] || 'other'));
    };
    window.addEventListener('error', event=>report(event.target?.tagName==='SCRIPT'?'script-load-error':'script-error'),true);
    window.addEventListener('unhandledrejection',()=>report('unhandled-rejection'));
    window.addEventListener('DOMContentLoaded', ()=>{
      report('document-loaded');
      window.setTimeout?.(()=>{
        report(document.querySelector('.xterm')?'terminal-mounted':'terminal-absent');
        report(document.hidden?'document-hidden':'document-visible');
        const label=document.querySelector('[data-startup-status]')?.textContent;
        report(label==='Loading Termdock'?'status-loading':label==='Preparing terminal engine'?'status-engine':'status-other');
        report(document.getElementById('root')?.childNodes.length?'root-mounted':'root-empty');
        if(document.querySelector('input[type=password]'))report('login-visible');
        if(document.querySelector('[data-termdock-terminal-dropzone]'))report('native-mounted');
      },5000);
    },{once:true});
  }
  const normalizeOpenRejection = reason => {
    const detail = typeof reason === 'string' ? reason : reason?.message || String(reason);
    console.error('[Termdock Preview] openConnection rejected:', detail);
    if (/cannot discover service/i.test(detail)) return {code:'PREVIEW_DISCOVERY_FAILED',message:'暂时无法连接服务。请检查地址、网络或证书指纹后重试。'};
    if (/certificate|\bcert\b|\btls\b|unknownissuer|pinned target identity|fingerprint/i.test(detail)) return {code:'PREVIEW_CERTIFICATE_REJECTED',message:'无法验证服务证书或身份。请核对服务地址和已保存的证书指纹。'};
    if (/\b401\b|\b403\b|unauthori[sz]ed|forbidden|authorization denied|password required|invitation (?:does not match|identity does not match|invalid)/i.test(detail)) return {code:'PREVIEW_AUTHORIZATION_REJECTED',message:'服务拒绝或无法验证此次授权。请检查邀请、服务权限或密码。'};
    return {code:'PREVIEW_OPEN_FAILED',message:'暂时无法打开服务，请检查地址和网络后重试。'};
  };
  // Private diagnostic tap, absent in normal launches. It never gates a drag.
  let ownedChrome = null, chromePageIndex = 0, chromeRequestIndex = 0, chromeObservations = [], chromeObservationScheduled = false;
  let documentEpoch = null;
  window.addEventListener('termdock:window-document-epoch', event => {
    const value = event.detail?.epoch;
    if (typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) documentEpoch = value;
  });
  if (boot.ownedWindowChrome === true) window.addEventListener('termdock:owned-window-chrome', event => {
    const value = event.detail;
    if (!Number.isSafeInteger(value?.ownerGeneration) || value.ownerGeneration < 1 || !Number.isSafeInteger(value.documentGeneration) || value.documentGeneration < 0) return;
    if (ownedChrome && (value.ownerGeneration < ownedChrome.ownerGeneration || (value.ownerGeneration === ownedChrome.ownerGeneration && value.documentGeneration <= ownedChrome.documentGeneration))) return;
    ownedChrome = {ownerGeneration:value.ownerGeneration,documentGeneration:value.documentGeneration};chromePageIndex=0;chromeRequestIndex=0;chromeObservations=[];
  });
  function observeChrome(phase, fields, stamp=ownedChrome) {
    if (!stamp || boot.ownedWindowChrome !== true || chromePageIndex >= 32 || !ownedChrome || stamp.ownerGeneration !== ownedChrome.ownerGeneration || stamp.documentGeneration !== ownedChrome.documentGeneration) return;
    try {
      const index=++chromePageIndex;
      const payload=index===32 ? {...stamp,index,phase:'budget'} : {...stamp,index,phase,...fields};
      chromeObservations.push(payload);
      if (!chromeObservationScheduled) {
        chromeObservationScheduled=true;
        // Send diagnostic IPC after the original synchronous drag invocation.
        queueMicrotask(()=>{
          chromeObservationScheduled=false;const batch=chromeObservations;chromeObservations=[];
          for(const value of batch) {
            if (!ownedChrome || value.ownerGeneration!==ownedChrome.ownerGeneration || value.documentGeneration!==ownedChrome.documentGeneration) continue;
            try { void invoke('windowChromeObservation',value).catch(()=>{}); } catch {}
          }
        });
      }
    } catch { /* Failed diagnostics must not change product behavior. */ }
  }
  const subscribe = (event, callback) => {
    const listener = value => callback(value.detail);
    window.addEventListener(event, listener);
    return () => window.removeEventListener(event, listener);
  };
  if (!boot.local) {
  const originalFetch = window.fetch.bind(window);
  const OriginalSocket = window.WebSocket;
  const bootstrap = new Set(['/api/meta', '/api/auth/status', '/api/auth/open/parameters', '/api/auth/password/parameters', '/api/auth/password/start', '/api/auth/password/finish']);
  const socketPaths = new Set(['/api/federation/secure', '/api/federation/relay']);
  function route(raw, paths, socket = false) {
    const url = new URL(raw, location.origin);
    const origin = url.protocol === 'wss:' ? `https://${url.host}` : url.protocol === 'ws:' ? `http://${url.host}` : url.origin;
    if (!paths.has(url.pathname) || url.username || url.password) throw new TypeError('Preview only transports public discovery and encrypted sockets');
    const index = origin === location.origin ? boot.defaultRoute : boot.origins.indexOf(origin);
    if (index < 0) throw new TypeError('This service window has no route to that origin');
    if (url.pathname !== '/api/federation/relay' && url.search) throw new TypeError('Unexpected discovery query');
    return `${socket ? location.origin.replace('http:', 'ws:') : location.origin}/__td_route/${index}${url.pathname}${url.search}`;
  }
  // The page captures this transport before installing encrypted fetch. There
  // is no upload implementation and no fallback to ordinary business HTTP.
  window.fetch = function(input, init) {
    const raw = input instanceof Request ? input.url : String(input);
    const url = new URL(raw, location.origin);
    if (bootstrap.has(url.pathname)) {
      const method = (init?.method || (input instanceof Request ? input.method : 'GET')).toUpperCase();
      const opaque = ['/api/auth/password/start', '/api/auth/password/finish'].includes(url.pathname);
      if (method !== (opaque ? 'POST' : 'GET')) return Promise.reject(new TypeError('Invalid bootstrap method'));
      const body = opaque ? init?.body : undefined;
      if (opaque && (typeof body !== 'string' || body.length > 65536)) return Promise.reject(new TypeError('Invalid OPAQUE bootstrap body'));
      let destination;
      try { destination = route(url.href, bootstrap); } catch (error) { return Promise.reject(error); }
      // Drop ambient credentials and arbitrary request headers. Cancellation
      // remains owned by the current page, including first-load failures.
      return originalFetch(destination, { method, body, ...(opaque ? {headers: {'Content-Type': 'application/json'}} : {}), credentials: 'same-origin', cache: 'no-store', signal: init?.signal || (input instanceof Request ? input.signal : undefined) });
    }
    if (url.pathname.startsWith('/api/') || url.origin !== location.origin) return Promise.reject(new TypeError('Business request requires encrypted page fetch'));
    return originalFetch(input, init);
  };
  class RoutedSocket extends OriginalSocket {
    constructor(url, protocols) {
      super(route(String(url), socketPaths, true), protocols);
    }
  }
  window.WebSocket = RoutedSocket;
  // Freeze the document's boot identity before clientScope.ts is imported.
  // Never seed credentials, pairing codes or the entry's identity as the target.
  if (boot.connection.targetPeerId) {
    const target = { ...boot.connection, serviceName: boot.connection.label };
    sessionStorage.setItem('termdock-secure-target-v1', JSON.stringify(target));
  }
  }
  const MAX_FILE_BYTES = 128 * 1024 * 1024, CHUNK_BYTES = 256 * 1024;
  const activeReads = new Set(), activeWrites = new Set(), activeDownloadCancels = new Set(); let closing = false, nativeDropOperationSequence = 0;
  const targetStamp = () => boot.local ? 'center' : sessionStorage.getItem('termdock-secure-target-v1');
  async function readSelection(op, args, signal, valid = () => true) {
    const stamp = targetStamp();
    if (closing || signal?.aborted || !valid()) throw new Error('File read cancelled or window closed');
    return readFiles(await invoke(op,args), stamp, op === 'clipboardFiles', signal, valid);
  }
  async function readFiles(selection, stamp, strictMovie, signal, valid) {
    const batch = selection?.batch;
    const sameTarget = () => { if (closing || signal?.aborted || !valid() || targetStamp() !== stamp) throw new Error('目标服务已切换，请重新选择文件'); };
    const output = []; let total = 0, seq = 0, receipt = null;
    if (batch !== null && (typeof batch !== 'string' || !/^[a-f0-9-]{36}$/.test(batch))) throw new TypeError('Invalid native file capability');
    const cancel = () => { if (batch) void invoke('releaseFiles',{batch}).catch(()=>{}); };
    if (batch) activeReads.add(batch);
    signal?.addEventListener('abort', cancel, {once:true});
    try {
      sameTarget();
      if (!selection || !Array.isArray(selection.files) || selection.files.length > 50) throw new TypeError('Invalid native file selection');
      // Validate the complete allocation budget before allocating any buffer.
      for (const file of selection.files) {
        if (typeof file.name !== 'string') throw new TypeError('Invalid native file name');
        if (typeof file.path === 'string' && file.index === undefined) continue;
        if (!batch || !Number.isSafeInteger(file.size) || file.size < 0 || !Number.isSafeInteger(file.index) || file.index < 0 || file.index >= 50 || file.path !== undefined) throw new TypeError('Invalid native file descriptor');
        total += file.size; if (total > MAX_FILE_BYTES) throw new Error('Selected files exceed 128 MiB');
      }
      for (const file of selection.files) {
        sameTarget();
        if (file.path !== undefined) { output.push({name:file.name,path:file.path,type:file.type}); continue; }
        const buffer = new Uint8Array(file.size); let offset = 0;
        do {
          sameTarget();
          const chunk = await invoke('fileChunk', {batch,index:file.index,seq,receipt});
          sameTarget();
          const expected = Math.min(CHUNK_BYTES, file.size - offset);
          if (!chunk || chunk.index !== file.index || chunk.seq !== seq || chunk.offset !== offset || chunk.length !== expected || chunk.eof !== (offset + expected === file.size) || typeof chunk.receipt !== 'string' || !/^[a-f0-9-]{36}$/.test(chunk.receipt) || typeof chunk.base64 !== 'string' || chunk.base64.length !== 4 * Math.ceil(expected / 3)) throw new TypeError('Invalid native file chunk');
          const decoded = atob(chunk.base64);
          if (decoded.length !== expected) throw new TypeError('Native file chunk length mismatch');
          for (let i = 0; i < decoded.length; i++) buffer[offset + i] = decoded.charCodeAt(i);
          offset += expected; seq++; receipt = chunk.receipt;
          if (chunk.eof) break;
        } while (true);
        output.push({name:file.name,type:file.type,bytes:buffer.buffer});
      }
      sameTarget(); return output;
    } catch (error) {
      if (strictMovie && Array.isArray(selection?.files) && selection.files.some(file => (typeof file.type === 'string' && file.type.startsWith('video/')) || /\.(?:mov|mp4|m4v|webm|mpeg|mpg)$/i.test(file.name))) throw new Error('TERMDOCK_CLIPBOARD_VIDEO_ERROR:' + String(error.message || error));
      throw error;
    } finally {
      signal?.removeEventListener('abort', cancel);
      if (batch) { activeReads.delete(batch); await invoke('releaseFiles',{batch}).catch(()=>{}); }
    }
  }
  async function writeDownload(name, expected, chunks, signal, cancelSource = () => {}) {
    if (typeof name !== 'string' || !name || name.length > 255 || (expected !== undefined && (!Number.isSafeInteger(expected) || expected < 0))) throw new TypeError('Invalid native download');
    const stamp = targetStamp();
    let cancelled=false;
    const sameTarget = () => { if (cancelled || closing || signal?.aborted || targetStamp() !== stamp) throw new Error('目标服务已切换或窗口已关闭'); };
    let batch, seq = 0, receipt, written = 0, complete = false;
    const cancel = () => { cancelled=true;cancelSource();if(batch)void invoke('downloadCancel', {batch}).catch(()=>{}); };
    const secureChanged=event=>{if(event?.type==='auth:unauthorized'||targetStamp()!==stamp)cancel();};
    for(const name of ['termdock:secure-state','auth:unauthorized'])window.addEventListener(name,secureChanged);
    signal?.addEventListener('abort', cancel, {once:true});
    activeDownloadCancels.add(cancel);
    try {
      sameTarget();
      const selection = await invoke('downloadStart', {name, size:expected ?? null});
      if (selection?.status === 'canceled') return 'canceled';
      batch = selection?.batch;
      if (typeof batch !== 'string' || !/^[a-f0-9-]{36}$/.test(batch) || selection.seq !== 0 || typeof selection.receipt !== 'string' || !/^[a-f0-9-]{36}$/.test(selection.receipt) || selection.chunkBytes !== CHUNK_BYTES) throw new TypeError('Invalid native download capability');
      receipt = selection.receipt;activeWrites.add(batch);sameTarget();
      for await (const source of chunks) {
        sameTarget();
        if (!(source instanceof Uint8Array)) throw new TypeError('Invalid native download bytes');
        for (let offset = 0; offset < source.length; offset += CHUNK_BYTES) {
          sameTarget();const bytes = source.subarray(offset,offset+CHUNK_BYTES);
          const total=written+bytes.length;
          if(!Number.isSafeInteger(total)||(expected!==undefined&&total>expected))throw new Error('Download length does not match the response');
          let binary='';for(let i=0;i<bytes.length;i+=0x8000)binary+=String.fromCharCode(...bytes.subarray(i,i+0x8000));
          const next=await invoke('downloadChunk',{batch,seq,receipt,base64:btoa(binary)});
          sameTarget();
          if(!next||next.written!==total||next.seq!==seq+1||typeof next.receipt!=='string'||!/^[a-f0-9-]{36}$/.test(next.receipt))throw new TypeError('Invalid native download receipt');
          written=total;seq=next.seq;receipt=next.receipt;
        }
      }
      sameTarget();if(expected!==undefined&&written!==expected)throw new Error('Download length does not match the response');
      const result=await invoke('downloadFinish',{batch,seq,receipt,written});
      sameTarget();if(result?.status!=='saved')throw new Error('Native save did not complete');
      complete=true;return 'saved';
    } finally {
      signal?.removeEventListener('abort',cancel);activeDownloadCancels.delete(cancel);if(batch)activeWrites.delete(batch);
      for(const name of ['termdock:secure-state','auth:unauthorized'])window.removeEventListener(name,secureChanged);
      if(!complete)cancel();
    }
  }
  async function saveDownloadBlob(blob, name, signal) {
    if (!(blob instanceof Blob)) throw new TypeError('Invalid native download');
    async function* chunks(){for(let offset=0;offset<blob.size;offset+=CHUNK_BYTES)yield new Uint8Array(await blob.slice(offset,offset+CHUNK_BYTES).arrayBuffer());}
    return writeDownload(name,blob.size,chunks(),signal);
  }
  async function saveDownloadStream(stream, name, options = {}) {
    if (!stream || typeof stream.getReader!=='function') throw new TypeError('Invalid native download stream');
    const reader=stream.getReader(),cancel=()=>{void reader.cancel().catch(()=>{});};
    async function* chunks(){while(true){const result=await reader.read();if(result.done)return;yield result.value;}}
    try{return await writeDownload(name,options.expectedBytes,chunks(),options.signal,cancel);}
    finally{try{await reader.cancel();}catch{}try{reader.releaseLock();}catch{}}
  }
  window.addEventListener('pagehide', () => {
    closing = true;
    for (const batch of activeReads) void invoke('releaseFiles',{batch}).catch(()=>{});
    activeReads.clear();
    for (const batch of activeWrites) void invoke('downloadCancel',{batch}).catch(()=>{});
    activeWrites.clear();
    for(const cancel of activeDownloadCancels)cancel();activeDownloadCancels.clear();
  });
  // One reload owner covers keyboard/menu requests and worker activation.
  // An update completing and controllerchange must not independently navigate.
  let reloadTask=null,reloadIssued=false;
  const bounded=(work,delay)=>new Promise(resolve=>{
    const timer=window.setTimeout(resolve,delay);
    Promise.resolve(work).catch(()=>{}).finally(()=>{window.clearTimeout(timer);resolve();});
  });
  const reloadOnce=()=>{
    if(closing||reloadIssued)return;
    reloadIssued=true;location.reload();
  };
  const reloadWorkspace=(force=false)=>{
    if(closing||reloadIssued)return Promise.resolve();
    if(reloadTask)return reloadTask;
    // A repeated accelerator arriving in the replacement document must not
    // restart a restore which has not yet released its startup surface.
    try{
      const recent=Number(sessionStorage.getItem('termdock-preview-reload-at'));
      const startup=typeof document==='undefined'?null:document.getElementById('termdock-startup');
      if(!boot.local&&recent>0&&Date.now()-recent<10000&&startup&&!startup.hidden)return Promise.resolve();
      sessionStorage.setItem('termdock-preview-reload-at',String(Date.now()));
    }catch{}
    reloadTask=Promise.resolve().then(async()=>{
      if(!force||!navigator.serviceWorker?.getRegistration)return;
      let registration;
      await bounded(navigator.serviceWorker.getRegistration().then(value=>{registration=value;}),3000);
      if(closing||!registration||registration.scope!==location.origin+'/')return;
      await bounded(registration.update(),3000);
      if(closing)return;
      const installing=registration.installing;
      if(installing&&installing.state!=='installed'&&installing.state!=='redundant'){
        let changed;
        await bounded(new Promise(resolve=>{
          changed=()=>{if(['installed','redundant'].includes(installing.state))resolve();};
          installing.addEventListener('statechange',changed);changed();
        }),2000);
        installing.removeEventListener('statechange',changed);
      }
      const waiting=registration.waiting;
      if(closing||!waiting)return;
      // Listen before SKIP_WAITING, and wait for the new controller before the
      // only navigation. Late callbacks from an old document cannot reload it.
      const sw=navigator.serviceWorker;let changed;
      await bounded(new Promise(resolve=>{
        changed=resolve;sw.addEventListener('controllerchange',changed);
        waiting.postMessage({type:'SKIP_WAITING'});
      }),2000);
      sw.removeEventListener?.('controllerchange',changed);
    }).catch(()=>{}).finally(reloadOnce);
    return reloadTask;
  };
  // Installing the desktop app also installs its immutable bundled frontend.
  // Ordinary web/PWA update consent is unchanged.
  if(boot.bundledWorkspace===true&&navigator.serviceWorker?.controller){
    const sw=navigator.serviceWorker;
    sw.addEventListener('controllerchange',()=>{
      if(closing||reloadTask)return;
      reloadOnce();
    });
    void sw.getRegistrations().then(registrations=>{
      for(const registration of registrations){
        if(closing||registration.scope!==location.origin+'/')continue;
        const activate=()=>{if(!closing&&!reloadTask)registration.waiting?.postMessage({type:'SKIP_WAITING'});};
        const watch=()=>{const worker=registration.installing;worker?.addEventListener('statechange',()=>{if(worker.state==='installed')activate();});};
        registration.addEventListener('updatefound',watch);watch();activate();
        void registration.update().then(activate).catch(()=>{});
      }
    }).catch(()=>{});
  }
  const invitationMarker='termdock-secure-preview-invitation-v1';
  const invitationFingerprint=()=>crypto.subtle.digest('SHA-256',new TextEncoder().encode(boot.invitation)).then(bytes=>Array.from(new Uint8Array(bytes),byte=>byte.toString(16).padStart(2,'0')).join(''));
  const serviceConnection=async()=>{
    const value={...boot.connection,invitation:boot.invitation};if(!boot.invitation)return value;
    try{const fingerprint=await invitationFingerprint(),raw=sessionStorage.getItem(invitationMarker);if(raw&&raw.length<=1024){const marker=JSON.parse(raw);if(marker.window===boot.origin&&marker.targetPeerId===boot.connection.targetPeerId&&marker.fingerprint===fingerprint)value.invitation=undefined;}}catch{/* Missing storage/crypto retains the prompt; never authorizes. */}
    return value;
  };
  const acknowledgeInvitation=async(options,isCurrent)=>{
    if(closing||!boot.invitation||typeof isCurrent!=='function'||typeof options?.targetPeerId!=='string'||options.targetPeerId!==boot.connection.targetPeerId||typeof options.fingerprint!=='string'||!/^[a-f0-9]{64}$/.test(options.fingerprint))return false;
    const fingerprint=await invitationFingerprint();
    if(closing||options.fingerprint!==fingerprint||isCurrent()!==true)return false;
    sessionStorage.setItem(invitationMarker,JSON.stringify({window:boot.origin,targetPeerId:boot.connection.targetPeerId,fingerprint}));return true;
  };
  let confirmation;
  const confirmInPage=options=>{
    if(closing)return Promise.resolve(false);
    if(confirmation)return Promise.reject(new Error('A confirmation is already open'));
    for(const [key,limit] of [['title',128],['message',2048],['confirmLabel',128],['cancelLabel',128]])if(typeof options?.[key]!=='string'||!options[key]||options[key].length>limit)return Promise.reject(new TypeError('Invalid confirmation text'));
    return new Promise(resolve=>{
      const previous=document.activeElement,backdrop=document.createElement('button'),panel=document.createElement('section');
      backdrop.type='button';backdrop.tabIndex=-1;backdrop.setAttribute('aria-label',options.cancelLabel);backdrop.className='fixed inset-0 z-modal-backdrop bg-[var(--app-backdrop)]';
      panel.setAttribute('role','dialog');panel.setAttribute('aria-modal','true');panel.setAttribute('aria-label',options.title);panel.dataset.desktopConfirmation='true';panel.className='fixed left-1/2 top-1/2 z-modal-panel w-[min(28rem,calc(100vw-2rem))] -translate-x-1/2 -translate-y-1/2 rounded-2xl border border-border bg-surface p-4 text-foreground shadow-xl';
      const title=document.createElement('h2'),message=document.createElement('p'),actions=document.createElement('div'),cancel=document.createElement('button'),accept=document.createElement('button');
      title.className='text-sm font-semibold';title.textContent=options.title;message.className='my-4 whitespace-pre-wrap text-sm';message.textContent=options.message;actions.className='flex justify-end gap-2';
      for(const button of [cancel,accept]){button.type='button';button.className='min-h-11 rounded-lg px-4 text-sm focus-visible:ring-2 focus-visible:ring-primary';}
      cancel.classList.add('bg-surface-2');cancel.textContent=options.cancelLabel;accept.classList.add('bg-primary','text-primary-foreground');accept.textContent=options.confirmLabel;actions.append(cancel,accept);panel.append(title,message,actions);
      let unsubscribe;const finish=approved=>{
        if(confirmation!==finish)return;confirmation=undefined;unsubscribe?.();document.removeEventListener('keydown',key,true);for(const name of ['pagehide','termdock:secure-state','auth:unauthorized'])window.removeEventListener(name,expired);backdrop.remove();panel.remove();if(!closing&&previous?.isConnected)previous.focus?.({preventScroll:true});resolve(approved);
      };
      const expired=()=>finish(false),key=event=>{
        if(event.key==='Escape'){event.preventDefault();event.stopImmediatePropagation();finish(false);}
        if(event.key==='Tab'){const outside=!panel.contains(document.activeElement);if(event.shiftKey&&(document.activeElement===cancel||outside)){event.preventDefault();accept.focus();}else if(!event.shiftKey&&(document.activeElement===accept||outside)){event.preventDefault();cancel.focus();}}
      };
      confirmation=finish;cancel.onclick=()=>finish(false);backdrop.onclick=()=>finish(false);accept.onclick=()=>finish(true);document.addEventListener('keydown',key,true);for(const name of ['pagehide','termdock:secure-state','auth:unauthorized'])window.addEventListener(name,expired);
      document.body.append(backdrop,panel);
      // The ordinary overlay observer/receipt controls first paint and focus.
      queueMicrotask(()=>{if(confirmation!==finish)return;const life=window.termdockPreviewLifecycle;let focused=false;if(life)unsubscribe=life.subscribe(value=>{if(value.overlayReady&&confirmation===finish&&!focused){focused=true;cancel.focus({preventScroll:true});}});else cancel.focus({preventScroll:true});});
    });
  };
  let feedback;
  const alertInPage=message=>{
    if(closing)return;if(typeof message!=='string'||message.length>4096)throw new TypeError('Invalid page feedback text');
    feedback?.remove();const panel=document.createElement('section'),text=document.createElement('p'),close=document.createElement('button');
    panel.setAttribute('role','alert');panel.dataset.previewFeedback='true';panel.className='fixed right-3 top-3 z-toast flex max-w-md items-start gap-3 rounded-xl border border-border bg-surface p-3 text-sm text-foreground shadow-xl';
    text.className='break-words';text.textContent=message;close.type='button';close.textContent='×';close.setAttribute('aria-label','Close');close.className='shrink-0 text-primary';close.onclick=()=>{panel.remove();if(feedback===panel)feedback=undefined;};
    panel.append(text,close);feedback=panel;document.body.append(panel);
  };
  for(const name of ['pagehide','termdock:secure-state','auth:unauthorized'])window.addEventListener(name,()=>{feedback?.remove();feedback=undefined;});
  window.termdockDesktop = Object.freeze({
    platform: boot.platform,
    capabilities:Object.freeze({webWorkspace:true}),
    openExternal: value => {
      try{const url=new URL(value);if(!['http:','https:','mailto:'].includes(url.protocol)||url.username||url.password)throw Error('Invalid external URL');return invoke('openExternal',{url:url.href});}
      catch(error){return Promise.reject(error);}
    },
    writeClipboardText: text => {
      if(closing||typeof text!=='string'||!text||new TextEncoder().encode(text).length>262144)return Promise.reject(new TypeError('Invalid clipboard text'));
      return invoke('clipboardWriteText',{text});
    },
    confirmationUI:'page-v1',confirm:confirmInPage,alert:alertInPage,
    previewCapabilities: Object.freeze({ notifications: boot.platform === 'darwin', updates: true, tray: true, floatingWidget: true, backgroundWorker: true }),
    passwordBootstrapOrigin: url => {
      if (boot.local) throw new TypeError('Authorization belongs to a service window');
      const parsed = new URL(url);
      if (!['http:', 'https:'].includes(parsed.protocol) || parsed.origin !== url || parsed.username || parsed.password || (url !== location.origin && !boot.origins.includes(url))) throw new TypeError('Unapproved password proof route');
      return url === location.origin ? boot.origins[boot.defaultRoute] : parsed.origin;
    },
    reloadWorkspace: ({force=false}={}) => reloadWorkspace(force),
    snapshot: () => invoke('snapshot'),
    ...(boot.local ? {
      certificatePins: () => invoke('certificatePins'),
      inspectCertificate: origin => invoke('inspectCertificate', {origin}),
      trustCertificate: async (origin, fingerprint, receipt) => {
        try { return await invoke('trustCertificate', {origin, fingerprint, receipt}); }
        catch (reason) {
          const detail = typeof reason === 'string' ? reason : reason?.message || String(reason);
          console.error('[Termdock Preview] certificate trust rejected:', detail);
          const error = new Error(/PREVIEW_CERTIFICATE_CHANGED/.test(detail) ? '服务证书在确认期间发生变化，请重新核对新指纹。' : '无法保存此地址的证书信任，请检查连接中心状态后重试。');
          if (/PREVIEW_CERTIFICATE_CHANGED/.test(detail)) error.code = 'PREVIEW_CERTIFICATE_CHANGED';
          throw error;
        }
      },
      discardCertificateInspection: receipt => invoke('discardCertificateInspection', {receipt}),
      revokeCertificate: origin => invoke('revokeCertificate', {origin}),
    } : {}),
    prepareLocalService: (install = false) => invoke('prepareLocal', {install}),
    downloadNode: () => invoke('downloadNode'),
    probe: url => invoke('probe', {url}),
    connect: url => invoke('connect', {url}),
    saveConnection: (url, label) => invoke('saveConnection', {connection: {id: url, url, label}}).then(() => invoke('snapshot')),
    removeConnection: id => invoke('removeConnection', {id}).then(() => invoke('snapshot')),
    updateDesktopPreferences: preferences => invoke('preferences', {preferences}).then(() => invoke('snapshot')),
    desktopStatus: () => invoke('desktopStatus'),
    onDesktopStatus: callback => subscribe('termdock:preview-status', callback),
    onLocalServiceSetup: callback => subscribe('termdock:preview-setup', callback),
    onStartupProgress: callback => subscribe('termdock:preview-startup', callback),
    focusNextService: (scope = 'attention') => invoke('focusNext', {scope}),
    setFloatingMetricCount: count => invoke('floatingSize', {count}),
    disableFloatingWidget: () => invoke('preferences', {preferences: {floatingWidgetEnabled: false}}).then(() => invoke('snapshot')),
    collaborationFocus: (id,targetPeerId) => invoke('collaborationFocus', {id,...(targetPeerId?{targetPeerId}:{} )}),
    getServiceConnection:serviceConnection,acknowledgeServiceInvitation:acknowledgeInvitation,
    serviceConnections: () => invoke('connections'),
    saveServiceConnection: connection => invoke('saveConnection', { connection }),
    importServiceConnection: connection => invoke('importConnection', { connection }),
    removeServiceConnection: id => invoke('removeConnection', { id }),
    onServiceConnections: callback => subscribe('termdock:preview-connections', callback),
    openServiceConnection: async (connection, invitation) => {
      try { return await invoke('openConnection', { connection, invitation }); }
      catch (reason) { const normalized = normalizeOpenRejection(reason); const error = new Error(normalized.message); error.code = normalized.code; throw error; }
    },
    showConnectionCenter: () => closing?Promise.resolve():invoke('showCenter'),
    revealDataDirectory: () => invoke('revealConfig'),
    deviceInfo: () => invoke('deviceInfo'),
    notificationDeliveryConfirmation: true,
    showNotification: payload => invoke('notification', {payload}),
    openNotificationSettings: () => invoke('notificationSettings'),
    prepareNotificationTest: () => invoke('notificationTest'),
    desktopUpdateState: () => invoke('updateState'),
    checkDesktopUpdate: () => invoke('checkUpdate'),
    installDesktopUpdate: () => invoke('installUpdate'),
    onDesktopUpdateState: callback => subscribe('termdock:preview-update', callback),
    readClipboardImage: async options => { const files = await readSelection('clipboardImage', undefined, options?.signal); if (!files.length) return null; if (files.length !== 1 || !files[0].bytes) throw new Error('Invalid native clipboard image'); return files[0].bytes; },
    readClipboardFiles: async (options = {}) => { const {signal,...nativeOptions} = options; return readSelection('clipboardFiles', {options:nativeOptions}, signal); },
    saveDownloadBlob,
    saveDownloadStream,
    readLocalFiles: async options => readSelection('chooseFiles', undefined, options?.signal),
    // Native drop capabilities identify files selected by an actual OS drop.
    // Rust verifies target identity before returning reusable local paths.
    onNativeFileDrop: callback => {
      let hovered, localHover = false;
      const controllers = new WeakMap();
      const clear = target => {
        for (const key of ['nativeFileDrag','nativeFileDropState','nativeFileDropOperation','nativeFileDropProgress','nativeFileDropCancellable']) delete target.dataset[key];
      };
      const hit = payload => document.elementFromPoint?.(payload.x,payload.y)?.closest('[data-termdock-terminal-dropzone]');
      const stopHover = subscribe('termdock:preview-drag', payload => {
        if (hovered && ['local','remote'].includes(hovered.dataset.nativeFileDropState)) clear(hovered);
        hovered = payload.phase === 'leave' ? null : hit(payload);
        if (payload.phase === 'enter') localHover = payload.local === true;
        if (hovered && !controllers.has(hovered)) { hovered.dataset.nativeFileDrag='true'; hovered.dataset.nativeFileDropState=localHover?'local':'remote'; }
      });
      const stopDrop = subscribe('termdock:preview-files', async payload => {
        if(hovered&&['local','remote'].includes(hovered.dataset.nativeFileDropState))clear(hovered);hovered=null;
        const viewId = typeof payload.sessionKey === 'string' ? payload.sessionKey : '';
        const target = viewId
          ? [...document.querySelectorAll('[data-termdock-terminal-dropzone]')].find(element => element.dataset.termdockTerminalDropzone === viewId)
          : hit(payload);
        if (!target) return;
        controllers.get(target)?.abort();
        const controller = new AbortController(); controllers.set(target,controller);
        const targetSessionKey=target.dataset.termdockTerminalDropzone||'';
        const currentPeer=()=>JSON.parse(sessionStorage.getItem('termdock-secure-target-v1')||'null')?.targetPeerId;
        const peer=currentPeer(),operation=String(++nativeDropOperationSequence),ownerKey=target.dataset.termdockTerminalOwner,stamp=targetStamp();
        const ownsDropState=()=>target.isConnected!==false && target.dataset.termdockTerminalDropzone===targetSessionKey && target.dataset.nativeFileDropOperation===operation;
        const isCurrent=()=>!closing&&!controller.signal.aborted&&ownsDropState()&&target.dataset.termdockTerminalOwner===ownerKey&&targetStamp()===stamp&&currentPeer()===peer;
        const discardStaleDrop=()=>{if(isCurrent())return false;if(ownsDropState()&&!(controller.signal.aborted&&['cancelled','error'].includes(target.dataset.nativeFileDropState)&&target.dataset.termdockTerminalOwner===ownerKey&&targetStamp()===stamp))clear(target);return true;};
        const timedStatus=phase=>{
          target.dataset.nativeFileDropState=phase;delete target.dataset.nativeFileDropCancellable;delete target.dataset.nativeFileDropProgress;
          window.setTimeout(()=>{if(ownsDropState()&&target.dataset.nativeFileDropState===phase)clear(target);},3000);
        };
        const cancel=event=>{if(event.target?.closest?.('[data-termdock-terminal-dropzone]')!==target||!ownsDropState())return;controller.abort();clear(target);target.dataset.nativeFileDropOperation=operation;target.dataset.nativeFileDrag='true';timedStatus('cancelled');};
        const expire=()=>{if(!isCurrent()){controller.abort();discardStaleDrop();}};
        const leave=()=>{controller.abort();discardStaleDrop();};
        target.dataset.nativeFileDropOperation=operation;target.dataset.nativeFileDrag='true';target.dataset.nativeFileDropState='preparing';target.dataset.nativeFileDropCancellable='true';delete target.dataset.nativeFileDropProgress;
        window.addEventListener('termdock:file-drop-cancel',cancel);
        window.addEventListener('termdock:secure-state',expire);
        window.addEventListener('auth:unauthorized',leave);
        window.addEventListener('pagehide',leave);
        const timeout=window.setTimeout(()=>{if(isCurrent()){controller.abort();timedStatus('error');target.dispatchEvent(new CustomEvent('termdock:file-drop-error',{bubbles:true,detail:'文件处理超时，请重试'}));}},120000);
        try {
          const files=await readSelection('dropFiles',{token:payload.token,targetPeerId:peer,viewId:viewId||undefined},controller.signal,isCurrent);
          if(discardStaleDrop())return;
          if(!files.length)throw new Error('未读取到文件，请重新拖入');
          const paths=files.filter(file=>file.path).map(file=>file.path),upload=files.filter(file=>file.bytes);
          if(upload.length){
            target.dataset.nativeFileDropState='uploading';
            const form=new FormData();for(const file of upload)form.append('files',new Blob([file.bytes],{type:file.type}),file.name);
            const csrf=await window.fetch('/api/csrf-token',{signal:controller.signal});
            if(discardStaleDrop())return;if(!csrf.ok)throw new Error('文件上传授权失败');
            const {csrfToken}=await csrf.json();if(discardStaleDrop())return;if(!csrfToken)throw new Error('文件上传授权失败');
            // Preserve WebKit's case-sensitive multipart boundary, and report
            // only encrypted transport acknowledgements (never synthetic progress).
            const encoded=new Response(form),body=await encoded.blob();
            if(discardStaleDrop())return;
            const response=await window.fetch(`/api/terminal/fs/upload?dir=%2Ftmp&fileCount=${upload.length}`,{method:'POST',body,signal:controller.signal,headers:{'X-XSRF-TOKEN':csrfToken,'Content-Type':encoded.headers.get('Content-Type')},onUploadProgress:bytes=>{if(isCurrent())target.dataset.nativeFileDropProgress=String(Math.min(99,Math.floor(bytes/Math.max(1,body.size)*100)));}});
            if(discardStaleDrop())return;
            const result=await response.json();if(discardStaleDrop())return;
            if(!response.ok)throw new Error(result.error||'文件上传失败');
            if(result.files?.length!==upload.length||result.files.some(file=>!file.path))throw new Error('上传结果不完整，请重新拖入文件');
            paths.push(...result.files.map(file=>file.path));
          }
          if(discardStaleDrop())return;
          callback({sessionKey:targetSessionKey,paths});
          if(isCurrent())timedStatus(upload.length?'uploaded':'inserted');
        }catch(error){
          if(controller.signal.aborted||discardStaleDrop())return;
          timedStatus('error');target.dispatchEvent(new CustomEvent('termdock:file-drop-error',{bubbles:true,detail:String(error.message||error)}));
        }finally{
          window.clearTimeout(timeout);if(controllers.get(target)===controller)controllers.delete(target);
          window.removeEventListener('termdock:file-drop-cancel',cancel);window.removeEventListener('termdock:secure-state',expire);window.removeEventListener('auth:unauthorized',leave);window.removeEventListener('pagehide',leave);
        }
      });
      return ()=>{stopHover();stopDrop();};
    },
    reportServiceActivity: activity => { void invoke('reportActivity', { activity }).catch(() => {}); },
    focusService: origin => invoke('focusService', { origin }),
    onServiceActivity: callback => subscribe('termdock:preview-activity', callback),
  });
  if (!boot.local) {
    let request, timer, channel;
    const stop = () => { window.clearTimeout(timer); channel?.port1.close(); channel?.port2.close(); channel=undefined; };
    const deliver = () => {
      stop();
      if (!request || !navigator.serviceWorker) return;
      const submitted=request;
      channel = new MessageChannel();
      channel.port1.onmessage = event => {
        if (event.data?.type !== 'termdock:focus-session-ack' || request!==submitted) return;
        const receipt=request; request=undefined;stop();
        void invoke('focusReceipt',{requestId:receipt.requestId}).catch(()=>{});
      };
      // The existing App acknowledges this message only after its session
      // focus handler is mounted. No worker control or business request is needed.
      navigator.serviceWorker.dispatchEvent(new MessageEvent('message',{data:{type:'termdock:focus-session',sessionId:request.sessionId,targetPeerId:request.targetPeerId},ports:[channel.port2]}));
      timer=window.setTimeout(deliver,250);
    };
    window.addEventListener('termdock:preview-focus-request', event => {
      const value=event.detail;
      if (typeof value?.requestId!=='string' || typeof value.sessionId!=='string' || value.sessionId.length>512) return;
      request=value;deliver();
    });
    window.addEventListener('pagehide',()=>{request=undefined;stop();});
  }
  // Local UI has no transport wrapper; native callbacks share the service contract.
  delete window.__TD_PREVIEW_BOOT__;
  window.addEventListener('termdock:preview-error', event => { const notice = document.querySelector('#notice'); if (notice) {notice.textContent=event.detail;notice.hidden=false;notice.classList.add('error');} });
  window.addEventListener('DOMContentLoaded', () => {
    document.documentElement.dataset.termdockDesktop = 'true';
    document.documentElement.dataset.termdockPreview = 'true';
    // Match AppKit and WK's resize/backing-store fill to the actual CSS token.
    // Otherwise exposed pixels during live resize use the system white default.
    const syncWindowBackground = () => {
      if (typeof getComputedStyle !== 'function') return;
      const value=getComputedStyle(document.documentElement).getPropertyValue('--chrome-bg').trim();
      const hex=/^#([0-9a-f]{6})$/i.exec(value);
      if (!hex) return;
      const rgb=[0,2,4].map(offset=>parseInt(hex[1].slice(offset,offset+2),16));
      void invoke('windowBackground',{rgb}).catch(()=>{});
    };
    syncWindowBackground();
    if (typeof MutationObserver === 'function') new MutationObserver(syncWindowBackground).observe(document.documentElement,{attributes:true,attributeFilter:['data-theme']});
    if (!boot.local) history.replaceState(history.state, '', location.pathname + location.hash);
    if (boot.chromeCss) { const style = document.createElement('style'); style.textContent = boot.chromeCss; document.head.append(style); }
    document.addEventListener('click', event => {
      const anchor = event.target instanceof Element ? event.target.closest('a[href]') : null;
      if (!anchor) return;
      const url = new URL(anchor.href, location.origin);
      if (url.origin !== location.origin && !['blob:', 'data:'].includes(url.protocol)) {
        event.preventDefault(); void invoke('openExternal', { url: url.href }).catch(() => {});
      }
    }, true);
    document.addEventListener('mousedown', event => {
      if (event.button !== 0 || !(event.target instanceof Element) || event.defaultPrevented) return;
      const target = event.target;
      // WK does not provide Electron's app-region handling. Only explicit
      // shell chrome may start a drag; interactive descendants retain input.
      if (target.closest('button,a,input,textarea,select,form,summary,label,[contenteditable]:not([contenteditable="false"]),[draggable="true"],[data-rbd-draggable-id],[data-rbd-drag-handle-draggable-id],[data-split-pane-title],[data-panel-drag-title],.split-pane-drag-handle,[data-no-drag],[data-tauri-no-drag],[data-tauri-drag-region="false"],[data-termdock-terminal-dropzone],.xterm,[role="button"],[role="link"],[role="tab"],[role="menu"],[role="menuitem"],[role="menuitemcheckbox"],[role="menuitemradio"],[role="textbox"],[role="combobox"],[role="listbox"],[role="option"],[role="slider"],[role="spinbutton"],[role="checkbox"],[role="radio"],[role="switch"],[role="treeitem"],[role="scrollbar"]')) return;
      if (!documentEpoch) return;
      const selection = document.getSelection?.();
      if (selection?.type === 'Range' && !selection.isCollapsed) return;
      try {
        const caret = document.caretRangeFromPoint?.(event.clientX,event.clientY)
          || (() => { const point=document.caretPositionFromPoint?.(event.clientX,event.clientY); if(!point)return null;const range=document.createRange();range.setStart(point.offsetNode,point.offset);range.collapse(true);return range; })();
        if (caret?.startContainer?.nodeType === 3 && target.contains(caret.startContainer) && caret.startContainer.textContent?.length) {
          const textRange=document.createRange();textRange.selectNodeContents(caret.startContainer);
          if ([...textRange.getClientRects()].some(rect=>event.clientX>=rect.left&&event.clientX<rect.right&&event.clientY>=rect.top&&event.clientY<rect.bottom)) return;
        }
      } catch { /* If text hit-testing is unavailable, keep the exact target checks below. */ }
      if ([...target.childNodes].some(node => node.nodeType === 3 && node.textContent?.trim())) return;
      const hitScrollbar = element => {
        const box = element.getBoundingClientRect();
        if (![box.left,box.right,box.top,box.bottom,event.clientX,event.clientY].every(Number.isFinite)) return false;
        const verticalWidth = Math.max(0,element.offsetWidth-element.clientWidth);
        const horizontalHeight = Math.max(0,element.offsetHeight-element.clientHeight);
        const vertical = verticalWidth > 0 && element.scrollHeight > element.clientHeight && event.clientX >= box.right - verticalWidth && event.clientY >= box.top && event.clientY < box.bottom;
        const horizontal = horizontalHeight > 0 && element.scrollWidth > element.clientWidth && event.clientY >= box.bottom - horizontalHeight && event.clientX >= box.left && event.clientX < box.right;
        return vertical || horizontal;
      };
      for (let node = target; node instanceof Element; node = node.parentElement) if (hitScrollbar(node)) return;
      const centerShell = boot.local && (location.pathname === '/' || location.pathname === '/index.html') ? document.querySelector('main.app-shell') : null;
      const centerWorkspace = centerShell?.querySelector(':scope > .workspace');
      const centerRail = centerShell?.querySelector(':scope > .rail');
      const railBox = centerRail?.getBoundingClientRect();
      const centerRailBlank = target === centerRail && centerRail?.isConnected && railBox
        && [railBox.left,railBox.right,railBox.top,railBox.bottom,event.clientX,event.clientY].every(Number.isFinite)
        && event.clientX >= railBox.left && event.clientX < railBox.right && event.clientY >= railBox.top && event.clientY < railBox.bottom;
      const centerBlank = !!centerShell && (target === centerShell || target === centerWorkspace || centerRailBlank || (target.parentElement === centerWorkspace && ['HEADER','SECTION'].includes(target.tagName)));
      const loginRoot = !boot.local && (() => {
        const password = document.querySelector('input[type="password"][autocomplete="current-password"]');
        const root = password?.closest('#root > div');
        if (!root || target !== root || document.querySelectorAll('input[type="password"][autocomplete="current-password"]').length !== 1) return false;
        const box = root.getBoundingClientRect();
        const width = document.documentElement.clientWidth, height = document.documentElement.clientHeight;
        return root.tagName === 'DIV' && root.classList.contains('w-screen') && root.classList.contains('bg-background')
          && root.style.height === 'var(--app-vh, 100vh)' && box.width >= width - 2 && box.height >= height - 2
          && box.left <= 1 && box.top <= 1;
      })();
      const rail = boot.local ? target.closest('[data-termdock-window-rail="true"]') : null;
      const brand = rail?.querySelector(':scope > .brand[data-tauri-drag-region]');
      let railBlank = false;
      if (target === rail && rail?.isConnected && brand?.isConnected) {
        const box = rail.getBoundingClientRect(), start = brand.getBoundingClientRect();
        railBlank = [box.left,box.right,box.top,box.bottom,start.top,event.clientX,event.clientY].every(Number.isFinite)
          && box.right > box.left && start.top > box.top && start.top <= box.bottom
          && event.clientX >= box.left && event.clientX < box.right
          && event.clientY >= box.top && event.clientY < start.top;
      }
      const dragRegion=target.closest('[data-tauri-drag-region]');
      const broadCenterRegion=!!centerShell&&!!dragRegion&&(dragRegion===centerShell||dragRegion.parentElement===centerShell);
      const header=broadCenterRegion?null:target.closest('[data-tauri-drag-region],.widget,[data-termdock-window-header="true"],[data-session-sidebar-pinned] [data-session-sidebar-header]');
      if (!railBlank && !header && !centerBlank && !loginRoot) return;
      if (!ownedChrome) { void invoke('dragWindow',{documentEpoch}); return; }
      const stamp=ownedChrome,requestIndex=++chromeRequestIndex;
      const hit=railBlank?'rail-top':header?.matches('.brand')?'brand':header?.matches('.topbar')?'center-topbar':header?.matches('.widget')?'widget':centerBlank||loginRoot?'body':'window-header';
      observeChrome('hit',{hit,button:event.button,trusted:event.isTrusted,prevented:event.defaultPrevented,eligible:true,xCssPx:event.clientX,yCssPx:event.clientY},stamp);
      observeChrome('request-start',{requestIndex},stamp);
      // No await: observation acknowledgements never delay the original drag.
      void invoke('dragWindow',{documentEpoch,ownedWindowChrome:{...stamp,requestIndex}}).then(
        ()=>observeChrome('request-end',{requestIndex,outcome:'resolved'},stamp),
        ()=>observeChrome('request-end',{requestIndex,outcome:'rejected'},stamp));
    });
    document.addEventListener('dblclick', event => {
      if (event.detail !== 2 || !(event.target instanceof Element) || event.defaultPrevented) return;
      const target=event.target;
      if (target.closest('button,a,input,textarea,select,form,summary,label,[contenteditable]:not([contenteditable="false"]),[draggable="true"],[data-rbd-draggable-id],[data-rbd-drag-handle-draggable-id],[data-split-pane-title],[data-panel-drag-title],.split-pane-drag-handle,[data-no-drag],[data-tauri-no-drag],[data-tauri-drag-region="false"],[data-termdock-terminal-dropzone],.xterm,[role="button"],[role="link"],[role="tab"],[role="menu"],[role="menuitem"],[role="menuitemcheckbox"],[role="menuitemradio"],[role="textbox"],[role="combobox"],[role="listbox"],[role="option"],[role="slider"],[role="spinbutton"],[role="checkbox"],[role="radio"],[role="switch"],[role="treeitem"],[role="scrollbar"]')) return;
      const rail=boot.local?target.closest('[data-termdock-window-rail="true"]'):null;
      const brand=rail?.querySelector(':scope > .brand[data-tauri-drag-region]');
      let railBlank=false;
      if(target===rail&&rail?.isConnected&&brand?.isConnected){const box=rail.getBoundingClientRect(),start=brand.getBoundingClientRect();railBlank=[box.left,box.right,box.top,box.bottom,start.top,event.clientX,event.clientY].every(Number.isFinite)&&box.right>box.left&&start.top>box.top&&start.top<=box.bottom&&event.clientX>=box.left&&event.clientX<box.right&&event.clientY>=box.top&&event.clientY<start.top;}
      const header=target.closest('[data-tauri-drag-region],.widget,[data-termdock-window-header="true"],[data-session-sidebar-pinned] [data-session-sidebar-header]');
      if(railBlank||header)void invoke('titlebarDoubleClick');
    });
    document.addEventListener('keydown', event => {
      if ((event.metaKey || event.ctrlKey) && event.shiftKey && event.key.toLowerCase() === 'o') { event.preventDefault(); void invoke('showCenter'); }
    });
  });
})();
