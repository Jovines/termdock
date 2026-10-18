//! Opt-in, isolated product verification. It changes startup data location and
//! drives the ordinary origin-bound WK bridge; it grants no IPC capability.
use crate::config::{Config,Connection};
use std::{path::PathBuf,sync::{OnceLock,Mutex,atomic::{AtomicBool,Ordering}}};
use tauri::{AppHandle,Manager,WebviewWindow};
struct Gate {benchmark_renderer:Option<String>,root:PathBuf,url:String,react:bool,interaction_receiver:bool,interactions:bool,native_feedback:bool,controlled_window_chrome:bool,keyboard_manual:bool,keyboard_before_native:bool,interaction_updates:Mutex<InteractionUpdates>,connection:Option<Connection>,invitation:Option<String>,expected_peer:Option<String>,auth_handoff:Mutex<AuthHandoff>,nonce:String,page_epoch:Mutex<Option<String>>,owner:Mutex<Option<String>>,evidence:Mutex<Evidence>,pulls:Mutex<Pulls>,finished:AtomicBool}
// Inert owned-descriptor state, physically separate from Updater/downloads.
struct InteractionUpdates {allowed:bool,ready:bool,installs:u32,keyboard_next:u32,keyboard_index:u64,keyboard_probe_next:u32,keyboard_probe_step:u32,manual_counter_index:u64,manual_counter_armed:bool,manual_counter_reads:u32,titlebar_restore:Option<(String,String)>}
impl Default for InteractionUpdates {fn default()->Self{Self{allowed:false,ready:true,installs:0,keyboard_next:0,keyboard_index:0,keyboard_probe_next:0,keyboard_probe_step:0,manual_counter_index:0,manual_counter_armed:false,manual_counter_reads:0,titlebar_restore:None}}}
impl InteractionUpdates {
 fn arm_titlebar_restore(&mut self,window:&str,epoch:&str){self.titlebar_restore=Some((window.into(),epoch.into()));}
 fn consume_titlebar_restore(&mut self,window:&str,epoch:&str)->bool{if self.titlebar_restore.as_ref().is_some_and(|(owner,stored_epoch)|owner==window&&stored_epoch==epoch){self.titlebar_restore.take();true}else{false}}
 fn reserve_keyboard(&mut self,case:u32,index:u64)->bool{if case>=6||case!=self.keyboard_next||index<=self.keyboard_index{return false;}self.keyboard_next+=1;self.keyboard_index=index;true}

 fn reserve_keyboard_probe(&mut self,case:u32,index:u64,step:u32)->bool{
  if case>=5||index<=self.keyboard_index{return false;}
  if step==0{if case!=self.keyboard_probe_next||(case>0&&self.keyboard_probe_step!=3){return false;}self.keyboard_probe_next+=1;self.keyboard_probe_step=1;}
  else {if case+1!=self.keyboard_probe_next||step!=self.keyboard_probe_step||step>2{return false;}self.keyboard_probe_step+=1;}
  self.keyboard_index=index;true
 }

 fn reserve_manual_counter(&mut self,arm:bool,index:u64)->bool{
  if index<=self.manual_counter_index{return false;}
  if arm{if self.manual_counter_armed{return false;}self.manual_counter_armed=true;}
  else {if !self.manual_counter_armed||self.manual_counter_reads>=1{return false;}self.manual_counter_reads+=1;}
  self.manual_counter_index=index;true
 }

 fn manual_counter_stage(&mut self,data:&serde_json::Value,epoch:&str)->Option<(bool,u64)>{
  if data["pageEpoch"].as_str()!=Some(epoch){return None;}
  let phase=if self.manual_counter_armed{"manual-keyboard-final"}else{"manual-keyboard-ready"};
  let maximum=data["progressIndex"].as_u64()?;
  let index=data["stages"].as_array()?.iter().find_map(|stage|{
   let index=stage["index"].as_u64()?;
   (stage["phase"]==phase&&stage["pageEpoch"].as_str()==Some(epoch)&&index<=maximum).then_some(index)
  })?;
  let arm=phase=="manual-keyboard-ready";
  self.reserve_manual_counter(arm,index).then_some((arm,index))
 }

