// AppKit siblings sit above WK content. Global DOM overlays are CSS-gated from
// their first paint until a real main-thread hide receipt is returned. Observer
// discovers geometry; it is never treated as proof that the NSViews are hidden.
(() => {
  if (window !== window.top || !window.termdockDesktop) return;
  const listeners = new Set();
  const leaseFailures=new Map();
  const recoveryPage=String(Date.now())+'-'+String(Math.random());
  const selector='[role="dialog"], [aria-modal="true"], [role="menu"], [role="tooltip"], [role="alert"], .z-modal-panel, .z-modal-content, .z-modal-backdrop, .z-drawer-panel, .z-drawer-content, .z-drawer-backdrop, .z-popover, .z-menu-panel, .z-menu-content, .z-menu-backdrop, .z-toast, .z-sidebar-backdrop';
  let observer, installed=false, count=0, generation=0, frame=0, acknowledged=0, pendingGate=false, lastGate=Promise.resolve(), overlayIdentity='';
  const identities=new WeakMap();let nextIdentity=1;
  let recovery,retryRecovery,recoverySource=null,gateFailed=false,gateTask=null,installation=0,gateStatus='idle',resuming=0,recoveryVersion=0;
  const retryIsolation=async()=>{
    const retry=retryRecovery,version=recoveryVersion,source=recoverySource;
    if(!retry)return;
    try{
    const result=await retry();
    if(version!==recoveryVersion)return;
    if(result!==true&&result!=='detached'&&result!=='superseded')throw Error('Native recovery was not confirmed');
    // Retirement alone must not bypass a still-failed global hide gate.
    if(result!==true&&count&&await prepareOverlay(true)!==true)throw Error('Native recovery hide was not confirmed');
    if(version!==recoveryVersion)return;
    gateFailed=false;gateStatus='recovery-confirmed';recovery?.remove();recovery=null;retryRecovery=null;
    Promise.resolve(window.termdockDesktop.confirmNativeRecovery?.(recoveryPage+':'+version)).catch(()=>{});notify();
    }catch(error){if(version===recoveryVersion)showFailure(error,retry,source);}
  };
  window.addEventListener('termdock:native-isolation-retry',()=>{void retryIsolation();});
  const showFailure=(error,retry,source=null)=>{
    recoverySource=source;retryRecovery=retry;recoveryVersion++;gateFailed=true;gateStatus='failed';
    if(!recovery){
      recovery=document.createElement('div');recovery.dataset.nativeRecovery='true';
      // Dedicated status is excluded from the overlay gate, so a failed gate
      // cannot hide its own explanation. Connection Center is a separate WK
      // window without native siblings and remains reachable via the App menu.
      recovery.className='fixed top-2 right-2 z-toast rounded bg-surface p-3 text-foreground';
      recovery.setAttribute('aria-live','assertive');document.body.append(recovery);
    }
    recovery.replaceChildren();
    const text=document.createElement('span');text.textContent='原生终端暂时无法恢复，服务端会话已保留。';recovery.append(text);
    const button=document.createElement('button');button.textContent='重试恢复终端';button.className='ml-3 rounded border border-border bg-surface px-3 py-2 text-foreground';
    button.addEventListener('click',()=>{button.disabled=true;if(window.termdockDesktop.retryNativeIsolation){void window.termdockDesktop.retryNativeIsolation(undefined,recoveryPage+':'+recoveryVersion).catch(()=>{button.disabled=false;});}else void retryIsolation();});recovery.append(button);
    const center=document.createElement('button');center.textContent='连接中心';center.className='ml-2 rounded border border-border bg-surface px-3 py-2 text-foreground';center.addEventListener('click',()=>window.termdockDesktop.showConnectionCenter?.());recovery.append(center);
    window.dispatchEvent(new CustomEvent('termdock:preview-error',{detail:String(error)}));
    // Also present the error in the independent connection center, ensuring
    // feedback remains accessible if an unconfirmed NSView covers this page.
    Promise.resolve(window.termdockDesktop.showConnectionCenter?.(String(error),recoveryPage+':'+recoveryVersion)).catch(()=>{});
  };
  window.addEventListener('termdock:native-cleanup-error',event=>{
    const {message,retry,recoveryId}=event.detail;
    if(typeof recoveryId==='string'){leaseFailures.delete(recoveryId);leaseFailures.set(recoveryId,{message,retry});}
    showFailure(message,retry,recoveryId);
  });
  window.addEventListener('termdock:native-cleanup-resolved',event=>{
    if(!Array.isArray(event.detail?.recoveryIds))return;
    for(const id of event.detail.recoveryIds)leaseFailures.delete(id);
    if(typeof recoverySource!=='string'||!event.detail.recoveryIds.includes(recoverySource))return;
    const pending=[...leaseFailures.entries()].at(-1);
    if(pending){showFailure(pending[1].message,pending[1].retry,pending[0]);return;}
    const id=recoveryPage+':'+recoveryVersion;recoveryVersion++;recoverySource=null;
    gateFailed=false;gateStatus='recovery-confirmed';recovery?.remove();recovery=null;retryRecovery=null;acknowledged=0;
    document.documentElement.removeAttribute('data-native-overlays-ready');
    Promise.resolve(window.termdockDesktop.confirmNativeRecovery?.(id)).catch(()=>{});notify();
  });
  const presentsOverlay=node=>{
    if(node.dataset?.nativeRecovery)return false;
    const style=getComputedStyle(node),r=node.getBoundingClientRect();
    if(style.display==='none'||node.getAttribute('aria-hidden')==='true'||r.width<=0||r.height<=0)return false;
    if(Number(style.opacity)!==0||style.pointerEvents!=='none')return true;
    // Closed sidebars retain a transparent, non-interactive full-window
    // backdrop. Opacity alone must not exempt an opening or animated overlay.
    try{
      if(node.shadowRoot||typeof node.getAnimations!=='function'||typeof node.querySelectorAll!=='function')return true;
      if(node.getAnimations({subtree:true}).some(animation=>animation.playState==='running'||animation.pending))return true;
      const children=node.querySelectorAll('*');if(children.length>64)return true;
      for(const child of children){
        if(child.shadowRoot)return true;
        const childStyle=getComputedStyle(child),rect=child.getBoundingClientRect();
        // Do not use visibility: the first-paint CSS gate hides real children.
        if(childStyle.display!=='none'&&childStyle.pointerEvents!=='none'&&rect.width>0&&rect.height>0)return true;
      }
      return false;
    }catch{return true;}
  };
  // Transparent desktop menu backdrops catch outside clicks but paint nothing.
  // Keep their native input exclusion separate from the visible cutout mask.
  const inputOnly=node=>node.classList?.contains('z-menu-backdrop')&&node.classList.contains('bg-transparent');
  const nodes=()=>[...document.querySelectorAll(selector)].filter(presentsOverlay);
  // AppKit's mask accepts rectangles. Tessellate uniform CSS rounded corners
  // into subpixel-height bands so their outside corners retain native content,
  // instead of exposing a rectangular patch of WK's backing background.
  const overlayRects=()=>{
    const current=nodes().filter(node=>!inputOnly(node)),budget=Math.max(1,Math.floor((64-current.length)/Math.max(1,current.length)/2));
    return current.flatMap(node=>{
      const r=node.getBoundingClientRect(),style=getComputedStyle(node);
      const corners=[style.borderTopLeftRadius,style.borderTopRightRadius,style.borderBottomLeftRadius,style.borderBottomRightRadius];
      const radius=corners.every(value=>typeof value==='string'&&/^\d+(?:\.\d+)?px$/.test(value)&&value===corners[0])?Math.min(parseFloat(corners[0]),r.width/2,r.height/2):0;
      if (!(radius>0)||current.length>32) return [{x:r.x,y:r.y,width:r.width,height:r.height}];
      const steps=Math.max(1,Math.min(16,Math.ceil(radius*2),budget)),height=radius/steps,result=[];
      for(let step=0;step<steps;step++){
        // Outer edge of each band: never cover the DOM border or its input area.
        const y=(step+1)*height,inset=radius-Math.sqrt(Math.max(0,radius*radius-(radius-y)*(radius-y)));
        result.push({x:r.x+inset,y:r.y+step*height,width:r.width-2*inset,height});
        result.push({x:r.x+inset,y:r.y+r.height-(step+1)*height,width:r.width-2*inset,height});
      }
      if(r.height>2*radius)result.push({x:r.x,y:r.y+radius,width:r.width,height:r.height-2*radius});
      return result;
    });
  };
  const snapshot=()=>({focused:document.hasFocus(),hidden:document.hidden,generation,overlayReady:!count||(!nodes().length&&!resuming&&!gateFailed)||acknowledged===generation,moving:nodes().some(node=>node.getAnimations?.().some(animation=>animation.playState==='running')),gate:{status:gateStatus,pending:pendingGate,resuming:!!resuming,queued:!!gateTask,frameScheduled:!!frame,acknowledged,nativePanels:count,failed:gateFailed},viewport:{width:innerWidth,height:innerHeight,scale:window.visualViewport?.scale||1},blockInput:nodes().some(inputOnly),overlays:overlayRects()});
  const gateGeometry=()=>{
    const current=nodes().map(node=>{let id=identities.get(node);if(!id){id=nextIdentity++;identities.set(node,id);}return id;});
    const next=JSON.stringify(current);
    // Geometry and clip move every animation frame. Only a changed overlay
    // owner set needs a fresh hide receipt; same-owner movement is handled by
    // the atomic native rect+clip transaction.
    if(count&&next!==overlayIdentity&&current.length){acknowledged=0;document.documentElement.removeAttribute('data-native-overlays-ready');}
    overlayIdentity=next;
  };
  const prepareOverlay=async(forceHide=false)=>{
    const native=window.termdockDesktop.nativeTerminal;
    if(!native?.available||!count)return;
    const current=++generation, failureVersion=recoveryVersion;
    document.documentElement.removeAttribute('data-native-overlays-ready');
    let receipt;
    try {
      if(!forceHide){
        gateStatus='clip-requested';
        const viewport={width:innerWidth,height:innerHeight};
        const holes=overlayRects().map(r=>[r.x,r.y,r.width,r.height]);
        receipt=await native.request({action:'prepareOverlay',generation:String(current),viewportWidth:viewport.width,viewportHeight:viewport.height,holes,blockInput:nodes().some(inputOnly)});
        if(receipt?.ready!==true||receipt.generation!==String(current)||!Array.isArray(receipt.views))throw new Error('Native overlay clip was not confirmed');
      } else {
        gateStatus='hide-requested';
        receipt=await native.request({action:'hideAll',generation:String(current)});
        if(receipt?.hidden!==true||receipt.generation!==String(current)||!Array.isArray(receipt.views))throw new Error('Native overlay hide was not confirmed');
      }
    } catch(error) {
      // Preserve the first safe ACK. A rejected local clip falls back to the
      // established confirmed hide, and only then to retiring these surfaces.
      try {
        if(forceHide)throw error;
        gateStatus='hide-requested';
        receipt=await native.request({action:'hideAll',generation:String(current)});
        if(receipt?.hidden!==true||receipt.generation!==String(current)||!Array.isArray(receipt.views))throw Error('Native overlay hide was not confirmed');
      } catch {
        if(current===generation)gateStatus='detach-requested';
        receipt=await native.request({action:'retireAll',generation:String(current)});
        if(receipt?.hidden!==true||receipt.retired!==true||receipt.generation!==String(current)||!Array.isArray(receipt.views))throw error;
        window.dispatchEvent(new CustomEvent('termdock:preview-error',{detail:String(error)}));
      }
    }
    if(current!==generation||failureVersion!==recoveryVersion)return false;
    acknowledged=current;gateFailed=false;gateStatus=receipt.retired?'detach-confirmed':receipt.hidden?'hide-confirmed':'clip-confirmed';
    document.documentElement.setAttribute('data-native-overlays-ready','true');
    return true;
  };
  const updateGate=()=>{
    gateGeometry();
    const value=snapshot();
    if(count&&nodes().length&&!acknowledged&&!pendingGate&&!gateFailed){
      pendingGate=true;
      let superseded=false;
      lastGate=prepareOverlay().then(confirmed=>{superseded=confirmed===false;if(!superseded)for(const listener of listeners)listener(snapshot());}).catch(error=>showFailure(error,()=>prepareOverlay(true))).finally(()=>{pendingGate=false;if(superseded)notify();});
    } else {
      if(!nodes().length&&acknowledged){
        acknowledged=0;const current=++generation;resuming=current;gateStatus='resume-requested';
        document.documentElement.removeAttribute('data-native-overlays-ready');
        lastGate=window.termdockDesktop.nativeTerminal.request({action:'resumeAll',generation:String(current)}).then(receipt=>{
          if(receipt?.generation!==String(current)||typeof receipt.epoch!=='string')throw Error('Native overlay resume was not confirmed');
          if(resuming===current)resuming=0;
          if(current!==generation){notify();return;}
          gateStatus='resume-confirmed';for(const listener of listeners)listener(snapshot());
        }).catch(error=>{if(resuming===current)resuming=0;if(current!==generation){notify();return;}showFailure(error,()=>prepareOverlay(true));});return;
      }
      if(resuming||gateFailed)return;
      for(const listener of listeners)listener(value);
    }
  };
  const presentation=()=>{
    if(frame)return;
    // Repeated geometry/motion observation remains frame driven; it never substitutes
    // for a completed main-thread safety receipt.
    frame=requestAnimationFrame(()=>{frame=0;updateGate();if(snapshot().moving)presentation();});
  };
  const notify=()=>{
    // Safety transitions must not depend on WK dispatching presentation frames.
    // At most one DOM-turn job and one hide/detach transaction can be pending.
    if(!gateTask){
      const task={installation};gateTask=task;
      queueMicrotask(()=>{if(gateTask!==task)return;gateTask=null;if(!installed||task.installation!==installation)return;updateGate();});
    }
    presentation();
  };
  const install=()=>{
    if(installed)return;installed=true;installation++;
    const style=document.createElement('style');
    style.dataset.nativeOverlayGate='true';
    style.textContent=`html[data-native-panels]:not([data-native-overlays-ready]) :is(${selector}):not([data-native-recovery]) {visibility:hidden !important}`;
    document.head.append(style);
    observer=new MutationObserver(records=>{
      // Ignore our own gate attributes; observing them creates an ACK loop.
      if(records.every(record=>record.target===document.documentElement&&record.type==='attributes'))return;
      gateGeometry(); // MutationObserver runs before the next overlay paint.
      notify();
    });
    observer.observe(document.documentElement,{subtree:true,childList:true,attributes:true,attributeFilter:['class','style','hidden','aria-hidden','aria-modal','role','inert']});
    for(const name of ['focus','blur','resize','termdock:preview-layout'])window.addEventListener(name,notify);
    document.addEventListener('visibilitychange',notify);window.visualViewport?.addEventListener('resize',notify);
  };
  window.termdockPreviewLifecycle=Object.freeze({snapshot,prepareOverlay, settled:()=>lastGate,
    nativePanels(active){count=Math.max(0,count+(active?1:-1));install();generation++;acknowledged=0;document.documentElement.toggleAttribute('data-native-panels',count>0);document.documentElement.removeAttribute('data-native-overlays-ready');notify();},
    subscribe(listener){listeners.add(listener);install();listener(snapshot());return()=>{listeners.delete(listener);if(listeners.size||count)return;observer?.disconnect();installed=false;installation++;gateTask=null;cancelAnimationFrame(frame);frame=0;document.querySelector('[data-native-overlay-gate]')?.remove();for(const name of ['focus','blur','resize','termdock:preview-layout'])window.removeEventListener(name,notify);document.removeEventListener('visibilitychange',notify);window.visualViewport?.removeEventListener('resize',notify);};},
  });
})();
