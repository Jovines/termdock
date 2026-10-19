//! Optional isolated window-chrome diagnostics. No terminal engine or PTY access.
use crate::{config::{Config,Connection},window_chrome::Role};
use std::{path::PathBuf,sync::{Mutex,OnceLock}};
use tauri::{Manager,WebviewWindow};
struct Diagnostic { root:PathBuf, connection:Connection, invitation:Option<String>, nonce:String, restore:Mutex<Option<(String,String)>> }
static DIAGNOSTIC:OnceLock<Diagnostic>=OnceLock::new();
pub fn initialize()->Result<(),String>{
 let args:Vec<String>=std::env::args().collect();
 if args.get(1).map(String::as_str)!=Some("--window-chrome-check"){return Ok(());}
 if args.len()!=5||!cfg!(target_os="macos"){return Err("Usage: --window-chrome-check NEW_ABSOLUTE_DIRECTORY LOOPBACK_ORIGIN FIXTURE_DESCRIPTOR (macOS only)".into());}
 let root=PathBuf::from(&args[2]);let descriptor=PathBuf::from(&args[4]);
 if !root.is_absolute()||root.components().any(|p|matches!(p,std::path::Component::ParentDir))||!descriptor.is_absolute()||std::fs::metadata(&descriptor).map_err(|_|"Missing window fixture descriptor")?.len()>4096{return Err("Fresh absolute diagnostic directory and bounded fixture descriptor required".into());}
 let value:serde_json::Value=serde_json::from_slice(&std::fs::read(descriptor).map_err(|e|e.to_string())?).map_err(|e|e.to_string())?;
 let origin=crate::config::origin(&args[3])?;
 if value["url"].as_str()!=Some(&origin)||value["controlledWindowChrome"]!=true{return Err("Window diagnostic descriptor mismatch".into());}
 let text=|key:&str|value[key].as_str().map(str::to_owned);
 let connection=Connection{id:"window-chrome-check".into(),url:origin,label:"Window diagnostic".into(),target_peer_id:text("targetPeerId"),service_origin:text("serviceOrigin"),entry_service_id:text("entryServiceId"),routes:vec![]}.validated()?;
 for origin in connection.origins(){let url=url::Url::parse(&origin).map_err(|e|e.to_string())?;if url.scheme()!="http"||url.host_str()!=Some("127.0.0.1")||url.port().is_none()||url.port()==Some(9834){return Err("Window diagnostic routes must use private non-production loopback ports".into());}}
 if connection.target_peer_id.is_none(){return Err("Window diagnostic requires a fixture peer identity".into());}
 let invitation=text("invitation");if let Some(value)=&invitation{connection.validate_invitation(value)?;}
 std::fs::create_dir(&root).map_err(|e|e.to_string())?;
 #[cfg(unix)] {use std::os::unix::fs::PermissionsExt;std::fs::set_permissions(&root,std::fs::Permissions::from_mode(0o700)).map_err(|e|e.to_string())?;}
 DIAGNOSTIC.set(Diagnostic{root,connection,invitation,nonce:uuid::Uuid::new_v4().to_string(),restore:Mutex::new(None)}).map_err(|_|"Window diagnostics already initialized".into())
}
pub fn active()->bool{DIAGNOSTIC.get().is_some()}
pub fn chrome_enabled()->bool{active()}
pub fn chrome_path()->Option<PathBuf>{Some(DIAGNOSTIC.get()?.root.join("window-chrome-diagnostic.json"))}
pub fn configuration()->Option<(PathBuf,Config)>{let d=DIAGNOSTIC.get()?;let mut c=Config::default();c.imported_bookmarks=true;c.desktop_preferences.floating_widget_enabled=false;c.connections.push(d.connection.clone());c.open_connections.push(d.connection.id.clone());Some((d.root.join("connections.json"),c))}
pub fn profile(key:&str)->Option<String>{Some(format!("window-check:{}:{key}",DIAGNOSTIC.get()?.nonce))}
pub fn invitation()->Option<String>{DIAGNOSTIC.get()?.invitation.clone()}
pub fn chrome_role(window:&WebviewWindow,require_pin:bool)->Option<Role>{
 let d=DIAGNOSTIC.get()?;let center=crate::shell::check_caller(window.app_handle(),window).ok()?;
 if center{return (window.label()=="center").then_some(Role::Center);}
 let (_,pinned)=crate::shell::verified_service_page_context(window,&d.connection.url,d.connection.target_peer_id.as_deref()?).ok()?;
 (!require_pin||pinned).then_some(Role::Service)
}
pub fn titlebar_restore_owner_matches(window:&WebviewWindow,epoch:&str)->bool{chrome_role(window,true)==Some(Role::Service)&&crate::shell::page_epoch(window).as_deref()==Some(epoch)}
pub fn arm_titlebar_restore(window:&WebviewWindow,epoch:&str)->bool{if !titlebar_restore_owner_matches(window,epoch){return false;}*DIAGNOSTIC.get().unwrap().restore.lock().unwrap()=Some((window.label().into(),epoch.into()));true}
pub fn consume_titlebar_restore(window:&WebviewWindow,epoch:&str)->bool{if !titlebar_restore_owner_matches(window,epoch){return false;}let mut value=DIAGNOSTIC.get().unwrap().restore.lock().unwrap();if value.as_ref().is_some_and(|(w,e)|w==window.label()&&e==epoch){value.take();true}else{false}}