 fn snapshot(&self)->serde_json::Value{serde_json::json!({"status":if self.ready{"ready"}else{"idle"},"currentVersion":"0.1.0","latestVersion":"0.1.999","releaseName":"Owned inert desktop update","checkedAt":1,"error":null,"controlledInstallCalls":self.installs,"realOsUpdaterCalled":false})}
 #[cfg(any(target_os="macos",test))]
 fn install(&mut self)->Result<serde_json::Value,String>{if !self.ready||self.installs>=2{return Err("Controlled desktop update is not ready".into());}self.installs+=1;if !self.allowed{return Err("Controlled desktop update failure".into());}self.ready=false;let mut value=self.snapshot();value["status"]=serde_json::json!("restarting");Ok(value)}
}
#[derive(Default)]
struct AuthHandoff {used:bool,pending:Option<serde_json::Value>}
impl AuthHandoff {
 fn arm(&mut self,value:serde_json::Value)->bool{if self.used{return false;}self.used=true;self.pending=Some(value);true}
 fn take(&mut self,epoch:&str)->Option<serde_json::Value>{if self.pending.as_ref().is_some_and(|value|value["oldEpoch"].as_str()!=Some(epoch)){self.pending.take()}else{None}}
}
#[derive(Clone)]
struct Pull {id:usize,window:String,epoch:String,index:u64}
#[derive(Default)]
struct Pulls {active:Option<Pull>,pending:Option<Pull>,issued:usize}
#[derive(Default)]
struct Evidence {latest:Option<serde_json::Value>,host_events:Vec<serde_json::Value>,native_events:std::collections::VecDeque<serde_json::Value>,native_dropped:usize,updates:usize,delivery:std::collections::VecDeque<serde_json::Value>,delivery_count:usize}
impl Evidence {
 fn accept(&mut self,value:serde_json::Value,current_epoch:&str)->bool {
  if self.updates>=2048||value["pageEpoch"].as_str()!=Some(current_epoch)||value["progressIndex"].as_u64().is_none()
   ||value["steps"].as_array().is_none_or(|v|v.len()>64)||value["acks"].as_array().is_none_or(|v|v.len()>128)
   ||value["stages"].as_array().is_none_or(|v|v.len()>128){return false;}
  if self.latest.as_ref().is_some_and(|last|last["pageEpoch"]==value["pageEpoch"]&&last["progressIndex"].as_u64()>=value["progressIndex"].as_u64()){return false;}
  self.updates+=1;self.latest=Some(value);true
 }
 fn augment(&self,mut result:serde_json::Value)->serde_json::Value {
  if let Some(last)=&self.latest {
   for field in ["steps","acks","stages","stageDropped","lastAction","phase","pageEpoch","progressIndex"] {
    if result.get(field).is_none(){result[field]=last[field].clone();}
   }
  }
  result["hostEvents"]=serde_json::Value::Array(self.host_events.clone());result["nativeEvents"]=serde_json::json!(self.native_events);result["nativeEventsDropped"]=serde_json::json!(self.native_dropped);result["deliveryCount"]=serde_json::json!(self.delivery_count);result["lastDelivery"]=serde_json::json!(self.delivery.back());result
 }
 fn interruption(&self,epoch:&str)->Option<serde_json::Value>{
  self.latest.as_ref().filter(|last|last["pageEpoch"].as_str()!=Some(epoch)&&last["phase"]!="reload-requested").cloned()
 }
}
static GATE:OnceLock<Gate>=OnceLock::new();
static REQUEST_IDS:std::sync::atomic::AtomicUsize=std::sync::atomic::AtomicUsize::new(0);
pub fn request_id()->Option<usize>{if active(){Some(REQUEST_IDS.fetch_add(1,Ordering::Relaxed)+1)}else{None}}
pub fn initialize()->Result<(),String>{
 let args:Vec<String>=std::env::args().collect();
 let react=args.get(1).map(String::as_str)==Some("--native-react-workspace-gate");
 let interaction_receiver=args.get(1).map(String::as_str)==Some("--native-interaction-workspace-gate");
 if !react&&!interaction_receiver&&args.get(1).map(String::as_str)!=Some("--native-workspace-gate"){return Ok(());}
 if !cfg!(target_os="macos"){return Err("Actual WK gate requires macOS".into());}
 if ((react||interaction_receiver)&&args.len()!=5)||(!react&&!interaction_receiver&&args.len()!=4){return Err("Usage: --native-[react-]workspace-gate NEW_ABSOLUTE_DIRECTORY LOOPBACK_FIXTURE_ORIGIN [OWN_FIXTURE_DESCRIPTOR]".into());}
 let benchmark_renderer=parse_benchmark_renderer(std::env::var("TD_PREVIEW_BENCH_RENDERER").ok().as_deref())?;
 if benchmark_renderer.is_some()&&!react{return Err("Renderer comparison requires the owned React gate".into());}
 let root=PathBuf::from(&args[2]);let url=crate::config::origin(&args[3])?;let parsed=url::Url::parse(&url).map_err(|e|e.to_string())?;
 if !root.is_absolute()||root.components().any(|part|matches!(part,std::path::Component::ParentDir))||parsed.scheme()!="http"||parsed.host_str()!=Some("127.0.0.1")||parsed.port().is_none()||parsed.port()==Some(9834){return Err("Gate requires a fresh absolute directory and explicit non-production IPv4 loopback port".into());}
 let (connection,invitation,expected_peer,interactions,native_feedback,controlled_window_chrome,keyboard_manual,keyboard_before_native)=if let Some(path)=args.get(4){
  let path=PathBuf::from(path);if !path.is_absolute()||std::fs::metadata(&path).map_err(|_|"Missing owned fixture descriptor")?.len()>4096{return Err("Bounded absolute fixture descriptor required".into());}
  let raw=std::fs::read(&path).map_err(|_|"Cannot read owned fixture descriptor")?;
  let descriptor:serde_json::Value=serde_json::from_slice(&raw).map_err(|_|"Invalid fixture descriptor")?;
  let (connection,invitation)=react_connection(&url,&descriptor)?;
  let expected=descriptor["controlledTargetPeerId"].as_str().map(str::to_owned).or_else(||connection.target_peer_id.clone());
  if expected.as_ref().is_none_or(|value|value.is_empty()||value.len()>256){return Err("Owned React fixture target identity required".into());}
  (Some(connection),invitation,expected,descriptor["controlledInteractions"]==true,descriptor["controlledNativeFeedback"]==true,window_chrome_descriptor(descriptor.get("controlledWindowChrome"),react,descriptor["controlledInteractions"]==true)?,descriptor["controlledKeyboardManual"]==true,descriptor["controlledKeyboardBeforeNative"]==true)
 }else{(None,None,None,false,false,false,false,false)};
 if keyboard_before_native&&!keyboard_manual{return Err("Pre-native keyboard isolation requires the owned manual keyboard descriptor".into());}
 if keyboard_manual&&(!react||!native_feedback||!interactions){return Err("Manual keyboard requires the owned React native feedback descriptor".into());}
 if native_feedback&&!interactions{return Err("Native feedback requires the exact owned interactions descriptor".into());}
 if interaction_receiver&&!interactions{return Err("Interaction receiver requires the exact owned interactions descriptor".into());}
 std::fs::create_dir(&root).map_err(|e|format!("Gate directory must not already exist: {e}"))?;
 #[cfg(unix)] {use std::os::unix::fs::PermissionsExt;std::fs::set_permissions(&root,std::fs::Permissions::from_mode(0o700)).map_err(|e|e.to_string())?;}
 GATE.set(Gate{benchmark_renderer,root,url,react,interaction_receiver,interactions,native_feedback,controlled_window_chrome,keyboard_manual,keyboard_before_native,interaction_updates:Mutex::new(Default::default()),connection,invitation,expected_peer,auth_handoff:Mutex::new(AuthHandoff::default()),nonce:uuid::Uuid::new_v4().to_string(),page_epoch:Mutex::new(None),owner:Mutex::new(None),evidence:Mutex::new(Evidence::default()),pulls:Mutex::new(Pulls::default()),finished:AtomicBool::new(false)}).map_err(|_|"Gate already initialized")?;Ok(())
}
fn window_chrome_descriptor(value:Option<&serde_json::Value>,react:bool,interactions:bool)->Result<bool,String>{
 match value {
  None|Some(serde_json::Value::Bool(false))=>Ok(false),
  Some(serde_json::Value::Bool(true)) if react&&interactions=>Ok(true),
  _=>Err("Window observations require an exact owned React interactions boolean descriptor".into()),
 }
}
fn parse_benchmark_renderer(value:Option<&str>)->Result<Option<String>,String>{
 match value {None=>Ok(None),Some("browser")=>Ok(Some("browser".into())),Some("native")=>Ok(Some("native".into())),_=>Err("Owned renderer comparison must select browser or native".into())}
}
pub fn benchmark_renderer()->Option<&'static str>{GATE.get().and_then(|gate|gate.benchmark_renderer.as_deref())}
fn native_renderer_selected(mode:Option<&str>)->bool{mode==Some("native")}
/// Explicit owned-test override; ordinary windows negotiate their saved choice.
pub fn native_renderer_enabled()->bool{cfg!(target_os="macos")&&native_renderer_selected(benchmark_renderer())}
pub fn active()->bool{GATE.get().is_some()}
#[cfg(target_os="macos")]
fn titlebar_restore_owner(window:&WebviewWindow,gate:&Gate,epoch:&str)->bool{
 gate.react&&gate.interactions&&!gate.interaction_receiver&&!gate.finished.load(Ordering::Acquire)
  &&gate.owner.lock().unwrap().as_deref()==Some(window.label())
  &&gate.page_epoch.lock().unwrap().as_deref()==Some(epoch)
  &&crate::shell::page_epoch(window).as_deref()==Some(epoch)
  &&interaction_stage_owner(window,gate)
}
#[cfg(target_os="macos")]
pub(crate) fn arm_titlebar_restore(window:&WebviewWindow,epoch:&str)->bool{
 let Some(gate)=GATE.get()else{return false;};if !titlebar_restore_owner(window,gate,epoch){return false;}
 gate.interaction_updates.lock().unwrap().arm_titlebar_restore(window.label(),epoch);true
}
#[cfg(target_os="macos")]
pub(crate) fn titlebar_restore_owner_matches(window:&WebviewWindow,epoch:&str)->bool{
 GATE.get().is_some_and(|gate|titlebar_restore_owner(window,gate,epoch))
}
#[cfg(target_os="macos")]
pub(crate) fn consume_titlebar_restore(window:&WebviewWindow,epoch:&str)->bool{
 let Some(gate)=GATE.get()else{return false;};if !titlebar_restore_owner(window,gate,epoch){return false;}
 gate.interaction_updates.lock().unwrap().consume_titlebar_restore(window.label(),epoch)
}
pub(crate) fn keyboard_before_native()->bool{GATE.get().is_some_and(|gate|gate.keyboard_before_native)}
pub(crate) fn chrome_enabled()->bool{GATE.get().is_some_and(|gate|gate.controlled_window_chrome)}
pub(crate) fn chrome_path()->Option<std::path::PathBuf>{GATE.get().filter(|gate|gate.controlled_window_chrome).map(|gate|gate.root.join("window-chrome-diagnostic.json"))}
pub(crate) fn chrome_role(window:&WebviewWindow,require_pin:bool)->Option<crate::window_chrome::Role>{
 let gate=GATE.get().filter(|gate|gate.controlled_window_chrome)?;
 let center=crate::shell::check_caller(window.app_handle(),window).ok()?;
 if center{return (window.label()=="center").then_some(crate::window_chrome::Role::Center);}
 let (_,pinned)=crate::shell::verified_service_page_context(window,&gate.url,gate.expected_peer.as_deref()?).ok()?;
 (!require_pin||pinned).then_some(crate::window_chrome::Role::Service)
}
pub fn configuration()->Option<(PathBuf,Config)>{
 let gate=GATE.get()?;let mut config=Config::default();config.imported_bookmarks=true;
 config.desktop_preferences.floating_widget_enabled=false;
 let connection=gate.connection.clone().unwrap_or(Connection{id:"native-workspace-gate".into(),url:gate.url.clone(),label:"Controlled native gate".into(),target_peer_id:None,service_origin:None,entry_service_id:None,routes:vec![]});
 config.connections.push(connection.clone());
 // Owned invitation fixture alias: exercise the real menu's peer grouping,
 // without another window, grant, route, or access to the user's bookmarks.
 if gate.react&&gate.invitation.is_some()&&connection.target_peer_id.is_some(){let mut alias=connection.clone();alias.id="controlled-menu-alias".into();alias.label="Controlled menu alias".into();config.connections.push(alias);}
 if !gate.keyboard_before_native{config.open_connections.push(connection.id);}Some((gate.root.join("connections.json"),config))
}
pub fn profile(key:&str)->Option<String>{GATE.get().map(|gate|format!("native-gate:{}:{key}",gate.nonce))}
fn driver_script(nonce:&str,epoch:&str,interrupted:Option<serde_json::Value>)->String{driver_body(nonce,epoch,interrupted,include_str!("../../renderer/native-workspace-gate.js"))}
fn driver_body(nonce:&str,epoch:&str,interrupted:Option<serde_json::Value>,body:&str)->String{
 format!("(()=>{{try{{const before={{running:!!window.__TD_NATIVE_GATE_RUNNING,driverEpoch:window.__TD_NATIVE_GATE_STATE?.pageEpoch||null,driverFinished:!!window.__TD_NATIVE_GATE_STATE?.finished,driverCancelled:!!window.__TD_NATIVE_GATE_STATE?.cancelled,ipcReady:!!window.__TAURI_INTERNALS__?.ipc,invokeReady:typeof window.__TAURI_INTERNALS__?.invoke==='function',path:location.pathname.slice(0,256)}};window.__TD_NATIVE_GATE_NONCE={};window.__TD_NATIVE_GATE_EPOCH={};window.__TD_NATIVE_GATE_INTERRUPTED={};\n{}\nreturn {{evalCompleted:true,pageEpoch:{},before}};}}catch(error){{return {{evalCompleted:false,pageEpoch:{},error:String(error).slice(0,512)}};}}}})()",serde_json::to_string(nonce).unwrap(),serde_json::to_string(epoch).unwrap(),serde_json::to_string(&interrupted).unwrap(),body,serde_json::to_string(epoch).unwrap(),serde_json::to_string(epoch).unwrap())
}
fn retirement_receiver_body(handoff:&str,expected:&str,service_origin:&str,page_origin:&str,host_pin:bool,driver:&str)->String{
 // Keep the normal visible login-form helper in one source and inject it only
 // for this opt-in authenticated pairing path.
 let react_helpers=include_str!("../../renderer/native-react-workspace-gate.js");
 let login_helper=react_helpers.split_once("function tdNativeReactSettingsClose()").expect("React login helper boundary").0;
 format!("window.__TD_NATIVE_GATE_AUTH_HANDOFF={handoff};window.__TD_NATIVE_GATE_EXPECTED_PEER={expected};window.__TD_NATIVE_GATE_EXPECTED_SERVICE_ORIGIN={service_origin};window.__TD_NATIVE_GATE_EXPECTED_PAGE_ORIGIN={page_origin};window.__TD_NATIVE_GATE_HOST_PIN_VERIFIED={host_pin};\n{login_helper}\n{driver}")
}
fn retirement_receiver_script(nonce:&str,epoch:&str,interrupted:Option<serde_json::Value>,handoff:Option<serde_json::Value>,expected:&str,service_origin:&str,page_origin:&str,host_pin:bool)->String{
 let helpers=include_str!("../../renderer/native-workspace-gate.js").split_once("(async()=>{").unwrap().0;
 let body=retirement_receiver_body(&serde_json::to_string(&handoff).unwrap(),&serde_json::to_string(expected).unwrap(),&serde_json::to_string(service_origin).unwrap(),&serde_json::to_string(page_origin).unwrap(),host_pin,include_str!("../../renderer/native-retirement-workspace-gate.js"));
 driver_body(nonce,epoch,interrupted,&format!("{helpers}\n{body}"))
}
fn script(epoch:&str,page_context:Option<(&str,bool)>)->String{match GATE.get(){Some(gate)=>{
 let interrupted=gate.evidence.lock().unwrap().interruption(epoch);
 if gate.interaction_receiver {
  let helpers=include_str!("../../renderer/native-workspace-gate.js").split_once("(async()=>{").unwrap().0;
  if gate.native_feedback {
   let handoff=gate.auth_handoff.lock().unwrap().take(epoch);
   let (page_origin,host_pin)=page_context.expect("Verified service page context");
   return retirement_receiver_script(&gate.nonce,epoch,interrupted,handoff,gate.expected_peer.as_deref().expect("Owned fixture peer"),&gate.url,page_origin,host_pin);
  }
  let body=include_str!("../../renderer/native-interaction-workspace-gate.js");
  return driver_body(&gate.nonce,epoch,interrupted,&format!("{helpers}\n{body}"));
 }
 if !gate.react{return driver_script(&gate.nonce,epoch,interrupted);}
 let helpers=include_str!("../../renderer/native-workspace-gate.js").split_once("(async()=>{").unwrap().0;
 let handoff=gate.auth_handoff.lock().unwrap().take(epoch);
 let body=format!("window.__TD_PREVIEW_BENCH_RENDERER={};window.__TD_NATIVE_GATE_SERVICE_WK_BEFORE_NATIVE={};window.__TD_NATIVE_GATE_AUTH_HANDOFF={};\n{helpers}\n{}\n{}",serde_json::to_string(&benchmark_renderer()).unwrap(),gate.keyboard_before_native,serde_json::to_string(&handoff).unwrap(),include_str!("../../renderer/native-react-interaction-gate.js"),include_str!("../../renderer/native-react-workspace-gate.js"));driver_body(&gate.nonce,epoch,interrupted,&body)
 },None=>String::new()}}
