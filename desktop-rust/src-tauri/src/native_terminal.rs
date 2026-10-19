//! All surfaces live exclusively on the AppKit thread. The async IPC handler
//! sends plain requests, never a NativePanel/NSView across threads.
use crate::{
    native_contract::{self, Context, Cursor, Request},
    shell,
};
use base64::{engine::general_purpose::STANDARD, Engine};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    cell::RefCell,
    collections::BTreeMap,
    ptr::NonNull,
    sync::{
        atomic::{AtomicBool, AtomicUsize, Ordering},
        Arc, Mutex, OnceLock,
    },
};
use tauri::{AppHandle, Manager, WebviewWindow};
use termdock_native_terminal::{
    macos::{NativePanel, Rect, SnapshotCapture},
    HostEvent, Ownership, Submission,
};
extern "C" {
    fn td_preview_register_font(path: *const std::ffi::c_char) -> i32;
}
thread_local! {static FONTS_READY: RefCell<bool> = const {RefCell::new(false)};}
fn register_fonts(app: &AppHandle) -> Result<(), String> {
    FONTS_READY.with(|ready| {
        if *ready.borrow() {
            return Ok(());
        }
        let root = app
            .path()
            .resolve("native-terminal", tauri::path::BaseDirectory::Resource)
            .map_err(fail)?
            .canonicalize()
            .map_err(fail)?;
        let manifest: Value =
            serde_json::from_slice(&std::fs::read(root.join("manifest.json")).map_err(fail)?)
                .map_err(fail)?;
        for font in manifest["fonts"]
            .as_array()
            .ok_or("Missing native font manifest")?
        {
            let relative = font["path"].as_str().ok_or("Invalid font path")?;
            let path = root.join(relative).canonicalize().map_err(fail)?;
            if !path.starts_with(&root) {
                return Err("Native font escaped resource root".into());
            }
            let bytes = std::fs::read(&path).map_err(fail)?;
            if bytes.len() as u64 != font["size"].as_u64().ok_or("Invalid native font size")?
                || hex::encode(Sha256::digest(&bytes))
                    != font["sha256"].as_str().ok_or("Invalid native font hash")?
            {
                return Err("Native font differs from signed resource manifest".into());
            }
            let text = std::ffi::CString::new(path.to_string_lossy().as_bytes()).map_err(fail)?;
            if unsafe { td_preview_register_font(text.as_ptr()) } != 1 {
                return Err(format!("CoreText did not register {}", font["family"]));
            }
        }
        *ready.borrow_mut() = true;
        Ok(())
    })
}
struct Entry {
    panel: NativePanel,
    context: Context,
    token: String,
    checkpoint: Option<(u64, Cursor)>,
    pending_cursor: Option<(u64, Cursor)>,
    rect: Option<Rect>,
    clip_generation: Option<String>,
    visible: bool,
    durable: Option<termdock_native_terminal::core::DurableSnapshot>,
    logical_font_size: f64,
    zoom: f64,
    copy_request: Option<(String, std::time::Instant)>,
}
thread_local! { static PANELS: RefCell<BTreeMap<(String,String),Entry>> = const { RefCell::new(BTreeMap::new()) }; }
thread_local! { static OVERLAYS: RefCell<BTreeMap<String,String>> = const { RefCell::new(BTreeMap::new()) }; }
static COUNT: AtomicUsize = AtomicUsize::new(0);
static CLOSE_REGISTRY: OnceLock<Mutex<crate::native_lifetime::Registry>> = OnceLock::new();
fn close_registry()->&'static Mutex<crate::native_lifetime::Registry>{CLOSE_REGISTRY.get_or_init(||Mutex::new(Default::default()))}
fn view_stamp(key:&(String,String),entry:&Entry)->crate::native_lifetime::ViewStamp{
 crate::native_lifetime::ViewStamp{window:key.0.clone(),view:key.1.clone(),service:entry.context.service.clone(),target:entry.context.target.clone(),token:entry.token.clone()}
}
fn sync_close_registry(panels:&BTreeMap<(String,String),Entry>)->Result<(),String>{
 close_registry().lock().unwrap().replace(panels.iter().map(|(key,entry)|view_stamp(key,entry)))
}
static SIGNAL: std::sync::OnceLock<std::sync::mpsc::SyncSender<AppHandle>> =
    std::sync::OnceLock::new();