#[cfg(not(target_os="macos"))]
pub fn interaction_update(_window:&WebviewWindow,_op:&str)->Option<Result<serde_json::Value,String>>{None}
#[cfg(target_os="macos")]
pub fn interaction_update(window:&WebviewWindow,op:&str)->Option<Result<serde_json::Value,String>>{
 let gate=GATE.get()?;if !gate.interactions||!gate.react||gate.interaction_receiver||!matches!(op,"snapshot"|"updateState"|"checkUpdate"|"installUpdate"){return None;}
 // Called only after shell::check_caller; retain exact service/target/page checks.
 let context=match crate::shell::native_context(window.app_handle(),window){Ok(context)=>context,Err(error)=>return Some(Err(error))};
 if gate.finished.load(Ordering::Acquire)||gate.expected_peer.as_deref()!=Some(context.target.as_str())||gate.connection.as_ref().is_none_or(|connection|!connection.origins().contains(&context.service)){return Some(Err("Controlled desktop update owner mismatch".into()));}
 {let mut owner=gate.owner.lock().unwrap();if owner.as_ref().is_some_and(|owner|owner!=window.label()){return Some(Err("Controlled desktop update window mismatch".into()));}*owner=Some(window.label().into());}
 if op=="snapshot"{let config=crate::shell::state(window.app_handle()).config.lock().unwrap().clone();return Some(Ok(serde_json::json!({"appVersion":"0.1.0","localService":{"running":false,"available":false,"controlled":true},"connections":config.connections,"lastConnectionUrl":config.last_connection_url,"desktopPreferences":config.desktop_preferences})));}
 let mut updates=gate.interaction_updates.lock().unwrap();let result=if op=="installUpdate"{updates.install()}else{Ok(updates.snapshot())};let calls=updates.installs;drop(updates);
 host_event(window,"controlled-desktop-update-stub",serde_json::json!({"op":op,"installCalls":calls,"realOsUpdaterCalled":false,"ok":result.is_ok()}));Some(result)
}
fn interaction_stage_owner(window:&WebviewWindow,gate:&Gate)->bool{
 #[cfg(target_os="macos")] {return crate::shell::native_context(window.app_handle(),window).ok().is_some_and(|context|gate.expected_peer.as_deref()==Some(context.target.as_str())&&gate.connection.as_ref().is_some_and(|connection|connection.origins().contains(&context.service)));}
 #[cfg(not(target_os="macos"))] {let _=(window,gate);false}
}
#[derive(serde::Deserialize)]
#[serde(rename_all="camelCase",deny_unknown_fields)]
struct KeyboardStage {case_index:u32}
fn keyboard_stage(window:&WebviewWindow,gate:&'static Gate,data:&serde_json::Value)->bool{
 if !gate.react||!gate.interactions||!gate.native_feedback||gate.interaction_receiver||gate.finished.load(Ordering::Acquire)||!interaction_stage_owner(window,gate){return false;}
 let phase=data["phase"].as_str().unwrap_or("");
 if gate.keyboard_manual{
  let epoch=data["pageEpoch"].as_str().unwrap_or("").to_owned();
  if gate.owner.lock().unwrap().as_deref()!=Some(window.label())||crate::shell::page_epoch(window).as_deref()!=Some(epoch.as_str()){return false;}
  let command=gate.interaction_updates.lock().unwrap().manual_counter_stage(data,&epoch);
  let Some((arm,index))=command else{return false;};
  #[cfg(target_os="macos")] {
   let caller=window.clone();let _=window.app_handle().run_on_main_thread(move||{
    if gate.finished.load(Ordering::Acquire)||crate::shell::page_epoch(&caller).as_deref()!=Some(epoch.as_str())||!interaction_stage_owner(&caller,gate){return;}
    let Ok(context)=crate::shell::native_context(caller.app_handle(),&caller)else{return;};if !crate::native_terminal::keyboard_fixture_owner(&context){return;}
    extern "C"{fn td_native_keyboard_commit_snapshot_fixture()->u32;fn td_native_keyboard_arm(window:*mut std::ffi::c_void)->bool;fn td_native_keyboard_stages(window:*mut std::ffi::c_void,values:*mut u64)->bool;fn td_native_keyboard_context(window:*mut std::ffi::c_void,values:*mut u64)->bool;}
    let Ok(raw)=caller.ns_window()else{return;};let snapshot_regression=if arm{Some(unsafe{td_native_keyboard_commit_snapshot_fixture()})}else{None};let armed=if arm{unsafe{td_native_keyboard_arm(raw)}}else{false};let mut stages=[0u64;20];let mut state=[0u64;12];
    let sampled=unsafe{td_native_keyboard_stages(raw,stages.as_mut_ptr())};let contextual=unsafe{td_native_keyboard_context(raw,state.as_mut_ptr())};
    host_event(&caller,"manual-keyboard-native-counters",serde_json::json!({"progressIndex":index,"arm":arm,"armed":armed,"commitSnapshotRegression":snapshot_regression,"sampled":sampled,"stages":stages,"contextSampled":contextual,"context":state,"automaticKeys":false,"forcedFirstResponder":false}));
    if sampled&&contextual&&(!arm||armed){let _=caller.eval(format!("window.__TD_NATIVE_MANUAL_COUNTER_INDEX={index};"));}
   });
  }
  return true;
 }
 if !matches!(phase,"controlled-keyboard-case"|"controlled-keyboard-read"|"controlled-keyboard-probe-prepare"|"controlled-keyboard-probe-send"|"controlled-keyboard-probe-read"){return false;}
 let Ok(value)=serde_json::from_value::<KeyboardStage>(data["lastAction"].clone())else{return false;};if value.case_index>=6{return false;}
 let index=data["progressIndex"].as_u64().unwrap_or(0);let epoch=data["pageEpoch"].as_str().unwrap_or("").to_owned();
 if gate.owner.lock().unwrap().as_deref()!=Some(window.label())||crate::shell::page_epoch(window).as_deref()!=Some(epoch.as_str()){return false;}
 let probe=phase.starts_with("controlled-keyboard-probe-");
 {let mut updates=gate.interaction_updates.lock().unwrap();if probe{
   let step=if phase=="controlled-keyboard-probe-prepare"{0}else if phase=="controlled-keyboard-probe-send"{1}else{2};
   if !updates.reserve_keyboard_probe(value.case_index,index,step){return false;}
 }else if phase=="controlled-keyboard-case"{if !updates.reserve_keyboard(value.case_index,index){return false;}}else if value.case_index+1!=updates.keyboard_next{return false;}}
 #[cfg(target_os="macos")]{
  let caller=window.clone();let inject=phase=="controlled-keyboard-case"||phase=="controlled-keyboard-probe-send";let prepare=phase=="controlled-keyboard-probe-prepare";
  let _=window.app_handle().run_on_main_thread(move||{
   if gate.finished.load(Ordering::Acquire)||crate::shell::page_epoch(&caller).as_deref()!=Some(epoch.as_str())||!interaction_stage_owner(&caller,gate){return;}
   let Ok(context)=crate::shell::native_context(caller.app_handle(),&caller)else{return;};if !crate::native_terminal::keyboard_fixture_owner(&context){return;}
   extern "C"{fn td_native_keyboard_prepare(window:*mut std::ffi::c_void,action:u32)->bool;fn td_native_keyboard_context(window:*mut std::ffi::c_void,values:*mut u64)->bool;fn td_native_keyboard_app_case(window:*mut std::ffi::c_void,which:u32)->bool;fn td_native_keyboard_stages(window:*mut std::ffi::c_void,stages:*mut u64)->bool;}
   let Ok(raw)=caller.ns_window()else{return;};let mut stages=[0u64;20];
   let mut before=[0u64;12];let mut after=[0u64;12];unsafe{td_native_keyboard_context(raw,before.as_mut_ptr());}
   let prepared=if prepare{let action=match value.case_index{1|3=>1,2=>2,4=>3,_=>0};unsafe{td_native_keyboard_prepare(raw,action)}}else{false};
   let submitted=if inject{unsafe{td_native_keyboard_app_case(raw,if probe{0}else{value.case_index})}}else{false};unsafe{td_native_keyboard_context(raw,after.as_mut_ptr());}let sampled=unsafe{td_native_keyboard_stages(raw,stages.as_mut_ptr())};
   let result=serde_json::json!({"caseIndex":value.case_index,"progressIndex":index,"injection":inject,"submitted":submitted,"sampled":sampled,"stages":stages,"forcedFirstResponder":probe&&value.case_index==4,"prepared":prepared,"contextBefore":before,"contextAfter":after,"physicalKeysTested":false});
   let _=caller.eval(format!("window.__TD_NATIVE_KEYBOARD_RESULT={result};"));
  });
 }
 true
}
fn interaction_update_stage(window:&WebviewWindow,gate:&Gate,data:&serde_json::Value)->bool{
 if !gate.interactions||gate.interaction_receiver||!interaction_stage_owner(window,gate){return false;}
 let phase=data["phase"].as_str().unwrap_or("");
 if !matches!(phase,"controlled-desktop-update-invalidate-ready"|"controlled-desktop-update-allow-success"){return false;}
 let mut updates=gate.interaction_updates.lock().unwrap();
 if phase=="controlled-desktop-update-invalidate-ready" {updates.ready=false;}else if updates.installs==1 {updates.allowed=true;updates.ready=true;}else{return false;}
 let value=updates.snapshot();let calls=updates.installs;drop(updates);
 let _=window.eval(format!("window.dispatchEvent(new CustomEvent('termdock:preview-update',{{detail:{value}}}));window.__TD_NATIVE_GATE_UPDATE_STUB={{installCalls:{calls},realOsUpdaterCalled:false}};"));true
}
pub fn invitation()->Option<String>{GATE.get().and_then(|gate|gate.invitation.clone())}
// Receipt only for the ordinary first pairing save, never for a native request.
fn authorization_handoff(last:&serde_json::Value,epoch:&str,origin:&str,expected:&str,old:&Connection,next:&Connection)->Option<serde_json::Value>{
 if old.target_peer_id.is_some()||old.url!=origin||next.url!=origin||next.target_peer_id.as_deref()!=Some(expected)
  ||last["pageEpoch"].as_str()!=Some(epoch)||last["phase"]!="normal-login-form-submit-ready"
  ||last["steps"].as_array().is_none_or(|v|!v.is_empty())||last["acks"].as_array().is_none_or(|v|!v.is_empty()){return None;}
 Some(serde_json::json!({"oldEpoch":epoch,"targetPeerId":expected,"url":origin,"previous":last}))
}
pub fn paired_connection(window:&WebviewWindow,old:&Connection,next:&Connection){
 let Some(gate)=GATE.get().filter(|gate|fixture_pairing_handoff_enabled(gate))else{return};
 if gate.owner.lock().unwrap().as_deref()!=Some(window.label()){return;}
 let Some(expected)=gate.expected_peer.as_deref()else{return};let Some(epoch)=crate::shell::page_epoch(window)else{return};
 let evidence=gate.evidence.lock().unwrap();if !evidence.native_events.is_empty()||evidence.native_dropped>0{return;}
 let Some(last)=evidence.latest.as_ref()else{return};
 let handoff=authorization_handoff(last,&epoch,&gate.url,expected,old,next);drop(evidence);
 if let Some(mut handoff)=handoff{handoff["nonce"]=serde_json::json!(gate.nonce);let mut pending=gate.auth_handoff.lock().unwrap();if pending.arm(handoff){drop(pending);host_event(window,"normal-first-pairing-scope-reload-authorized",serde_json::json!({"targetPeerId":expected,"oldEpoch":epoch}));}}
}
fn fixture_pairing_handoff_enabled(gate:&Gate)->bool{fixture_pairing_handoff_allowed(gate.react,gate.interaction_receiver,gate.interactions,gate.native_feedback)}
fn fixture_pairing_handoff_allowed(react:bool,interaction_receiver:bool,interactions:bool,native_feedback:bool)->bool{react||(interaction_receiver&&interactions&&native_feedback)}
fn react_connection(origin:&str,descriptor:&serde_json::Value)->Result<(Connection,Option<String>),String>{
 if descriptor["url"].as_str()!=Some(origin)||descriptor["serverRevision"]!="79feaf2442dd71a06806cc652252e9a7db4b54fb"{return Err("Owned fixed fixture descriptor mismatch".into());}
 let string=|key:&str|descriptor[key].as_str().map(str::to_owned);
 let connection=Connection{id:"native-workspace-gate".into(),url:origin.into(),label:"Controlled React gate".into(),target_peer_id:string("targetPeerId"),service_origin:string("serviceOrigin"),entry_service_id:string("entryServiceId"),routes:vec![]}.validated()?;
 for origin in connection.origins(){let url=url::Url::parse(&origin).map_err(|_|"Invalid fixture origin")?;if url.scheme()!="http"||url.host_str()!=Some("127.0.0.1")||url.port().is_none()||url.port()==Some(9834){return Err("Fixture route must remain private non-production IPv4 loopback".into());}}
 let invitation=string("invitation");if let Some(invitation)=&invitation{connection.validate_invitation(invitation)?;}Ok((connection,invitation))
}
fn persist(gate:&Gate,value:&serde_json::Value)->Result<(),String>{
 let mut snapshot=value.clone();snapshot["nonce"]=serde_json::json!(gate.nonce);snapshot["source"]=serde_json::json!(option_env!("TERMDOCK_PREVIEW_SOURCE_REVISION"));
 let bytes=serde_json::to_vec(&snapshot).map_err(|e|e.to_string())?;
 if bytes.len()>80*1024{return Err("Gate progress file evidence bound exceeded".into());}
 std::fs::write(gate.root.join("native-workspace-progress.pending"),bytes).and_then(|_|std::fs::rename(gate.root.join("native-workspace-progress.pending"),gate.root.join("native-workspace-progress.json"))).map_err(|e|e.to_string())
}
fn host_event(window:&WebviewWindow,event:&str,detail:serde_json::Value){
 if chrome_enabled(){return;}
 let Some(gate)=GATE.get() else{return};if gate.finished.load(Ordering::Acquire){return;}
 let Some(epoch)=crate::shell::page_epoch(window) else{return};
 let mut evidence=gate.evidence.lock().unwrap();if evidence.host_events.len()>=32{drop(evidence);finish(window.app_handle(),serde_json::json!({"ok":false,"error":"Gate page event evidence bound exceeded"}));return;}
 evidence.host_events.push(serde_json::json!({"event":event,"pageEpoch":epoch,"detail":detail}));
 eprintln!("Native WK gate host: nonce={} epoch={} event={} detail={}",gate.nonce,epoch,event,detail);
 let snapshot=evidence.augment(serde_json::json!({"ok":false,"phase":"host-page-event"}));
 if let Err(error)=persist(gate,&snapshot){drop(evidence);finish(window.app_handle(),serde_json::json!({"ok":false,"error":error}));}
}
fn safe_url(url:&url::Url)->String{
 if !matches!(url.scheme(),"http"|"https"|"tauri"){return format!("{}:<opaque>",url.scheme());}
 format!("{}://{}{}{}",url.scheme(),url.host_str().unwrap_or(""),url.port().map(|port|format!(":{port}")).unwrap_or_default(),url.path().chars().take(256).collect::<String>())
}
pub fn navigation(window:&WebviewWindow,url:&url::Url){if chrome_enabled(){return;}host_event(window,"navigation-policy/observed-url",serde_json::json!({"url":safe_url(url)}));}
pub fn page_started(window:&WebviewWindow,url:&url::Url){if chrome_enabled(){return;}host_event(window,"page-started/new-epoch",serde_json::json!({"url":safe_url(url)}));}
pub fn native_event(window:&WebviewWindow,phase:&str,action:&str,request_id:Option<usize>,request_epoch:Option<&str>,status:&str){
 if chrome_enabled(){return;}
 let Some(gate)=GATE.get() else{return};if gate.finished.load(Ordering::Acquire){return;}
 let epoch=crate::shell::page_epoch(window);
 let mut evidence=gate.evidence.lock().unwrap();if evidence.native_events.len()==128{evidence.native_events.pop_front();evidence.native_dropped+=1;}
 let event=serde_json::json!({"phase":phase,"action":action.chars().take(64).collect::<String>(),"requestId":request_id,"window":window.label(),"requestEpoch":request_epoch,"currentPageEpoch":epoch,"status":status.chars().take(256).collect::<String>()});
 eprintln!("Native WK gate native: nonce={} event={}",gate.nonce,event);evidence.native_events.push_back(event);
 let snapshot=evidence.augment(serde_json::json!({"ok":false}));
 if let Err(error)=persist(gate,&snapshot){drop(evidence);finish(window.app_handle(),serde_json::json!({"ok":false,"error":error}));return;}
 drop(evidence);
 if phase=="dispatch-return"&&action=="checkpoint"&&status=="ok"{let current=window.clone();let epoch=epoch.clone();tauri::async_runtime::spawn(async move{tokio::time::sleep(std::time::Duration::from_millis(20)).await;if let Some(epoch)=epoch{request_read(&current,0,&epoch,"checkpoint return bounded follow-up");}});}
}
pub fn page_finished(window:&WebviewWindow){
 if keyboard_before_native()&&window.label()=="center"{return;}
 if chrome_enabled(){return;}
 let Some(gate)=GATE.get() else{return};
 {let mut owner=gate.owner.lock().unwrap();if owner.as_ref().is_some_and(|owner|owner!=window.label()){return;}*owner=Some(window.label().into());}
 if gate.finished.load(Ordering::Acquire){return;}
 let Some(epoch)=crate::shell::page_epoch(window) else{return};
 {let mut previous=gate.page_epoch.lock().unwrap();if previous.as_ref()==Some(&epoch){return;}*previous=Some(epoch.clone());}
 host_event(window,"page-finished/prepare-script",serde_json::json!({"url":window.url().ok().map(|url|safe_url(&url))}));if gate.finished.load(Ordering::Acquire){return;}
 #[cfg(target_os="macos")]
 if gate.react {
  let menu_window=window.clone();let menu_epoch=epoch.clone();
  // NSApp menu inspection needs the main thread, not a platform webview.
  // WithWebview runs synchronously on that thread while holding window_id;
  // calling eval from its closure would reacquire the same dispatcher mutex.
  if let Err(error)=window.app_handle().run_on_main_thread(move ||{
   if GATE.get().is_none_or(|gate|gate.finished.load(Ordering::Acquire)){return;}
   if crate::shell::page_epoch(&menu_window).as_deref()!=Some(&menu_epoch){return;}
   let connections=crate::shell::state(menu_window.app_handle()).config.lock().unwrap().connections.clone();
   let expected=crate::config::service_menu_rows(&connections,None).into_iter().map(|row|row.label).collect::<Vec<_>>();
   let actual=crate::native_desktop::service_menus_on_main();
   let value=match actual {Ok(actual)=>{let matched=actual["menus"].as_array().is_some_and(|menus|!menus.is_empty()&&menus.iter().all(|menu|menu["truncated"]==false&&menu["items"].as_array().is_some_and(|items|items.iter().map(|item|item["title"].as_str().unwrap_or("")).eq(expected.iter().map(String::as_str)))));serde_json::json!({"pageEpoch":menu_epoch,"actual":actual,"expected":expected,"matched":matched,"storedConnections":connections.len()})},Err(error)=>serde_json::json!({"pageEpoch":menu_epoch,"error":error,"matched":false})};
   host_event(&menu_window,"actual-native-service-menu",value.clone());
   submit_driver(&menu_window,&menu_epoch,Some(&value));
  }){finish(window.app_handle(),serde_json::json!({"ok":false,"error":error.to_string()}));}
  return;
 }
 submit_driver(window,&epoch,None);
}
fn menu_driver_script(menu:Option<&serde_json::Value>,driver:String)->String{
 match menu{Some(value)=>format!("window.__TD_NATIVE_GATE_SERVICE_MENU={value};\n{driver}"),None=>driver}
}
fn submit_driver(window:&WebviewWindow,epoch:&str,menu:Option<&serde_json::Value>){
 let Some(gate)=GATE.get()else{return;};if gate.finished.load(Ordering::Acquire)||crate::shell::page_epoch(window).as_deref()!=Some(epoch){return;}
 let page_context=if gate.interaction_receiver&&gate.native_feedback{match crate::shell::verified_service_page_context(window,&gate.url,gate.expected_peer.as_deref().expect("Owned fixture peer")){Ok(context)=>Some(context),Err(error)=>{finish(window.app_handle(),serde_json::json!({"ok":false,"error":error}));return;}}}else{None};
 let callback_window=window.clone();let submitted_epoch=epoch.to_owned();
 if let Err(error)=window.eval_with_callback(menu_driver_script(menu,script(epoch,page_context.as_ref().map(|(origin,pin)|(origin.as_str(),*pin)))),move |value|{
  let detail=if value.len()>4096{serde_json::json!({"submittedEpoch":submitted_epoch,"error":"Eval callback evidence bound exceeded"})}else{serde_json::json!({"submittedEpoch":submitted_epoch,"returned":serde_json::from_str::<serde_json::Value>(&value).unwrap_or(serde_json::Value::Null),"empty":value.is_empty()})};
  host_event(&callback_window,"script-eval-callback",detail);
 }){finish(window.app_handle(),serde_json::json!({"ok":false,"error":error.to_string()}));}
 else {host_event(window,"script-eval-submitted",serde_json::Value::Null);}
}
fn delivery(window:&WebviewWindow,reason:&str,detail:serde_json::Value){
 let Some(gate)=GATE.get() else{return};if gate.finished.load(Ordering::Acquire){return;}
 let mut evidence=gate.evidence.lock().unwrap();if evidence.delivery_count>=4096{drop(evidence);finish(window.app_handle(),serde_json::json!({"ok":false,"error":"Gate delivery event bound exceeded"}));return;}
 evidence.delivery_count+=1;if evidence.delivery.len()==64{evidence.delivery.pop_front();}
 let event=serde_json::json!({"number":evidence.delivery_count,"reason":reason,"detail":detail});eprintln!("Native WK gate delivery: nonce={} event={}",gate.nonce,event);evidence.delivery.push_back(event);
 let record=serde_json::json!({"source":option_env!("TERMDOCK_PREVIEW_SOURCE_REVISION"),"nonce":gate.nonce,"count":evidence.delivery_count,"events":evidence.delivery});
 let bytes=serde_json::to_vec_pretty(&record).unwrap();let write=if bytes.len()>32*1024{Err(std::io::Error::other("Gate delivery file exceeds 32KiB"))}else{std::fs::write(gate.root.join("native-workspace-delivery.pending"),bytes).and_then(|_|std::fs::rename(gate.root.join("native-workspace-delivery.pending"),gate.root.join("native-workspace-delivery.json")))};
 if let Err(error)=write{drop(evidence);finish(window.app_handle(),serde_json::json!({"ok":false,"error":error.to_string()}));}
}
impl Pulls {
 fn queue(&mut self,mut key:Pull)->Result<Option<Pull>,String>{
  if self.active.is_some(){
   if let Some(pending)=&mut self.pending{if pending.window==key.window&&pending.epoch==key.epoch{pending.index=pending.index.max(key.index);}else{self.pending=Some(key);}}else{self.pending=Some(key);}
   return Ok(None);
  }
  if self.issued>=2048{return Err("Gate snapshot read count bound exceeded".into());}
  self.issued+=1;key.id=self.issued;self.active=Some(key.clone());Ok(Some(key))
 }
 fn complete(&mut self,id:usize)->Option<Option<Pull>>{
  if self.active.as_ref().map(|key|key.id)!=Some(id){return None;}
  self.active=None;Some(self.pending.take())
 }
}
fn producer_expression()->&'static str{
 "(()=>{const wire=window.__TD_NATIVE_GATE_WIRE;if(typeof wire!=='string'||wire.length>65536)return null;const bytes=new TextEncoder().encode(wire);if(bytes.byteLength>65536)return null;return JSON.parse(wire);})()"
}
fn decode_producer(raw:&str,nonce:&str,epoch:&str,minimum:u64)->Result<(String,serde_json::Value),String>{
 if raw.is_empty(){return Err("empty eval callback; NSError unavailable".into());}if raw.len()>64*1024{return Err("snapshot callback exceeds 64KiB".into());}
 let value:serde_json::Value=serde_json::from_str(raw).map_err(|_|"snapshot callback invalid JSON")?;
 if value["version"]!=1||value["nonce"].as_str()!=Some(nonce){return Err("snapshot absent/version/nonce mismatch".into());}
 let data=value["data"].clone();if data["pageEpoch"].as_str()!=Some(epoch){return Err("snapshot epoch mismatch".into());}
 if data["progressIndex"].as_u64().is_none_or(|index|index<minimum||index>2048){return Err("snapshot index predates signal".into());}
 if data["steps"].as_array().is_none_or(|items|items.len()>64)||data["acks"].as_array().is_none_or(|items|items.len()>128)||data["stages"].as_array().is_none_or(|items|items.len()>128){return Err("snapshot entry bounds invalid".into());}
 let kind=value["kind"].as_str().filter(|kind|matches!(*kind,"progress"|"result")).ok_or("snapshot kind invalid")?;
 Ok((kind.into(),data))
}
fn read_complete(window:&WebviewWindow,key:&Pull,raw:String){
 let Some(gate)=GATE.get() else{return};if gate.finished.load(Ordering::Acquire){return;}
 let Some(pending)=gate.pulls.lock().unwrap().complete(key.id) else{delivery(window,"late/superseded read callback",serde_json::json!({"read":key.id,"bytes":raw.len()}));return;};
 if window.label()!=key.window||crate::shell::page_epoch(window).as_deref()!=Some(key.epoch.as_str()){
  delivery(window,"read callback current window/epoch changed",serde_json::json!({"read":key.id,"requestedEpoch":key.epoch,"bytes":raw.len()}));
 }else{match decode_producer(&raw,&gate.nonce,&key.epoch,key.index){
  Err(error)=>delivery(window,&error,serde_json::json!({"read":key.id,"bytes":raw.len(),"epoch":key.epoch,"minimum":key.index})),
  Ok((kind,data))=>{
   let index=data["progressIndex"].as_u64().unwrap();
   if kind=="result"{delivery(window,"producer final accepted",serde_json::json!({"read":key.id,"bytes":raw.len(),"epoch":key.epoch,"index":index}));finish(window.app_handle(),data);}
   else{
    let mut evidence=gate.evidence.lock().unwrap();let duplicate=evidence.latest.as_ref()==Some(&data);
    let accepted=duplicate||evidence.accept(data.clone(),&key.epoch);let write=if accepted{persist(gate,&evidence.augment(serde_json::json!({"ok":false})))}else{Ok(())};drop(evidence);
    delivery(window,if duplicate{"producer duplicate/idempotent"}else if accepted{"producer progress accepted"}else{"producer index/entry/update rejected"},serde_json::json!({"read":key.id,"bytes":raw.len(),"epoch":key.epoch,"index":index,"phase":data["phase"],"steps":data["steps"].as_array().unwrap().len(),"acks":data["acks"].as_array().unwrap().len()}));
    if let Err(error)=write{finish(window.app_handle(),serde_json::json!({"ok":false,"error":error}));}
    else if accepted&&(keyboard_stage(window,gate,&data)||interaction_update_stage(window,gate,&data)||data["phase"]=="reload-requested"||data["phase"]=="normal-login-form-submit-ready"){let receipt=serde_json::json!({"nonce":gate.nonce,"pageEpoch":key.epoch,"index":index});let _=window.eval(format!("window.__TD_NATIVE_GATE_STAGE_RECEIPT={receipt};"));delivery(window,"reload diagnostic receipt submitted",serde_json::json!({"epoch":key.epoch,"index":index}));}
   }
  }
 }}
 if let Some(pending)=pending{if !gate.finished.load(Ordering::Acquire){if let Some(next)=window.app_handle().get_webview_window(&pending.window){request_read(&next,pending.index,&pending.epoch,"coalesced pending");}}}
}
fn request_read(window:&WebviewWindow,index:u64,epoch:&str,source:&str){
 let Some(gate)=GATE.get() else{return};if gate.finished.load(Ordering::Acquire){return;}
 if gate.owner.lock().unwrap().as_deref()!=Some(window.label()){delivery(window,"read current window rejected",serde_json::json!({"index":index}));return;}
 if crate::shell::page_epoch(window).as_deref()!=Some(epoch){delivery(window,"read request current epoch mismatch",serde_json::json!({"epoch":epoch,"index":index,"source":source}));return;}
 let key=Pull{id:0,window:window.label().into(),epoch:epoch.into(),index};
 let next=gate.pulls.lock().unwrap().queue(key);
 match next{
  Err(error)=>finish(window.app_handle(),serde_json::json!({"ok":false,"error":error})),
  Ok(None)=>delivery(window,"read coalesced (one inflight)",serde_json::json!({"epoch":epoch,"index":index,"source":source})),
  Ok(Some(key))=>{
   delivery(window,"fixed producer read submitted",serde_json::json!({"read":key.id,"epoch":epoch,"index":index,"source":source}));
   let callback_window=window.clone();let callback_key=key.clone();
   if let Err(error)=window.eval_with_callback(producer_expression(),move |raw|read_complete(&callback_window,&callback_key,raw)){finish(window.app_handle(),serde_json::json!({"ok":false,"error":error.to_string()}));return;}
   let timeout_window=window.clone();tauri::async_runtime::spawn(async move{tokio::time::sleep(std::time::Duration::from_secs(12)).await;if gate.pulls.lock().unwrap().active.as_ref().is_some_and(|active|active.id==key.id){delivery(&timeout_window,"fixed producer read timed out; no parallel replacement",serde_json::json!({"read":key.id,"epoch":key.epoch}));finish(timeout_window.app_handle(),serde_json::json!({"ok":false,"error":"Fixed producer read timed out"}));}});
  }
 }
}
pub fn title(window:&WebviewWindow,title:&str){
 if chrome_enabled(){return;}
 let Some(gate)=GATE.get() else{return};if gate.finished.load(Ordering::Acquire){return;}
 let prefix=format!("TD_NATIVE_GATE_SIGNAL:{}:",gate.nonce);let Some(value)=title.strip_prefix(&prefix) else{return};
 if title.len()>512{delivery(window,"signal exceeds 512 bytes",serde_json::json!({"bytes":title.len()}));return;}
 let Some((epoch,index))=value.rsplit_once(':') else{delivery(window,"signal shape rejected",serde_json::json!({"bytes":title.len()}));return;};
 let Ok(index)=index.parse::<u64>() else{delivery(window,"signal index rejected",serde_json::json!({"bytes":title.len()}));return;};
 if index>2048{delivery(window,"signal index bound rejected",serde_json::json!({"index":index,"bytes":title.len()}));return;}
 delivery(window,"signal received",serde_json::json!({"bytes":title.len(),"epoch":epoch,"index":index}));request_read(window,index,epoch,"short title notification");
}
fn finish(app:&AppHandle,result:serde_json::Value){
 let Some(gate)=GATE.get() else{return};if gate.finished.swap(true,Ordering::AcqRel){return;}
 if gate.controlled_window_chrome{if !crate::window_chrome::flush_final(){eprintln!("window-chrome-final-persist-failed");}app.exit(1);return;}
 let mut result=gate.evidence.lock().unwrap().augment(result);
 if gate.interactions&&!gate.interaction_receiver{let updates=gate.interaction_updates.lock().unwrap();result["controlledDesktopUpdates"]=serde_json::json!({"installCalls":updates.installs,"realOsUpdaterCalled":false,"ownedDescriptorOnly":true});}
 let success=result["ok"]==true;
 let report=serde_json::json!({"driver":if gate.interaction_receiver{"actual-product-WK-native-interaction-v1"}else if gate.react{"actual-product-WK-React-v1"}else{"actual-product-WK-normal-capabilities-v1"},"source":option_env!("TERMDOCK_PREVIEW_SOURCE_REVISION"),"fixtureOrigin":gate.url,"result":result});
 let bytes=serde_json::to_vec(&report).unwrap();
 let bounded=bytes.len()<=80*1024;
 let bytes=if bounded{bytes}else{serde_json::to_vec(&serde_json::json!({"driver":if gate.interaction_receiver{"actual-product-WK-native-interaction-v1"}else if gate.react{"actual-product-WK-React-v1"}else{"actual-product-WK-normal-capabilities-v1"},"source":option_env!("TERMDOCK_PREVIEW_SOURCE_REVISION"),"fixtureOrigin":gate.url,"result":{"ok":false,"error":"Gate final evidence exceeds 80KiB; previous bounded stage evidence retained","previousEvidence":"native-workspace-progress.json"}})).unwrap()};
 let write=std::fs::write(gate.root.join("native-workspace-gate.json"),bytes);
 eprintln!("Native WK gate report: {}",gate.root.join("native-workspace-gate.json").display());app.exit(if success&&bounded&&write.is_ok(){0}else{1});
}
pub fn deadline(app:AppHandle){let Some(gate)=GATE.get()else{return;};tauri::async_runtime::spawn(async move{tokio::time::sleep(std::time::Duration::from_secs(if gate.keyboard_manual||gate.benchmark_renderer.is_some(){600}else{120})).await;finish(&app,serde_json::json!({"ok":false,"error":"Actual WK gate timed out"}));});}

#[cfg(test)]
mod tests {
 #[test]
 fn owned_gate_native_requires_explicit_selection(){
  assert!(!native_renderer_selected(None));
  assert!(!native_renderer_selected(Some("browser")));
  assert!(!native_renderer_selected(Some("other")));
  assert!(native_renderer_selected(Some("native")));
 }
 #[test]
 fn renderer_comparison_is_explicit_and_rejects_unknown_modes(){
  assert_eq!(parse_benchmark_renderer(None).unwrap(),None);
  for mode in ["browser","native"]{assert_eq!(parse_benchmark_renderer(Some(mode)).unwrap().as_deref(),Some(mode));}
  for mode in ["","webgl","false","Browser"]{assert!(parse_benchmark_renderer(Some(mode)).is_err());}
 }
 #[test]
 fn window_chrome_descriptor_is_off_by_default_and_rejects_loose_or_unowned_modes(){
  assert_eq!(window_chrome_descriptor(None,false,false).unwrap(),false);
  assert_eq!(window_chrome_descriptor(Some(&serde_json::json!(false)),true,true).unwrap(),false);
  assert_eq!(window_chrome_descriptor(Some(&serde_json::json!(true)),true,true).unwrap(),true);
  for (value,react,interactions) in [(serde_json::json!(true),false,true),(serde_json::json!(true),true,false),(serde_json::json!("true"),true,true),(serde_json::json!(1),true,true),(serde_json::Value::Null,true,true)]{assert!(window_chrome_descriptor(Some(&value),react,interactions).is_err());}
  assert!(!chrome_enabled());assert!(crate::window_chrome::new_instance().is_none());
 }
 #[test]
 fn titlebar_restore_is_single_use_and_bound_to_exact_window_and_page_epoch(){
  let mut updates=InteractionUpdates::default();
  assert!(!updates.consume_titlebar_restore("service-a","epoch-a"));
  updates.arm_titlebar_restore("service-a","epoch-a");
  assert!(!updates.consume_titlebar_restore("service-b","epoch-a"));
  assert!(!updates.consume_titlebar_restore("service-a","epoch-b"));
  assert!(updates.consume_titlebar_restore("service-a","epoch-a"));
  assert!(!updates.consume_titlebar_restore("service-a","epoch-a"));
 }