fn signal(app: AppHandle) {
    let tx = SIGNAL.get_or_init(|| {
        let (tx, rx) = std::sync::mpsc::sync_channel::<AppHandle>(1);
        std::thread::spawn(move || {
            while let Ok(app) = rx.recv() {
                let (done, wait) = std::sync::mpsc::sync_channel(1);
                let current = app.clone();
                if app
                    .run_on_main_thread(move || {
                        pump(&current);
                        let _ = done.send(());
                    })
                    .is_err()
                {
                    break;
                }
                if wait.recv().is_err() {
                    break;
                }
            }
        });
        tx
    });
    // One coalesced wake can wait while the current main-thread pump runs.
    // No timer, idle draw, idle IPC, or unbounded main-thread task backlog.
    let _ = tx.try_send(app);
}
fn fail(error: impl std::fmt::Display) -> String {
    error.to_string()
}
fn token(request: &Request) -> Option<&str> {
    match request {
        Request::Create { .. }
        | Request::HideAll { .. }
        | Request::PrepareOverlay { .. }
        | Request::ResumeAll { .. }
        | Request::RetireAll { .. }
        | Request::CloseAllViews { .. }
        | Request::CloseView { .. }
        | Request::RetireView { .. } => None,
        Request::Clip { token, .. }
        | Request::ClipboardText { token, .. }
        | Request::CopyText { token, .. }
        | Request::Menu { token, .. }
        | Request::Capture { token, .. }
        | Request::Restore { token, .. }
        | Request::Policy { token, .. }
        | Request::History { token, .. }
        | Request::Write { token, .. }
        | Request::Inspect { token, .. }
        | Request::Layout { token, .. }
        | Request::LocalReset { token, .. }
        | Request::Rect { token, .. }
        | Request::Visible { token, .. }
        | Request::Focus { token, .. }
        | Request::Palette { token, .. }
        | Request::Cursor { token, .. }
        | Request::Font { token, .. }
        | Request::FontSize { token, .. }
        | Request::Search { token, .. }
        | Request::Paste { token, .. }
        | Request::Copy { token, .. }
        | Request::Command { token, .. }
        | Request::Checkpoint { token, .. }
        | Request::Destroy { token, .. } => Some(token),
    }
}
fn pump(app: &AppHandle) {
    PANELS.with(|panels| {
        let mut panels=panels.borrow_mut();
        for (key, entry) in panels.iter_mut() {
            let events=match entry.panel.pump() { Ok(events)=>events, Err(error)=>vec![HostEvent::Fatal(error.to_string())] };
            // Save only a real consumption ACK, including when the old page
            // has reloaded before its JS callback can send a checkpoint IPC.
            for event in &events {
                if let HostEvent::Ack(ack)=event {
                    if entry.pending_cursor.as_ref().is_some_and(|(sequence,_)|*sequence==ack.sequence){entry.checkpoint=entry.pending_cursor.take();}
                }
            }
            let Some(window)=app.get_webview_window(&entry.context.window) else {continue};
            // A reloaded page cannot receive old queued input or consumption ACK.
            if shell::native_context(app,&window).ok().as_ref()!=Some(&entry.context) {continue;}
            for event in events {
                if matches!(&event,HostEvent::Ack(_)) {
                    static ACK_OBSERVED:AtomicBool=AtomicBool::new(false);
                    if !ACK_OBSERVED.swap(true,Ordering::Relaxed){eprintln!("Termdock native output consumption confirmed");}
                }
                if let HostEvent::FileDrop(paths) = event {
                    if shell::publish_native_drop(app, &window, &key.1, paths).is_err() {
                        shell::report_native_drop_error(&window, &key.1);
                    }
                    continue;
                }
                let value=match event {
                    HostEvent::Input(bytes)=>json!({"type":"input","base64":STANDARD.encode(bytes)}),
                    HostEvent::Wheel(data)=>json!({"type":"wheel","wheel":serde_json::from_str::<Value>(&data).unwrap_or(Value::Null)}),
                    HostEvent::PointerPressed=>json!({"type":"pointer"}),
                    HostEvent::FocusChanged{focused,revision}=>json!({"type":"focusChanged","focused":focused,"revision":revision}),
                    HostEvent::Resize{columns,rows}=>json!({"type":"resize","cols":columns,"rows":rows}),
                    HostEvent::Ack(ack)=>json!({"type":"ack","sequence":ack.sequence,"duplicate":ack.duplicate}),
                    HostEvent::Ready=>{
                        let position=entry.panel.cursor().ok().map(|(x,y)|json!({"x":x,"y":y,"rows":entry.panel.dimensions().1}));
                        json!({"type":"ready","position":position})
                    },
                    HostEvent::Selection(text)=>json!({"type":"selection","text":text}),
                    HostEvent::Title(text)=>json!({"type":"title","text":text}),
                    HostEvent::Bell=>json!({"type":"bell"}),
                    HostEvent::SearchRequested(text)=>json!({"type":"search","text":text}),
                    HostEvent::CloseRequested=>json!({"type":"close"}),
                    HostEvent::Shortcut{key_code,modifiers,key}=>{
                        let copy_id=if modifiers&15==8&&key.eq_ignore_ascii_case("c") {
                            let id=uuid::Uuid::new_v4().to_string();
                            entry.copy_request=Some((id.clone(),std::time::Instant::now()+std::time::Duration::from_secs(10)));Some(id)
                        } else {None};
                        json!({"type":"shortcut","keyCode":key_code,"modifiers":modifiers,"key":key,"copyId":copy_id})
                    },
                    HostEvent::ClipboardText(text)=>json!({"type":"pasteText","text":text}),
                    HostEvent::OpenLink(text)=>json!({"type":"link","text":text}),
                    HostEvent::PathHit(text)=>json!({"type":"path","text":text}),
                    HostEvent::FileDrop(_)=>continue,
                    HostEvent::PasteRequested=>json!({"type":"paste"}),
                    HostEvent::LayoutRequested=>json!({"type":"layout"}),
                    HostEvent::CopyFailed(code)=>json!({"type":"copyFailed","status":match code {1=>"TooLarge",2=>"Unreadable",_=>"WriteFailed"}}),
                    HostEvent::InputRejected=>json!({"type":"rejected","message":"Native input exceeds the bounded queue"}),
                    HostEvent::Fatal(text)=>json!({"type":"fatal","message":text}),
                };
                let payload=json!({"token":entry.token,"epoch":entry.context.epoch,"event":value});
                let _=window.eval(&format!("window.dispatchEvent(new CustomEvent('termdock:preview-terminal',{{detail:{payload}}}));"));
            }
        }
    });
}
/// Engine bootstrap owns only its trusted caller window, including old target
/// surfaces. A missing new service pin cannot prevent entering the login page.
pub async fn detach_previous_engine(app:AppHandle,window:WebviewWindow,epoch:String)->Result<Value,String>{
 let (tx,rx)=tokio::sync::oneshot::channel();
 let current=app.clone();
 app.run_on_main_thread(move||{
  let result=(||{
   shell::check_caller(&current,&window)?;
   let current_epoch=shell::page_epoch(&window).ok_or("Engine bootstrap page is missing")?;
   if current_epoch!=epoch{return Err("Engine bootstrap belongs to an old page".into());}
   PANELS.with(|panels|{
    let mut panels=panels.borrow_mut();
    let mut retired=Vec::new();
    for (key,entry) in panels.iter(){
     if crate::native_lifetime::engine_bootstrap_retires(window.label(),&epoch,&current_epoch,&key.0,&entry.context.epoch)?{retired.push(key.clone());}
    }
    let count=retired.len();for key in retired{panels.remove(&key);}
    COUNT.store(panels.len(),Ordering::Release);sync_close_registry(&panels)?;
    OVERLAYS.with(|overlays|overlays.borrow_mut().remove(window.label()));
    Ok(json!({"detached":true,"epoch":epoch,"remaining":0,"retiredCount":count}))
   })
  })();let _=tx.send(result);
 }).map_err(fail)?;
 rx.await.map_err(|_|"Engine detach acknowledgement was lost".to_string())?
}
pub fn invalidate(app: &AppHandle, label: &str, destroy: bool) {
    let label = label.to_owned();
    let _ = app.run_on_main_thread(move || {
        PANELS.with(|panels| {
            let mut panels = panels.borrow_mut();
            if destroy {
                panels.retain(|(window, _), _| window != &label);
            } else {
                for ((window, _), entry) in panels.iter_mut() {
                    if window == &label {
                        let _ = entry.panel.set_visible(false);
                        entry.visible = false;
                    }
                }
            }
            COUNT.store(panels.len(), Ordering::Release);
            let _=sync_close_registry(&panels);
        })
    });
}
pub async fn dispatch(app: AppHandle, window: WebviewWindow, args: Value,trace_id:Option<usize>,request_epoch:Option<String>) -> Result<Value, String> {
    let trace_action=args["action"].as_str().unwrap_or("invalid").to_owned();
    let request: Request = serde_json::from_value(args).map_err(fail)?;
    let context = shell::native_context(&app, &window)?;
    if request_epoch.as_deref().is_some_and(|expected|expected!=context.epoch){return Err("Native request belongs to an old engine page".into());}
    context.validate()?;
    // Capture before enqueueing AppKit work. Metadata holds no NSView/engine.
    let close_scope=if matches!(&request,Request::CloseView{..}|Request::CloseAllViews{..}){
        close_registry().lock().unwrap().capture(&context.window,&context.service,&context.target)
    }else{Default::default()};
    crate::native_gate::native_event(&window,"context-validated",&trace_action,trace_id,Some(&context.epoch),"");
    let (tx, rx) = tokio::sync::oneshot::channel();
    let current = app.clone();
    let caller = window.clone();
    crate::native_gate::native_event(&window,"main-thread-host-scheduled",&trace_action,trace_id,Some(&context.epoch),"");
    shell::with_native_host(&window,move |host| {
        crate::native_gate::native_event(&caller,"main-thread-host-entered",&trace_action,trace_id,Some(&context.epoch),if host.is_ok(){"host-present"}else{"host-error"});
        let result=(|| {
            let host=host?;
            if shell::native_context(&current,&caller)?!=context {return Err("Native page or target changed before main-thread execution".into());}
            if let Request::Menu{token,id}=&request {
                let owns=PANELS.with(|panels|panels.borrow().values().any(|entry|entry.token==*token&&entry.context==context));
                let commands:Value=serde_json::from_str(include_str!("../../renderer/commands.json")).map_err(fail)?;
                if !owns||!commands.as_array().unwrap().iter().any(|command|command["id"].as_str()==Some(id)){return Err("Invalid native menu capability".into());}
                crate::desktop_ui::menu_event(&current,id);return Ok(Value::Null);
            }
            PANELS.with(|panels| {
                let mut panels=panels.borrow_mut();
                let registry_change=matches!(&request,Request::Create{..}|Request::LocalReset{..}|Request::Restore{..}|Request::Destroy{..}|Request::CloseView{..}|Request::CloseAllViews{..}|Request::RetireView{..}|Request::RetireAll{..});
                let result=(|| {
                if matches!(request,Request::CloseAllViews{..}) {
                    let mut retired=Vec::new();
                    panels.retain(|key,entry|{let remove=close_scope.includes(&view_stamp(key,entry));if remove{retired.push(json!({"view":key.1,"token":entry.token}));}!remove});
                    COUNT.store(panels.len(),Ordering::Release);return Ok(json!({"detached":true,"epoch":context.epoch,"retired":retired,"remaining":panels.keys().filter(|(window,_)|window==&context.window).count()}));
                }
                if let Request::CloseView{view}=&request {
                    native_contract::validate_id(view)?;
                    let key=(context.window.clone(),view.clone());
                    if let Some(entry)=panels.get(&key){
                        if entry.context.service!=context.service||entry.context.target!=context.target{return Err("Explicit close belongs to another service/target".into());}
                        if !close_scope.permits_view(Some(&view_stamp(&key,entry))){return Err("Native view changed before explicit close; not detached".into());}
                    }
                    panels.remove(&key);COUNT.store(panels.len(),Ordering::Release);
                    return Ok(json!({"detached":true,"view":view,"epoch":context.epoch}));
                }
                if let Request::RetireView{view,token}=&request {
                    native_contract::validate_id(view)?;
                    let key=(context.window.clone(),view.clone());
                    let requested=crate::native_lifetime::ViewStamp{window:context.window.clone(),service:context.service.clone(),target:context.target.clone(),view:view.clone(),token:token.clone().ok_or("Native retirement requires its surface token")?};
                    if let Some(entry)=panels.get(&key) {
                        if entry.context.service!=context.service||entry.context.target!=context.target{return Err("Native retirement belongs to another service/target".into());}
                    }
                    let disposition=match close_registry().lock().unwrap().retirement(&requested)? {
                        crate::native_lifetime::Retirement::Superseded{replacement_token}=>{
                            if panels.get(&key).is_none_or(|entry|entry.token!=replacement_token){return Err("Native replacement retirement metadata is not synchronized".into());}
                            return Ok(json!({"detached":false,"disposition":"superseded","view":view,"token":token,"replacementToken":replacement_token,"epoch":context.epoch}));
                        },
                        crate::native_lifetime::Retirement::Current=>{
                            if panels.get(&key).is_none_or(|entry|view_stamp(&key,entry)!=requested){return Err("Native retirement metadata is not synchronized".into());}
                            panels.remove(&key);"current"
                        },
                        crate::native_lifetime::Retirement::Absent=>{
                            if panels.contains_key(&key){return Err("Native absent retirement metadata is not synchronized".into());}"absent"
                        },
                    };
                    COUNT.store(panels.len(),Ordering::Release);
                    return Ok(json!({"detached":true,"disposition":disposition,"view":view,"token":token,"epoch":context.epoch}));
                }
                if let Request::RetireAll{generation}=&request {
                    native_contract::validate_id(generation)?;
                    let mut views=Vec::new();
                    panels.retain(|(label,view),entry| {
                        if label!=&context.window{return true;}
                        views.push(view.clone());
                        let payload=json!({"token":entry.token,"epoch":context.epoch,"event":{"type":"fatal","message":"Native overlay isolation failed; rendering surface was detached. The PTY remains on the service."}});
                        let _=caller.eval(&format!("window.dispatchEvent(new CustomEvent('termdock:preview-terminal',{{detail:{payload}}}));"));
                        false // NativePanel::drop removes the actual AppKit sibling.
                    });
                    COUNT.store(panels.len(),Ordering::Release);
                    OVERLAYS.with(|gates|gates.borrow_mut().remove(&context.window));
                    return Ok(json!({"generation":generation,"epoch":context.epoch,"views":views,"hidden":true,"retired":true}));
                }
                if let Request::PrepareOverlay{generation,viewport_width,viewport_height,holes}=&request {
                    native_contract::validate_id(generation)?;
                    if holes.len()>64||![*viewport_width,*viewport_height].iter().all(|v|v.is_finite()&&*v>0.0&&*v<=32768.0)
                        ||holes.iter().flatten().any(|v|!v.is_finite())
                        ||holes.iter().any(|r|r[2]<0.0||r[3]<0.0||!(r[0]+r[2]).is_finite()||!(r[1]+r[3]).is_finite()) {
                        return Err("Invalid first-frame native overlay geometry".into());
                    }
                    // Keep the DOM first-paint gate closed while every current
                    // surface receives its local cutout. A failed partial pass
                    // falls back to the existing confirmed whole-surface hide.
                    OVERLAYS.with(|gates|gates.borrow_mut().insert(context.window.clone(),generation.clone()));
                    let mut views=Vec::new();
                    for ((label,view),entry) in panels.iter_mut() {
                        if label!=&context.window {continue;}
                        views.push(view.clone());
                        if let Some(rect)=entry.rect {
                            let clipped=native_contract::overlay_holes_in_panel(holes,(*viewport_width,*viewport_height),(host.x,host.y,host.width,host.height),(rect.x,rect.y,rect.width,rect.height))?;
                            let union=native_contract::union_rectangles(&clipped)?;
                            let layout=entry.panel.set_layout(rect,&union,entry.visible).map_err(fail);
                            native_contract::confirm_layout_visibility(&mut entry.visible,layout)?;
                        }
                        entry.clip_generation=Some(generation.clone());
                    }
                    return Ok(json!({"ready":true,"generation":generation,"epoch":context.epoch,"views":views}));
                }
                if let Request::HideAll{generation}= &request {
                    native_contract::validate_id(generation)?;
                    OVERLAYS.with(|gates|gates.borrow_mut().insert(context.window.clone(),generation.clone()));
                    let mut views=Vec::new();
                    for ((label,view),entry) in panels.iter_mut() {
                        if label==&context.window {
                            entry.panel.set_visible(false).map_err(fail)?;
                            entry.visible = false;
                            views.push(view.clone());
                        }
                    }
                    // NSView.hidden and AppKit composition cancellation completed
                    // synchronously above. Engine focus/preedit barrier is separate.
                    return Ok(json!({"generation":generation,"epoch":context.epoch,"views":views,"hidden":true}));
                }
                if let Request::ResumeAll{generation}= &request {
                    native_contract::validate_id(generation)?;
                    OVERLAYS.with(|gates|gates.borrow_mut().remove(&context.window));
                    return Ok(json!({"generation":generation,"epoch":context.epoch}));
                }
                if let Request::Create{view,session,device,options,font_size,viewport_width,viewport_height}= &request {
                    crate::native_gate::native_event(&caller,"create-font-register-start",&trace_action,trace_id,Some(&context.epoch),"");
                    register_fonts(&current)?;
                    crate::native_gate::native_event(&caller,"create-font-register-end",&trace_action,trace_id,Some(&context.epoch),"ok");
                    for value in [view,session,device] {native_contract::validate_id(value)?;}
                    native_contract::rect_in_host(0.,0.,*viewport_width,*viewport_height,(*viewport_width,*viewport_height),(host.width,host.height))?;
                    if !font_size.is_finite()||!(6.0..=100.0).contains(font_size){return Err("Invalid logical terminal font size".into());}
                    let zoom=shell::state(&current).zooms.lock().unwrap().get(&context.window).copied().unwrap_or(1.);
                    if !native_contract::viewport_matches_host((*viewport_width,*viewport_height),(host.width,host.height),zoom) {
                        return Err(termdock_native_terminal::Error::Backpressure.to_string());
                    }
                    let key=(context.window.clone(),view.clone());
                    let owner=Ownership {service:context.service.clone(),target:context.target.clone(),session:session.clone(),device:device.clone(),window:context.window.clone(),view:view.clone(),epoch:context.epoch.clone()};
                    let mut previous_snapshot=None;
                    if let Some(entry)=panels.get_mut(&key) {
                        let old=entry.panel.ownership();
                        if old.session==*session && old.device==*device && old.target==context.target && old.service==context.service {
                            // Preserve the full living VT even beyond the 8MiB
                            // replay limit. Never replay into already consumed state.
                            // Check the actual IO barrier before deciding which
                            // renderer state can be reused. A page may disappear
                            // between fragments of one stream event.
                            entry.panel.confirm_checkpoint(entry.panel.last_sequence()).map_err(fail)?;
                            let (previous,physical_font_size)=entry.panel.snapshot_options();
                            if previous.font!=options.font {
                                entry.panel.set_font(options.font.clone()).map_err(fail)?;
                                return Err(termdock_native_terminal::Error::Backpressure.to_string());
                            }
                            if physical_font_size!=*font_size*zoom {
                                entry.panel.set_font_size(*font_size*zoom).map_err(fail)?;entry.logical_font_size=*font_size;entry.zoom=zoom;
                                return Err(termdock_native_terminal::Error::Backpressure.to_string());
                            }
                            if previous.palette!=options.palette {
                                entry.panel.set_palette(options.palette.clone()).map_err(fail)?;
                                return Err(termdock_native_terminal::Error::Backpressure.to_string());
                            }
                            if previous.cursor_visible!=options.cursor_visible || previous.cursor_blink!=options.cursor_blink {
                                entry.panel.set_cursor(options.cursor_visible,options.cursor_blink).map_err(fail)?;
                                return Err(termdock_native_terminal::Error::Backpressure.to_string());
                            }
                            if previous.history!=options.history {
                                entry.panel.set_history(options.history).map_err(fail)?;
                                return Err(termdock_native_terminal::Error::Backpressure.to_string());
                            }
                            if let Some((sequence,cursor))=entry.checkpoint.clone().filter(|(sequence,_)|*sequence==entry.panel.last_sequence()) {
                                entry.panel.bind_webview(NonNull::new(host.wk_view).ok_or("Missing owned WK host")?).map_err(fail)?;
                                entry.panel.rebind_epoch(owner).map_err(fail)?;
                                entry.context=context.clone();entry.token=uuid::Uuid::new_v4().to_string();
                                let (cols,rows)=entry.panel.dimensions();
                                return Ok(json!({"token":entry.token,"epoch":context.epoch,"sequence":sequence,"baseline":cursor,"reused":true,"dimensions":{"cols":cols,"rows":rows}}));
                            }
                            // There is no byte-to-stream cursor for a partial
                            // event. Reuse only the last complete durable entry;
                            // otherwise ask the same PTY for original recovery.
                            previous_snapshot=entry.durable.clone();
                        }
                        // A different backend PTY is a different terminal state.
                        panels.remove(&key);
                    }
                    if panels.len()>=32 {return Err("Native surface limit (32) reached".into());}
                    let parent=NonNull::new(host.parent).ok_or("Native common NSView is absent")?;
                    crate::native_gate::native_event(&caller,"create-engine-start",&trace_action,trace_id,Some(&context.epoch),"");
                    let mut panel=unsafe {NativePanel::create(parent,options.clone(),owner,*font_size*zoom)}.map_err(fail)?;
                    panel.bind_webview(NonNull::new(host.wk_view).ok_or("Missing owned WK host")?).map_err(fail)?;
                    crate::native_gate::native_event(&caller,"create-engine-return",&trace_action,trace_id,Some(&context.epoch),"ok");
                    let wake_app=current.clone();panel.set_waker(Arc::new(move ||signal(wake_app.clone())));
                    let token=uuid::Uuid::new_v4().to_string();
                    panels.insert(key,Entry{panel,context:context.clone(),token:token.clone(),checkpoint:None,pending_cursor:None,rect:None,clip_generation:None,visible:false,durable:previous_snapshot.clone(),logical_font_size:*font_size,zoom,copy_request:None});
                    COUNT.store(panels.len(),Ordering::Release);
                    return Ok(json!({"token":token,"epoch":context.epoch,"sequence":0,"baseline":null,"reused":false,"snapshot":previous_snapshot,"dimensions":{"cols":options.columns,"rows":options.rows}}));
                }
                let capability=token(&request).ok_or("Missing native capability")?;
                let key=panels.iter().find(|(_,e)| e.token==capability && e.context==context).map(|(key,_)|key.clone()).ok_or("Native capability belongs to another window/page/target")?;
                if matches!(request,Request::Destroy{..}) {panels.remove(&key);COUNT.store(panels.len(),Ordering::Release);return Ok(Value::Null);}
                let surface_count=panels.len();
                let entry=panels.get_mut(&key).unwrap();
                entry.panel.bind_webview(NonNull::new(host.wk_view).ok_or("Missing owned WK host")?).map_err(fail)?;
                match request {
                    Request::Clip{holes,generation,viewport_width,viewport_height,..}=>{
                        if holes.len()>64{return Err("Too many native clip holes".into());}
                        let allowed=OVERLAYS.with(|gates|gates.borrow().get(&context.window).cloned());
                        if !holes.is_empty()&&allowed.as_deref()!=Some(&generation){return Err("Native clip belongs to a stale overlay generation".into());}
                        let rect=entry.rect.ok_or("Native rect has not been applied")?;let mut clipped=Vec::new();
                        for hole in holes {
                            let (x,y,w,h)=native_contract::rect_in_host(hole[0].max(0.),hole[1].max(0.),hole[2].min(viewport_width-hole[0].max(0.)),hole[3].min(viewport_height-hole[1].max(0.)),(viewport_width,viewport_height),(host.width,host.height))?;
                            clipped.push([host.x+x-rect.x,host.y+y-rect.y,w,h]);
                        }
                        let union=native_contract::union_rectangles(&clipped)?;entry.panel.clip(&union).map_err(fail)?;entry.clip_generation=allowed;
                        Ok(json!({"clipped":true,"generation":generation,"epoch":context.epoch}))
                    },
                    Request::CopyText{copy_id,text,..}=>{
                        // A single OS Command-C grants one bounded local write.
                        // The panel token/context above binds it to this page and target.
                        native_contract::claim_copy(&mut entry.copy_request,&copy_id,&text,std::time::Instant::now())?;
                        arboard::Clipboard::new().map_err(fail)?.set_text(text).map_err(fail)?;
                        Ok(json!({"copied":true}))
                    },
                    Request::ClipboardText{..}=>{
                        let text=match arboard::Clipboard::new().map_err(fail)?.get_text(){Ok(text)=>text,Err(arboard::Error::ContentNotAvailable)=>String::new(),Err(error)=>return Err(fail(error))};
                        if text.len()>256*1024{return Err("Clipboard text exceeds 256KiB".into());}Ok(json!(text))
                    },
                    Request::Capture{sequence,cursor,..}=>{
                        entry.panel.confirm_checkpoint(sequence).map_err(fail)?;
                        let data=match entry.panel.capture_snapshot().map_err(fail)? {
                            SnapshotCapture::Captured(data)=>data,
                            SnapshotCapture::Unsafe=>return Ok(json!({"status":"Unsafe"})),
                            SnapshotCapture::Unsupported=>return Ok(json!({"status":"Unsupported"})),
                            SnapshotCapture::TooLarge=>return Ok(json!({"status":"TooLarge"})),
                        };
                        let (options,font_size)=entry.panel.snapshot_options();
                        let data_sha256=hex::encode(Sha256::digest(data.as_bytes()));
                        let snapshot=termdock_native_terminal::core::DurableSnapshot{version:1,engine:termdock_native_terminal::core::ENGINE.into(),owner:entry.panel.ownership().clone(),options,font_size,data,data_sha256,cursor:termdock_native_terminal::core::StreamCursor{seq:cursor.seq,epoch:cursor.epoch}};
                        if !native_contract::snapshot_fits_entry(&snapshot){return Ok(json!({"status":"TooLarge"}));}
                        entry.durable=Some(snapshot.clone());Ok(json!(snapshot))
                    },
                    Request::LocalReset{..}=>{
                        // Confirm all preceding feed consumption before destroying the
                        // old parser, including partial UTF8/OSC/DCS decoder state.
                        let consumed=entry.panel.last_sequence();entry.panel.confirm_checkpoint(consumed).map_err(fail)?;
                        let baseline=entry.checkpoint.as_ref().filter(|(seq,_)|*seq==consumed).map(|(_,cursor)|cursor.clone());
                        let (mut options,font_size)=entry.panel.snapshot_options();
                        let (cols,rows)=entry.panel.dimensions();options.columns=cols;options.rows=rows;
                        let owner=entry.panel.ownership().clone();
                        entry.durable=None;entry.pending_cursor=None;entry.checkpoint=None;
                        entry.panel.close().map_err(fail)?; // drop old VT before creating the one neutral receiver
                        entry.panel=unsafe {NativePanel::create(NonNull::new(host.parent).ok_or("Missing native parent")?,options,owner,font_size)}.map_err(fail)?;
                        native_contract::reset_surface_presentation(&mut entry.rect,&mut entry.visible,&mut entry.clip_generation);
                        entry.panel.bind_webview(NonNull::new(host.wk_view).ok_or("Missing owned WK host")?).map_err(fail)?;
                        let wake_app=current.clone();entry.panel.set_waker(Arc::new(move ||signal(wake_app.clone())));
                        entry.token=uuid::Uuid::new_v4().to_string();entry.checkpoint=baseline.clone().map(|cursor|(0,cursor));
                        entry.clip_generation=None;
                        Ok(json!({"token":entry.token,"epoch":context.epoch,"sequence":0,"baseline":baseline,"reused":false,"dimensions":{"cols":cols,"rows":rows}}))
                    },
                    Request::Restore{snapshot,..}=>{
                        // No network/PTY has started on this fresh receiver.
                        entry.panel.confirm_checkpoint(0).map_err(fail)?;
                        let (options,font_size)=entry.panel.snapshot_options();let owner=entry.panel.ownership().clone();
                        if snapshot.validate(&owner,&options,font_size).is_err()||snapshot.data_sha256!=hex::encode(Sha256::digest(snapshot.data.as_bytes())){return Ok(Value::Null);}
                        entry.panel.close().map_err(fail)?;
                        entry.panel=unsafe {NativePanel::create_from_snapshot(NonNull::new(host.parent).ok_or("Missing native parent")?,options,owner,font_size,snapshot.data)}.map_err(fail)?;
                        native_contract::reset_surface_presentation(&mut entry.rect,&mut entry.visible,&mut entry.clip_generation);
                        entry.panel.bind_webview(NonNull::new(host.wk_view).ok_or("Missing owned WK host")?).map_err(fail)?;
                        let wake_app=current.clone();entry.panel.set_waker(Arc::new(move ||signal(wake_app.clone())));
                        entry.token=uuid::Uuid::new_v4().to_string();entry.checkpoint=Some((1,Cursor{seq:snapshot.cursor.seq,epoch:snapshot.cursor.epoch.clone()}));
                        Ok(json!({"token":entry.token,"epoch":context.epoch,"sequence":1,"baseline":snapshot.cursor,"reused":false}))
                    },
                    Request::Write{sequence,base64,replay,replay_end,cursor,..}=>{
                        if base64.len()>4*termdock_native_terminal::core::MAX_BATCH_BYTES.div_ceil(3) {return Err("Native batch exceeds 256KiB".into());}
                        if let Some(cursor)=&cursor{native_contract::validate_id(&cursor.epoch)?;if cursor.seq==0{return Err("Invalid native stream cursor".into());}}
                        let bytes=STANDARD.decode(base64).map_err(fail)?;
                        let submission=entry.panel.write_with_replay(sequence,&bytes,replay,replay_end).map_err(fail)?;
                        if matches!(submission,Submission::Pending{..}) {entry.checkpoint=None;entry.pending_cursor=cursor.map(|cursor|(sequence,cursor));}
                        match submission {Submission::Pending{sequence}=>Ok(json!({"pending":sequence})),Submission::Duplicate(ack)=>Ok(json!({"duplicate":true,"sequence":ack.sequence}))}
                    },
                    Request::Inspect{..}=>{
                        let wk=NonNull::new(host.wk_view).ok_or("Missing WK host")?;
                        let bits=entry.panel.attachment(wk).map_err(fail)?;
                        let stats=entry.panel.render_stats().map_err(fail)?;
                        let (x,y)=entry.panel.cursor().map_err(fail)?;
                        let geometry=|phase|->Result<Value,String>{Ok(entry.panel.geometry(phase).map_err(fail)?.map(|v|json!({"enginePixels":{"width":v[0],"height":v[1]},"cellPixels":{"width":v[2],"height":v[3]},"grid":{"cols":v[4],"rows":v[5]},"requestedBackingScale":v[6],"viewPoints":{"width":v[7],"height":v[8]},"layerPoints":{"width":v[9],"height":v[10]},"layerContentsScale":v[11],"windowBackingScale":v[12],"wantsLayer":v[13]!=0.,"initialFontPoints":v[14],"configFontPoints":v[15]})).unwrap_or(Value::Null))};
                        let window=NativePanel::window_geometry(wk).map_err(fail)?;
                        let buttons=(0..3).map(|i|{let p=4+i*8;json!({"present":(window[28]as u32)&(1<<i)!=0,"frame":{"x":window[p],"y":window[p+1],"width":window[p+2],"height":window[p+3]},"wkPoints":{"x":window[p+4],"top":window[p+5],"centerX":window[p+6],"centerTop":window[p+7]}})}).collect::<Vec<_>>();
                        let (_,points)=entry.panel.snapshot_options();
                        let metrics=json!({"snapshotScope":"living-surface; create/firstRect may predate this page epoch","history":entry.panel.snapshot_options().0.history,"cssFontSize":entry.logical_font_size,"configuredFontPoints":points,"font":entry.panel.snapshot_options().0.font,"hostZoom":entry.zoom,"hostPoints":{"width":host.width,"height":host.height},"hostBackingScale":host.scale,"created":geometry(1)?,"firstRect":geometry(2)?,"live":geometry(0)?,"window":{"wkWidth":window[0],"wkHeight":window[1],"wkFlipped":window[2]!=0.,"backingScale":window[3],"buttons":buttons,"fullscreen":window[29]!=0.,"width":window[30],"height":window[31]}});
                        Ok(json!({"sibling":bits&1!=0,"hidden":bits&2!=0,"replaying":bits&4!=0,"focused":bits&8!=0,"mainThread":true,"cursor":{"x":x,"y":y},"surfaces":surface_count,"renderAttempts":stats.attempts,"renderSubmissions":stats.submissions,"metrics":metrics}))
                    },
                    Request::Layout{..}=>{
                        entry.panel.confirm_checkpoint(entry.panel.last_sequence()).map_err(fail)?;
                        let (cols,rows)=entry.panel.dimensions();
                        Ok(json!({"complete":true,"token":entry.token,"epoch":context.epoch,"sequence":entry.panel.last_sequence(),"dimensions":{"cols":cols,"rows":rows}}))
                    },
                    Request::Rect{x,y,width,height,viewport_width,viewport_height,holes,generation,..}=>{
                        let zoom=shell::state(&current).zooms.lock().unwrap().get(&context.window).copied().unwrap_or(1.);
                        // During live resize WK and AppKit can report different
                        // generations. Retry without mutating the surface/font.
                        if !native_contract::viewport_matches_host((viewport_width,viewport_height),(host.width,host.height),zoom) {
                            return Ok(json!({"rectApplied":false,"staleGeometry":true}));
                        }
                        let (x,y,w,h)=native_contract::rect_in_host(x,y,width,height,(viewport_width,viewport_height),(host.width,host.height))?;
                        if (zoom-entry.zoom).abs()>0.0001 {
                            entry.panel.set_font_size(entry.logical_font_size*zoom).map_err(fail)?;entry.zoom=zoom;
                            return Err(termdock_native_terminal::Error::Backpressure.to_string());
                        }
                        let rect=Rect{x:host.x+x,y:host.y+y,width:w,height:h,scale:host.scale};
                        if let Some(holes)=holes {
                            if holes.len()>64{return Err("Too many native clip holes".into());}
                            let allowed=OVERLAYS.with(|gates|gates.borrow().get(&context.window).cloned());
                            if allowed.as_ref().is_some_and(|active|generation.as_deref()!=Some(active.as_str()))||(allowed.is_none()&&!holes.is_empty()){return Err("Native layout belongs to a stale overlay generation".into());}
                            let mut clipped=Vec::new();
                            for hole in holes {
                                let left=hole[0].max(0.);let top=hole[1].max(0.);
                                let right=(hole[0]+hole[2]).min(viewport_width);let bottom=(hole[1]+hole[3]).min(viewport_height);
                                if right<=left||bottom<=top{continue;}
                                let (hx,hy,hw,hh)=native_contract::rect_in_host(left,top,right-left,bottom-top,(viewport_width,viewport_height),(host.width,host.height))?;
                                clipped.push([host.x+hx-rect.x,host.y+hy-rect.y,hw,hh]);
                            }
                            let union=native_contract::union_rectangles(&clipped)?;
                            let layout=entry.panel.set_layout(rect,&union,true);
                            if matches!(&layout,Err(termdock_native_terminal::macos::NativeError::LayoutPending)) {
                                entry.rect=Some(rect);entry.clip_generation=allowed;entry.visible=true;
                                return Ok(json!({"rectApplied":false,"layoutPending":true}));
                            }
                            native_contract::confirm_layout_visibility(&mut entry.visible,layout.map_err(fail))?;entry.rect=Some(rect);entry.clip_generation=allowed;entry.visible=true;
                        } else {
                            entry.panel.set_rect(rect).map_err(fail)?;entry.rect=Some(rect);entry.clip_generation=None;
                        }
                        Ok(json!({"rectApplied":true}))
                    },
                    Request::Visible{visible,..}=>{if visible&&OVERLAYS.with(|gates|gates.borrow().get(&context.window).is_some_and(|generation|Some(generation)!=entry.clip_generation.as_ref())){return Err("Native overlay is still active".into());}entry.panel.set_visible(visible).map_err(fail)?;entry.visible=visible;Ok(json!({"visible":visible,"epoch":context.epoch}))},
                    Request::Focus{focused,..}=>{if focused {entry.panel.focus().map_err(fail)?;}else{entry.panel.blur().map_err(fail)?;}Ok(Value::Null)},
                    Request::Palette{palette,..}=>{entry.panel.set_palette(palette).map_err(fail)?;Ok(Value::Null)},
                    Request::Cursor{visible,blink,..}=>{entry.panel.set_cursor(visible,blink).map_err(fail)?;Ok(Value::Null)},
                    Request::Font{font,..}=>{entry.panel.set_font(font).map_err(fail)?;Ok(Value::Null)},
                    Request::Policy{tmux,..}=>{entry.panel.set_scroll_policy(tmux).map_err(fail)?;Ok(Value::Null)},
                    Request::History{history,..}=>{entry.panel.set_history(history).map_err(fail)?;Ok(Value::Null)},
                    Request::FontSize{size,..}=>{if !size.is_finite()||!(6.0..=100.0).contains(&size){return Err("Invalid logical terminal font size".into());}entry.panel.set_font_size(size*entry.zoom).map_err(fail)?;entry.logical_font_size=size;Ok(Value::Null)},
                    Request::Search{needle,direction,..}=>{let result=entry.panel.search(&needle,direction).map_err(fail)?;Ok(json!({"total":result.total,"selected":result.selected}))},
                    Request::Paste{text,..}=>{entry.panel.paste_text(&text).map_err(fail)?;Ok(Value::Null)},
                    Request::Copy{selection,..}=>{let status=entry.panel.copy_text(selection).map_err(fail)?;Ok(json!({"status":status}))},
                    Request::Command{command,..}=>{entry.panel.action(&command).map_err(fail)?;Ok(Value::Null)},
                    Request::Checkpoint{sequence,cursor,..}=>{
                        native_contract::validate_id(&cursor.epoch)?;
                        if sequence!=entry.panel.last_sequence() {return Err("Checkpoint is not the consumed native sequence".into());}
                        entry.panel.confirm_checkpoint(sequence).map_err(fail)?;
                        entry.checkpoint=Some((sequence,cursor));Ok(Value::Null)
                    },
                    _=>Err("Invalid native action".into()),
                }
                })();
                if registry_change{sync_close_registry(&panels)?;}
                result
            })
        })();
        crate::native_gate::native_event(&caller,"main-thread-host-return",&trace_action,trace_id,Some(&context.epoch),if result.is_ok(){"ok"}else{result.as_ref().unwrap_err()});
        if let Err(error)=&result { if !error.contains("pending batch or callbacks must be drained"){eprintln!("Termdock native action {} failed: {}",trace_action,error);} }
        let _=tx.send(result);
        signal(current);
    }).map_err(fail)?;
    rx.await.map_err(fail)?
}

// Only called by the isolated native gate after its ordinary owner checks.
pub(crate) fn keyboard_fixture_owner(context:&Context)->bool {
 PANELS.with(|panels|{let panels=panels.borrow();let entries=panels.values().filter(|entry|entry.context.window==context.window).collect::<Vec<_>>();entries.len()==1&&entries[0].context==*context})
}