 use super::*;
 #[test]
 fn one_eval_installs_actual_menu_before_driver_and_preserves_callback_receipt(){
  let root=tempfile::tempdir().unwrap();let file=root.path().join("menu-driver.js");
  let menu=serde_json::json!({"pageEpoch":"current","matched":true,"actual":{"menus":[{"items":[{"title":"本机服务（快捷入口）"},{"title":"Controlled React gate"}]}]},"storedConnections":2});
  let body="window.observedMenu=window.__TD_NATIVE_GATE_SERVICE_MENU;";
  let driver=driver_body("nonce","current",None,body);
  assert_eq!(menu_driver_script(None,driver.clone()),driver);
  std::fs::write(&file,menu_driver_script(Some(&menu),driver)).unwrap();
  let output=std::process::Command::new("node").arg("-e").arg("const fs=require('node:fs'),vm=require('node:vm');const window={};const receipt=vm.runInNewContext(fs.readFileSync(process.argv[1],'utf8'),{window,location:{pathname:'/workspace'}});process.stdout.write(JSON.stringify({receipt,observedMenu:window.observedMenu,nonce:window.__TD_NATIVE_GATE_NONCE}));").arg(file).output().unwrap();
  assert!(output.status.success(),"{}",String::from_utf8_lossy(&output.stderr));
  let result:serde_json::Value=serde_json::from_slice(&output.stdout).unwrap();
  assert_eq!(result["observedMenu"],menu);assert_eq!(result["receipt"]["evalCompleted"],true);
  assert_eq!(result["receipt"]["pageEpoch"],"current");assert_eq!(result["nonce"],"nonce");
 }
 #[test]
 fn inert_desktop_update_fixture_refuses_stale_ready_and_never_calls_the_os_updater(){
  let mut updates=InteractionUpdates::default();assert_eq!(updates.snapshot()["controlledInstallCalls"],0);assert!(updates.install().unwrap_err().contains("Controlled desktop update failure"));assert_eq!(updates.installs,1);
  updates.ready=false;assert!(updates.install().is_err());assert_eq!(updates.installs,1);
  updates.ready=true;updates.allowed=true;assert_eq!(updates.install().unwrap()["status"],"restarting");assert_eq!(updates.installs,2);assert!(updates.install().is_err());assert_eq!(updates.snapshot()["realOsUpdaterCalled"],false);
 }
 #[test]
 fn ordinary_startup_has_no_owned_ready_state_or_interaction_profile(){
  initialize().unwrap();assert!(!active());assert!(configuration().is_none());assert!(GATE.get().is_none());
 }
 fn progress(epoch:&str,index:u64)->serde_json::Value{serde_json::json!({"pageEpoch":epoch,"progressIndex":index,"phase":"consumption-ack","lastAction":{"action":"write","sequence":7},"steps":[],"acks":[{"sequence":7,"token":"actual","epoch":"host"}],"stages":[{"phase":"consumption-ack","index":index}],"stageDropped":0})}
 #[test]
 fn deadline_retains_observed_ack_and_last_action_without_inventing_receipts(){
  let mut evidence=Evidence::default();assert!(evidence.accept(progress("page",1),"page"));
  let result=evidence.augment(serde_json::json!({"ok":false,"error":"Actual WK gate timed out"}));
  assert_eq!(result["acks"][0]["sequence"],7);assert_eq!(result["lastAction"]["action"],"write");assert_eq!(result["ok"],false);
  assert_eq!(Evidence::default().augment(serde_json::json!({"ok":false})).get("acks"),None);
 }
 #[test]
 fn evidence_rejects_stale_epoch_reordering_and_oversize_but_allows_reload(){
  let mut evidence=Evidence::default();assert!(evidence.accept(progress("old",2),"old"));
  assert!(!evidence.accept(progress("old",3),"new"));assert!(!evidence.accept(progress("old",1),"old"));
  assert!(evidence.accept(progress("new",1),"new"));
  let mut too_many=progress("new",2);too_many["acks"]=serde_json::json!(vec![serde_json::Value::Null;129]);assert!(!evidence.accept(too_many,"new"));
  evidence.updates=2048;assert!(!evidence.accept(progress("new",3),"new"));
 }
 #[test]
 fn private_stage_file_is_bounded_and_preserves_previous_snapshot_on_oversize(){
  let root=tempfile::tempdir().unwrap();let gate=Gate{benchmark_renderer:None,root:root.path().into(),url:"http://127.0.0.1:12345".into(),react:false,interaction_receiver:false,interactions:false,native_feedback:false,controlled_window_chrome:false,keyboard_manual:false,keyboard_before_native:false,interaction_updates:Mutex::new(Default::default()),connection:None,invitation:None,expected_peer:None,auth_handoff:Mutex::new(AuthHandoff::default()),nonce:"controlled-nonce".into(),page_epoch:Mutex::new(None),owner:Mutex::new(None),evidence:Mutex::new(Evidence::default()),pulls:Mutex::new(Pulls::default()),finished:AtomicBool::new(false)};
  let snapshot=progress("actual-page",1);persist(&gate,&snapshot).unwrap();
  let file=gate.root.join("native-workspace-progress.json");let bytes=std::fs::read(&file).unwrap();
  let actual:serde_json::Value=serde_json::from_slice(&bytes).unwrap();assert_eq!(actual["nonce"],"controlled-nonce");assert_eq!(actual["acks"],snapshot["acks"]);
  let mut too_large=snapshot;too_large["phase"]=serde_json::json!("x".repeat(81*1024));assert!(persist(&gate,&too_large).is_err());
  assert_eq!(std::fs::read(file).unwrap(),bytes);assert!(!gate.root.join("native-workspace-progress.pending").exists());
 }
 #[test]
 fn unexpected_epoch_is_interrupted_while_acknowledged_reload_intent_can_rebind(){
  let mut evidence=Evidence::default();assert_eq!(evidence.interruption("new"),None);
  let mut pending=progress("old",1);pending["phase"]=serde_json::json!("request-start");assert!(evidence.accept(pending.clone(),"old"));
  assert_eq!(evidence.interruption("new"),Some(pending));assert_eq!(evidence.interruption("old"),None);
  let mut reload=progress("old",2);reload["phase"]=serde_json::json!("reload-requested");assert!(evidence.accept(reload,"old"));assert_eq!(evidence.interruption("new"),None);
 }
 #[test]
 fn navigation_url_evidence_removes_credentials_queries_fragments_and_bounds_path(){
  let url=url::Url::parse("http://user:password@127.0.0.1:1234/workspace?secret=token#private").unwrap();assert_eq!(safe_url(&url),"http://127.0.0.1:1234/workspace");
  let url=url::Url::parse(&format!("http://127.0.0.1/{}","x".repeat(1000))).unwrap();assert!(safe_url(&url).len()<300);
  assert_eq!(safe_url(&url::Url::parse("data:text/html;base64,c2VjcmV0").unwrap()),"data:<opaque>");assert_eq!(safe_url(&url::Url::parse("file:///private/user-path").unwrap()),"file:<opaque>");
 }
 #[test]
 fn actual_generated_eval_wrapper_returns_a_scalar_receipt_without_restarting_driver(){
  let root=tempfile::tempdir().unwrap();let script=root.path().join("driver.js");std::fs::write(&script,driver_script("controlled","actual-page",None)).unwrap();
  let output=std::process::Command::new("node").arg("-e").arg("const fs=require('node:fs'),vm=require('node:vm');const result=vm.runInNewContext(fs.readFileSync(process.argv[1],'utf8'),{window:{__TD_NATIVE_GATE_RUNNING:true},location:{pathname:'/workspace'}});process.stdout.write(JSON.stringify(result));").arg(script).output().unwrap();
  assert!(output.status.success(),"{}",String::from_utf8_lossy(&output.stderr));let result:serde_json::Value=serde_json::from_slice(&output.stdout).unwrap();
  assert_eq!(result["evalCompleted"],true);assert_eq!(result["pageEpoch"],"actual-page");assert_eq!(result["before"]["running"],true);assert_eq!(result["before"]["ipcReady"],false);
 }
 #[test]
 fn producer_callback_preserves_actual_fixture_ack_and_rejects_empty_stale_or_oversize(){
  let value=serde_json::json!({"version":1,"nonce":"n","kind":"progress","data":progress("current",3)});let raw=value.to_string();
  let (_,data)=decode_producer(&raw,"n","current",2).unwrap();assert_eq!(data["acks"],value["data"]["acks"]);
  for (nonce,epoch,index) in [("wrong","current",0),("n","old",0),("n","current",4)]{assert!(decode_producer(&raw,nonce,epoch,index).is_err());}
  assert!(decode_producer("","n","current",0).unwrap_err().contains("empty"));assert!(decode_producer("null","n","current",0).is_err());assert!(decode_producer(&"x".repeat(65537),"n","current",0).is_err());
  let mut bad=value;bad["data"]["acks"]=serde_json::json!(vec![serde_json::Value::Null;129]);assert!(decode_producer(&bad.to_string(),"n","current",0).is_err());
 }
 #[test]
 fn producer_reads_have_one_inflight_and_one_latest_pending_with_idempotent_completion(){
  let mut pulls=Pulls::default();let key=|epoch:&str,index|Pull{id:0,window:"owned".into(),epoch:epoch.into(),index};
  let first=pulls.queue(key("old",1)).unwrap().unwrap();assert!(pulls.queue(key("old",2)).unwrap().is_none());assert!(pulls.queue(key("old",4)).unwrap().is_none());assert!(pulls.queue(key("old",3)).unwrap().is_none());assert_eq!(pulls.pending.as_ref().unwrap().index,4);
  assert!(pulls.complete(first.id+1).is_none());assert_eq!(pulls.active.as_ref().unwrap().id,first.id);
  pulls.queue(key("new",1)).unwrap();let pending=pulls.complete(first.id).unwrap().unwrap();assert_eq!(pending.epoch,"new");assert!(pulls.complete(first.id).is_none());
  let next=pulls.queue(pending).unwrap().unwrap();assert_eq!(next.id,first.id+1);assert!(pulls.pending.is_none());pulls.complete(next.id);pulls.issued=2048;assert!(pulls.queue(key("new",2)).is_err());
 }
 #[test]
 fn combined_native_ring_and_producer_state_serialize_whole_within_real_file_budget(){
  let root=tempfile::tempdir().unwrap();let gate=Gate{benchmark_renderer:None,root:root.path().into(),url:"http://127.0.0.1:12345".into(),react:false,interaction_receiver:false,interactions:false,native_feedback:false,controlled_window_chrome:false,keyboard_manual:false,keyboard_before_native:false,interaction_updates:Mutex::new(Default::default()),connection:None,invitation:None,expected_peer:None,auth_handoff:Mutex::new(AuthHandoff::default()),nonce:"controlled".into(),page_epoch:Mutex::new(None),owner:Mutex::new(None),evidence:Mutex::new(Evidence::default()),pulls:Mutex::new(Pulls::default()),finished:AtomicBool::new(false)};
  let mut evidence=Evidence::default();for id in 0..128{evidence.native_events.push_back(serde_json::json!({"phase":"main-thread-host-return","action":"create","requestId":id,"window":"controlled-window","requestEpoch":"11111111-1111-1111-1111-111111111111","currentPageEpoch":"11111111-1111-1111-1111-111111111111","status":"ok"}));}
  let mut value=progress("current",1);value["stages"]=serde_json::json!((0..128).map(|index|serde_json::json!({"index":index,"pageEpoch":"11111111-1111-1111-1111-111111111111","phase":"request-end","detail":{"action":"create","token":"controlled-token","receipt":{"token":"controlled-token","epoch":"11111111-1111-1111-1111-111111111111","sequence":3}}})).collect::<Vec<_>>());
  assert!(evidence.accept(value,"current"));let record=evidence.augment(serde_json::json!({"ok":false}));persist(&gate,&record).unwrap();let bytes=std::fs::read(gate.root.join("native-workspace-progress.json")).unwrap();assert!(bytes.len()<=80*1024);let actual:serde_json::Value=serde_json::from_slice(&bytes).unwrap();assert_eq!(actual["acks"],record["acks"]);assert_eq!(actual["nativeEvents"].as_array().unwrap().len(),128);assert_eq!(actual["stages"].as_array().unwrap().len(),128);
 }
 #[test]
 fn fixed_producer_expression_reads_only_preloaded_snapshot_and_returns_original_fields(){
  let root=tempfile::tempdir().unwrap();let script=root.path().join("read.js");let snapshot=serde_json::json!({"version":1,"nonce":"n","kind":"progress","data":progress("actual",5)});let wire=serde_json::to_string(&snapshot).unwrap();
  std::fs::write(&script,format!("const vm=require('node:vm');const result=vm.runInNewContext({},{{window:{{__TD_NATIVE_GATE_WIRE:{}}},TextEncoder}});process.stdout.write(JSON.stringify(result));",serde_json::to_string(producer_expression()).unwrap(),serde_json::to_string(&wire).unwrap())).unwrap();
  let output=std::process::Command::new("node").arg(&script).output().unwrap();assert!(output.status.success(),"{}",String::from_utf8_lossy(&output.stderr));
  let (_,actual)=decode_producer(std::str::from_utf8(&output.stdout).unwrap(),"n","actual",5).unwrap();assert_eq!(actual,snapshot["data"]);
 }
 #[test]
 fn react_fixture_descriptor_uses_normal_connection_validation_and_rejects_external_routes(){
  let descriptor=serde_json::json!({"url":"http://127.0.0.1:12345","serverRevision":"79feaf2442dd71a06806cc652252e9a7db4b54fb"});
  assert!(react_connection("http://127.0.0.1:12345",&descriptor).is_ok());
  assert!(react_connection("http://127.0.0.1:9834",&descriptor).is_err());
  let mut changed=descriptor;changed["url"]=serde_json::json!("http://example.com");assert!(react_connection("http://example.com",&changed).is_err());
 }
 #[test]
 fn first_pairing_handoff_requires_exact_fixture_target_zero_native_baseline_and_submit_receipt(){
  let old=Connection{id:"own".into(),url:"http://127.0.0.1:1234".into(),label:"Own".into(),target_peer_id:None,service_origin:None,entry_service_id:None,routes:vec![]};
  let mut next=old.clone();next.target_peer_id=Some("owned-peer".into());
  let mut last=progress("old-page",4);last["phase"]=serde_json::json!("normal-login-form-submit-ready");last["acks"]=serde_json::json!([]);
  let check=|last:&serde_json::Value,old:&Connection,next:&Connection|authorization_handoff(last,"old-page",&old.url,"owned-peer",old,next);
  assert_eq!(check(&last,&old,&next).unwrap()["previous"],last);
  let mut wrong=next.clone();wrong.target_peer_id=Some("other".into());assert!(check(&last,&old,&wrong).is_none());
  assert!(check(&last,&next,&next).is_none());
  for field in ["steps","acks"]{let mut pending=last.clone();pending[field]=serde_json::json!([{"sequence":1}]);assert!(check(&pending,&old,&next).is_none());}
  last["phase"]=serde_json::json!("request-start");assert!(check(&last,&old,&next).is_none());
 }
 #[test]
 fn retirement_receiver_pairing_handoff_is_opt_in_and_requires_the_owned_interactions_descriptor(){
  assert!(!fixture_pairing_handoff_allowed(false,false,false,false));
  assert!(!fixture_pairing_handoff_allowed(false,true,false,true));
  assert!(!fixture_pairing_handoff_allowed(false,true,true,false));
  assert!(fixture_pairing_handoff_allowed(false,true,true,true));
  assert!(fixture_pairing_handoff_allowed(true,false,false,false));
 }
 #[test]
 fn pairing_handoff_survives_duplicate_finish_only_once_and_cannot_rearm_after_consumption(){
  let mut handoff=AuthHandoff::default();let receipt=serde_json::json!({"oldEpoch":"old","targetPeerId":"owned"});
  assert!(handoff.arm(receipt.clone()));assert_eq!(handoff.take("old"),None);assert!(!handoff.arm(receipt.clone()));
  assert_eq!(handoff.take("new"),Some(receipt.clone()));assert_eq!(handoff.take("new"),None);assert!(!handoff.arm(receipt));
 }
 #[test]
 fn generated_react_eval_wrapper_preserves_a_running_same_document_driver(){
  let root=tempfile::tempdir().unwrap();let file=root.path().join("react-driver.js");
  let helpers=include_str!("../../renderer/native-workspace-gate.js").split_once("(async()=>{").unwrap().0;
  let body=format!("{helpers}\n{}",include_str!("../../renderer/native-react-workspace-gate.js"));std::fs::write(&file,driver_body("nonce","same",None,&body)).unwrap();
  let result=std::process::Command::new("node").arg("-e").arg("const fs=require('node:fs'),vm=require('node:vm');const window={__TD_NATIVE_GATE_RUNNING:true,__TD_NATIVE_GATE_STATE:{pageEpoch:'same',steps:[],acks:[],stages:[]}};const result=vm.runInNewContext(fs.readFileSync(process.argv[1],'utf8'),{window,location:{pathname:'/workspace'}});process.stdout.write(JSON.stringify(result));").arg(file).output().unwrap();assert!(result.status.success());
  let value:serde_json::Value=serde_json::from_slice(&result.stdout).unwrap();assert_eq!(value["evalCompleted"],true);assert_eq!(value["pageEpoch"],"same");
 }
 #[test]
 fn generated_retirement_receiver_injects_login_helper_before_driver(){
  let root=tempfile::tempdir().unwrap();let file=root.path().join("retirement-driver.js");
  let body=retirement_receiver_body("null","\"owned-target\"","\"http://127.0.0.1:12345\"","\"http://127.0.0.1:54321\"",false,"window.__loginHelperPresent=typeof tdNativeReactLoginForm==='function';");
  std::fs::write(&file,driver_body("nonce","page",None,&body)).unwrap();
  let output=std::process::Command::new("node").arg("-e").arg("const fs=require('node:fs'),vm=require('node:vm');const window={};const result=vm.runInNewContext(fs.readFileSync(process.argv[1],'utf8'),{window,location:{pathname:'/workspace'}});process.stdout.write(JSON.stringify({result,present:window.__loginHelperPresent}));").arg(file).output().unwrap();
  assert!(output.status.success(),"{}",String::from_utf8_lossy(&output.stderr));
  let value:serde_json::Value=serde_json::from_slice(&output.stdout).unwrap();assert_eq!(value["result"]["evalCompleted"],true);assert_eq!(value["present"],true);
 }
 #[test]
 fn generated_retirement_receiver_pairs_then_enters_on_a_new_proxy_document(){
  let root=tempfile::tempdir().unwrap();let script=root.path().join("receiver.js");let state_file=root.path().join("state.json");
  let old=Connection{id:"owned".into(),url:"http://127.0.0.1:12345".into(),label:"Owned".into(),target_peer_id:None,service_origin:None,entry_service_id:None,routes:vec![]};
  let mut next=old.clone();next.target_peer_id=Some("owned-peer".into());
  let mut state=serde_json::json!({"ownerOrigin":"http://127.0.0.1:54321","serviceOrigin":old.url,"connection":old,"acceptedConnection":next});
  let generated=|epoch:&str,interrupted:Option<serde_json::Value>,handoff:Option<serde_json::Value>,host_pin:bool|{
   retirement_receiver_script("owned-nonce",epoch,interrupted,handoff,"owned-peer",&old.url,"http://127.0.0.1:54321",host_pin)
  };
  let run=|stage:&str|{
   let output=std::process::Command::new("node").arg(concat!(env!("CARGO_MANIFEST_DIR"),"/../renderer/native-retirement-pairing.fixture.mjs")).arg(&script).arg(&state_file).arg(stage).output().unwrap();
   assert!(output.status.success(),"{}",String::from_utf8_lossy(&output.stderr));serde_json::from_slice::<serde_json::Value>(&output.stdout).unwrap()
  };
  std::fs::write(&script,generated("old-page",None,None,crate::shell::owned_gate_service_pin(&old,&old.url,"owned-peer").unwrap())).unwrap();std::fs::write(&state_file,serde_json::to_vec(&state).unwrap()).unwrap();let first=run("first");
  assert_eq!(first["submitted"],true,"{}",first["snapshot"]["error"]);assert_eq!(first["calls"],serde_json::json!([]));assert_eq!(first["ownerDiffersFromService"],true);assert_eq!(first["bootRemoved"],true);
  let saved:Connection=serde_json::from_value(first["savedConnection"].clone()).unwrap();
  let mut evidence=Evidence::default();assert!(evidence.accept(first["snapshot"].clone(),"old-page"));
  let mut authorized=authorization_handoff(evidence.latest.as_ref().unwrap(),"old-page",&old.url,"owned-peer",&old,&saved).unwrap();authorized["nonce"]=serde_json::json!("owned-nonce");
  let mut pending=AuthHandoff::default();assert!(pending.arm(authorized));assert!(pending.take("old-page").is_none());let handoff=pending.take("new-page");assert!(handoff.is_some());assert!(pending.take("new-page").is_none());
  // Reload replays the window creation script; only selected storage and host state change.
  state["storage"]=first["storage"].clone();
  std::fs::write(&state_file,serde_json::to_vec(&state).unwrap()).unwrap();std::fs::write(&script,generated("new-page",evidence.interruption("new-page"),handoff.clone(),crate::shell::owned_gate_service_pin(&saved,&old.url,"owned-peer").unwrap())).unwrap();let second=run("second");
  assert_eq!(second["snapshot"]["ok"],true,"{}",second["snapshot"]["error"]);assert_eq!(second["snapshot"]["steps"].as_array().unwrap().len(),6);assert_eq!(second["active"],serde_json::Value::Null);assert_eq!(second["bootRemoved"],true);assert_eq!(second["bridgePeerPresent"],false);
  let persisted:serde_json::Value=serde_json::from_str(first["storage"]["termdock-secure-target-v1"].as_str().unwrap()).unwrap();assert_eq!(persisted["url"],old.url);assert_eq!(persisted["targetPeerId"],"owned-peer");
  for field in ["page","service","peer"]{
   let mut wrong=state.clone();match field{"page"=>wrong["ownerOrigin"]=serde_json::json!("http://127.0.0.1:54322"),"service"=>wrong["connection"]["url"]=serde_json::json!("http://127.0.0.1:12346"),_=>wrong["connection"]["targetPeerId"]=serde_json::json!("wrong-peer")}
   std::fs::write(&state_file,serde_json::to_vec(&wrong).unwrap()).unwrap();let rejected=run("second");assert_eq!(rejected["snapshot"]["ok"],false,"{field}");let expected_error=match field{"page"=>"Owned service/page origin mismatch","service"=>"Owned service connection origin mismatch",_=>"A different target is selected"};assert!(rejected["snapshot"]["error"].as_str().unwrap().contains(expected_error),"{field}");assert_eq!(rejected["calls"],serde_json::json!([]),"{field}");
  }
  std::fs::write(&state_file,serde_json::to_vec(&state).unwrap()).unwrap();
  for mode in ["false","missing","string"]{
   let mut unverified=generated("new-page",evidence.interruption("new-page"),handoff.clone(),false);
   if mode=="missing"{unverified=unverified.replace("window.__TD_NATIVE_GATE_HOST_PIN_VERIFIED=false;","");}
   if mode=="string"{unverified=unverified.replace("window.__TD_NATIVE_GATE_HOST_PIN_VERIFIED=false;","window.__TD_NATIVE_GATE_HOST_PIN_VERIFIED='true';");}
   std::fs::write(&script,unverified).unwrap();let rejected=run("second");assert_eq!(rejected["snapshot"]["ok"],false,"{mode}");assert!(rejected["snapshot"]["error"].as_str().unwrap().contains("hostPin"),"{mode}");assert_eq!(rejected["calls"],serde_json::json!([]),"{mode}");
  }
  let mut wrong_handoff=handoff.unwrap();wrong_handoff["url"]=serde_json::json!("http://127.0.0.1:12346");
  std::fs::write(&state_file,serde_json::to_vec(&state).unwrap()).unwrap();std::fs::write(&script,generated("new-page",evidence.interruption("new-page"),Some(wrong_handoff),true)).unwrap();let rejected=run("second");assert_eq!(rejected["snapshot"]["ok"],false);assert!(rejected["snapshot"]["error"].as_str().unwrap().contains("serviceOrigin"));assert_eq!(rejected["calls"],serde_json::json!([]));
 }

}

#[cfg(test)]
mod keyboard_stage_tests {
 use super::*;
 #[test]fn fixed_keyboard_sequence_rejects_duplicates_out_of_order_and_unknown_payload(){
  let mut updates=InteractionUpdates::default();assert!(!updates.reserve_keyboard(1,1));
  for case in 0..6 {assert!(updates.reserve_keyboard(case,case as u64+1));assert!(!updates.reserve_keyboard(case,case as u64+1));}
  assert!(!updates.reserve_keyboard(6,7));
  assert!(serde_json::from_value::<KeyboardStage>(serde_json::json!({"caseIndex":0,"text":"arbitrary"})).is_err());
 }
}

#[cfg(test)]
mod keyboard_comparison_tests {
 #[test] fn ordered_owned_comparison_never_repeats_injection(){
  let mut state=super::InteractionUpdates::default();
  assert!(!state.reserve_keyboard_probe(0,1,1));assert!(!state.reserve_keyboard_probe(1,1,0));
  let mut index=1;
  for case in 0..5{for step in 0..3{assert!(state.reserve_keyboard_probe(case,index,step));assert!(!state.reserve_keyboard_probe(case,index,step));if step==1{assert!(!state.reserve_keyboard_probe(case,index+1,step));}index+=1;}}
  assert!(!state.reserve_keyboard_probe(5,index,0));
 }
}

#[cfg(test)]
mod manual_keyboard_counter_tests {
 use super::InteractionUpdates;
 #[test] fn coalesced_ready_stage_routes_arm_then_final_and_rejects_wrong_document(){
  let snapshot=serde_json::json!({"pageEpoch":"current","progressIndex":14,"phase":"manual-keyboard-state","stages":[
   {"pageEpoch":"old","index":2,"phase":"manual-keyboard-ready"},
   {"pageEpoch":"current","index":10,"phase":"manual-keyboard-ready"},
   {"pageEpoch":"current","index":11,"phase":"request-start"},
   {"pageEpoch":"current","index":14,"phase":"manual-keyboard-state"}]});
  let mut state=InteractionUpdates::default();assert_eq!(state.manual_counter_stage(&snapshot,"wrong"),None);
  assert_eq!(state.manual_counter_stage(&snapshot,"current"),Some((true,10)));
  assert_eq!(state.manual_counter_stage(&snapshot,"current"),None);
  let mut final_snapshot=snapshot;final_snapshot["progressIndex"]=24.into();final_snapshot["phase"]="manual-keyboard-final".into();
  final_snapshot["stages"].as_array_mut().unwrap().push(serde_json::json!({"pageEpoch":"current","index":24,"phase":"manual-keyboard-final"}));
  assert_eq!(state.manual_counter_stage(&final_snapshot,"current"),Some((false,24)));
  assert_eq!(state.manual_counter_stage(&final_snapshot,"current"),None);
 }
 #[test] fn counters_arm_once_and_read_only_new_bounded_states(){
  let mut state=InteractionUpdates::default();assert!(!state.reserve_manual_counter(false,1));
  assert!(state.reserve_manual_counter(true,2));assert!(!state.reserve_manual_counter(true,3));
  assert!(!state.reserve_manual_counter(false,2));
  assert!(state.reserve_manual_counter(false,3));
  assert!(!state.reserve_manual_counter(false,4));
 }
}
