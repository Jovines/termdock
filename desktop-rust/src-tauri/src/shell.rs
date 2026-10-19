use crate::{
    config::{origin, Config, Connection},
    desktop_ui, download_save, local_files, local_service, native_desktop,
    proxy::{self, ProxyHandle},
    tls,
};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    collections::BTreeMap,
    path::PathBuf,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};
use tauri::{
    ipc::CapabilityBuilder, AppHandle, Manager, WebviewUrl, WebviewWindow, WebviewWindowBuilder,
};

// Generated from the shared CSS token before the first WK paint, not after DOM load.
fn initial_window_background()->tauri::window::Color {
    let [r,g,b]:[u8;3]=serde_json::from_str(include_str!("../../.renderer-dist/window-background.json")).expect("Generated window background");
    tauri::window::Color(r,g,b,255)
}

pub(crate) struct ServiceWindow {
    pub(crate) connection: Connection,
    proxy: ProxyHandle,
    pub(crate) activity: Value,
    pending_focus: Option<(String, String)>,
}
struct NativeDrop {
    owner: String,
    paths: Vec<PathBuf>,
    expires: Instant,
    view: Option<String>,
    target: Option<String>,
    epoch: Option<String>,
}
#[derive(Clone)]
struct CertificateReceipt {
    window: String,
    epoch: String,
    origin: String,
    fingerprint: String,
    expires: Instant,
    inflight: bool,
    cancelled: bool,
}
#[derive(Default)]
struct CertificateReceipts(Mutex<BTreeMap<String, CertificateReceipt>>);
impl CertificateReceipts {
    fn issue(&self, receipt: String, value: CertificateReceipt) {
        let mut receipts=self.0.lock().unwrap();
        receipts.retain(|_, item| item.expires > Instant::now());
        if receipts.len() >= 128 { receipts.clear(); }
        receipts.insert(receipt,value);
    }
    fn claim(&self, id:&str, window:&str, epoch:&str, origin:&str, fingerprint:&str) -> Result<CertificateReceipt,String> {
        let mut receipts=self.0.lock().unwrap();
        let value=receipts.get_mut(id).ok_or("Certificate inspection expired or was already used")?;
        if value.window!=window||value.epoch!=epoch||value.origin!=origin||value.fingerprint!=fingerprint||value.expires<=Instant::now()||value.cancelled {
            return Err("Certificate confirmation belongs to a different, cancelled, or expired inspection".into());
        }
        if value.inflight { return Err("Certificate confirmation is already in progress".into()); }
        value.inflight=true;Ok(value.clone())
    }
    fn discard(&self,id:&str,window:&str,epoch:&str) {
        let mut receipts=self.0.lock().unwrap();
        if let Some(value)=receipts.get_mut(id).filter(|v|v.window==window&&v.epoch==epoch) {
            if value.inflight { value.cancelled=true; } else { receipts.remove(id); }
        }
    }
    fn commit(&self, id: &str, expected: &CertificateReceipt, persist: impl FnOnce() -> Result<(), String>) -> Result<(), String> {
        let mut receipts = self.0.lock().unwrap();
        let live = receipts.get(id).is_some_and(|r| r.window == expected.window && r.epoch == expected.epoch
            && r.origin == expected.origin && r.fingerprint == expected.fingerprint
            && r.inflight && !r.cancelled && r.expires > Instant::now());
        if !live { receipts.remove(id); return Err("Certificate confirmation was cancelled, expired, or belongs to an old page".into()); }
        let result = persist();
        receipts.remove(id);
        result
    }
    fn finish(&self,id:&str,consume:bool) {
        let mut receipts=self.0.lock().unwrap();
        if consume { receipts.remove(id); }
        else if let Some(value)=receipts.get_mut(id) { if value.cancelled||value.expires<=Instant::now(){receipts.remove(id);}else{value.inflight=false;} }
    }
}
impl NativeDrop {
    fn matches(&self, owner: &str, now: Instant, view: Option<&str>, target: Option<&str>, epoch: Option<&str>) -> bool {
        self.owner == owner
            && self.expires > now
            && self.view.as_deref().is_none_or(|expected| Some(expected) == view)
            && self.target.as_deref().is_none_or(|expected| Some(expected) == target)
            && self.epoch.as_deref().is_none_or(|expected| Some(expected) == epoch)
    }
}
pub(crate) struct Shell {
    pub(crate) file: PathBuf,
    pub(crate) config: Mutex<Config>,
    pub(crate) windows: Mutex<BTreeMap<String, ServiceWindow>>,
    openings: tokio::sync::Mutex<()>,
    permissions: Mutex<std::collections::BTreeSet<String>>,
    pub(crate) last_focused: Mutex<Option<String>>,
    pub(crate) tray: Mutex<Option<tauri::tray::TrayIcon>>,
    pub(crate) zooms: Mutex<BTreeMap<String, f64>>,
    drops: Mutex<BTreeMap<String, NativeDrop>>,
    files: Arc<Mutex<local_files::Transfers>>,
    downloads: Arc<Mutex<download_save::DownloadWrites>>,
    file_requests: Arc<tokio::sync::Semaphore>,
    file_io: Arc<tokio::sync::Semaphore>,
    file_epochs: Arc<Mutex<BTreeMap<String, String>>>,
    certificate_receipts: CertificateReceipts,
    quitting: AtomicBool,
    restoring: AtomicBool,
    setup_operation: tokio::sync::Mutex<()>,
    notification_receipts: Mutex<Vec<Value>>,
    unread_notifications: Mutex<std::collections::BTreeSet<String>>,
}
pub(crate) fn page_epoch(window:&WebviewWindow)->Option<String>{
    let shell=state(window.app_handle());
    if !shell.windows.lock().unwrap().contains_key(window.label()){return None;}
    let epoch=shell.file_epochs.lock().unwrap().get(window.label()).cloned();epoch
}
fn current_document_epoch(window: &WebviewWindow) -> Option<String> {
    let shell = state(window.app_handle());
    let known = matches!(window.label(), "center" | "floating")
        || shell.windows.lock().unwrap().contains_key(window.label());
    if !known {
        return None;
    }
    let epoch = shell.file_epochs.lock().unwrap().get(window.label()).cloned();
    epoch
}
pub(crate) fn page_document_started(window: &WebviewWindow) {
    let epoch = uuid::Uuid::new_v4().to_string();
    state(window.app_handle()).file_epochs.lock().unwrap().insert(window.label().into(), epoch);
}
pub(crate) fn publish_document_epoch(window: &WebviewWindow) {
    let Some(epoch) = current_document_epoch(window) else { return; };
    let script = format!(
        "window.dispatchEvent(new CustomEvent('termdock:window-document-epoch',{{detail:{{epoch:{}}}}}));",
        json!(epoch)
    );
    let _ = window.eval(&script);
}
fn drag_epoch_matches(current: Option<&str>, requested: Option<&str>) -> bool {
    current.is_some_and(|value| !value.is_empty() && requested == Some(value))
}
fn certificate_center_epoch(app:&AppHandle,window:&WebviewWindow)->Result<String,String>{
 if window.label()!="center"||!check_caller(app,window)?{return Err("Certificate management is only available from the Preview connection center".into());}
 state(app).file_epochs.lock().unwrap().get(window.label()).cloned().ok_or_else(||"Connection center page is no longer active".into())
}
pub(crate) fn state(app: &AppHandle) -> tauri::State<'_, Shell> {
    app.state::<Shell>()
}
pub(crate) fn show_center(app: &AppHandle) -> Result<(), String> {
    if let Some(window) = app.get_webview_window("center") {
        window.show().map_err(|e| e.to_string())?;
        window.set_focus().map_err(|e| e.to_string())?;
        return Ok(());
    }
    let navigation_app=app.clone();
    let chrome_instance=crate::window_chrome::new_instance();
    #[allow(unused_mut)]
    let mut builder =
        WebviewWindowBuilder::new(app, "center", WebviewUrl::App("index.html".into()))
            .title("Termdock Preview · 连接中心")
            .visible(false)
            .background_color(initial_window_background())
            .inner_size(1280., 820.)
            .maximized(true)
            .min_inner_size(760., 520.)
            .initialization_script(local_bridge())
            .on_page_load(move |w, payload| {
                if payload.event() == tauri::webview::PageLoadEvent::Started {
                    state(w.app_handle())
                        .file_epochs
                        .lock()
                        .unwrap()
                        .insert(w.label().into(), uuid::Uuid::new_v4().to_string());
                    if let Ok(mut files) = state(w.app_handle()).files.try_lock() {
                        files.close_window(w.label());
                    }
                    if let Ok(mut downloads) = state(w.app_handle()).downloads.try_lock() {
                        downloads.close_window(w.label());
                    }
                    crate::window_chrome::page_started(&w,chrome_instance);
                } else {
                    publish_document_epoch(&w);
                    crate::window_chrome::page_finished(&w,chrome_instance);
                }
            })
            .on_navigation(move |_| {
                if crate::window_diagnostics::chrome_enabled() {
                    if let Some(w)=navigation_app.get_webview_window("center") {
                        crate::window_chrome::invalidate_instance(&w,true,chrome_instance);
                    }
                }
                true
            });
    #[cfg(target_os = "macos")]
    {
        builder = builder
            .title_bar_style(tauri::TitleBarStyle::Overlay)
            // Native alignment owns button frames. Wry's inset implementation
            // also resizes an AppKit ancestor during draw/zoom; do not mix them.
            .hidden_title(true);
    }
    let window = builder.build().map_err(|e| e.to_string())?;
    observe_window(app, &window, None,chrome_instance);
    present_window(&window)?;
    Ok(())
}
pub(crate) fn announce<R: tauri::Runtime>(app: &AppHandle<R>, event: &str, value: Value) {
    let script = format!(
        "window.dispatchEvent(new CustomEvent({},{{detail:{}}}));",
        json!(event),
        value
    );
    for window in app.webview_windows().values() {
        let _ = window.eval(&script);
    }
}
pub(crate) fn store(app: &AppHandle) -> Result<(), String> {
    let shell = state(app);
    shell.config.lock().unwrap().persist(&shell.file)?;
    announce(app, "termdock:preview-connections", Value::Null);
    desktop_ui::install_menu(app)?;
    Ok(())
}
pub(crate) fn check_caller(app: &AppHandle, window: &WebviewWindow) -> Result<bool, String> {
    let url = window.url().map_err(|e| e.to_string())?;
    if ["center", "floating"].contains(&window.label()) {
        if url.scheme() == "tauri" || url.host_str() == Some("tauri.localhost") {
            return Ok(true);
        }
        return Err("Connection center origin mismatch".into());
    }
    let shell = state(app);
    let windows = shell.windows.lock().unwrap();
    let service = windows
        .get(window.label())
        .ok_or("Unknown service window")?;
    if url.origin().ascii_serialization() != service.proxy.origin {
        return Err("Service window origin mismatch".into());
    }
    Ok(false)
}
fn preview_drop_css_point(x: f64, y: f64, page_zoom: f64) -> (f64, f64) {
    let zoom = if page_zoom.is_finite() && (0.25..=4.0).contains(&page_zoom) {
        page_zoom
    } else {
        1.0
    };
    // Wry reports AppKit logical points, already in the same coordinate unit
    // as CSS viewport points. Applying backingScaleFactor here halves Retina
    // coordinates a second time. Only page zoom changes CSS hit-test units.
    (x / zoom, y / zoom)
}
// Read-only opt-in driver context, including the normal caller validation.
pub(crate) fn owned_gate_service_pin(connection:&Connection,expected_service:&str,expected_peer:&str)->Result<bool,String>{
    if connection.url!=expected_service{return Err("Owned service workspace mismatch".into());}
    match connection.target_peer_id.as_deref(){None=>Ok(false),Some(peer) if peer==expected_peer=>Ok(true),_=>Err("Owned service pin mismatch".into())}
}
pub(crate) fn verified_service_page_context(window:&WebviewWindow,expected_service:&str,expected_peer:&str)->Result<(String,bool),String>{
    if check_caller(window.app_handle(),window)?{return Err("Gate requires a service workspace".into());}
    let shell=state(window.app_handle());let windows=shell.windows.lock().unwrap();let service=windows.get(window.label()).ok_or("Unknown service workspace")?;
    let pinned=owned_gate_service_pin(&service.connection,expected_service,expected_peer)?;Ok((service.proxy.origin.clone(),pinned))
}
fn parse_connection(args: &Value) -> Result<Connection, String> {
    serde_json::from_value::<Connection>(args.get("connection").cloned().ok_or("Missing service")?)
        .map_err(|_| "Invalid service metadata")?
        .validated()
}
fn text<'a>(args: &'a Value, key: &str) -> Result<&'a str, String> {
    args.get(key)
        .and_then(Value::as_str)
        .ok_or_else(|| format!("Missing {key}"))
}
fn connection_conflict(config: &Config, connection: &Connection) -> bool {
    config.connections.iter().any(|old| {
        (old.id == connection.id || old.key() == connection.key() || old.url == connection.url)
            && old.target_peer_id.is_some()
            && connection.target_peer_id.is_some()
            && old.target_peer_id != connection.target_peer_id
    })
}
pub(crate) async fn open_connection(
    app: &AppHandle,
    mut connection: Connection,
    invitation: Option<String>,
) -> Result<Value, String> {
    let shell = state(app);
    let _opening = shell.openings.lock().await;
    if let Some(invitation) = &invitation {
        connection.validate_invitation(invitation)?;
    } else {
        connection = crate::config::resolve_saved_connection(&shell.config.lock().unwrap().connections, connection);
    }
    let mut pins = shell.config.lock().unwrap().certificate_pins.clone();
    if !crate::window_diagnostics::active(){
        if let Some(pin) = local_service::local_pin(&connection.url) {pins.entry(connection.url.clone()).or_insert(pin);}
    }
    if connection.target_peer_id.is_none() {
        // Read-only open discovery is optional. Protected URL-only windows
        // use the existing OPAQUE UI, then preserve the verified peer pin.
        let source = proxy::upstream(
            connection.url.clone(),
            pins.get(&connection.url).map(String::as_str),
        )?;
        let response = source
            .http
            .get(format!("{}/api/auth/open/parameters", connection.url))
            .send()
            .await
            .map_err(|error| {
                eprintln!("[Termdock Preview] service discovery failed for {}: {error:#}", connection.url);
                "Cannot discover service. Verify the address and Preview certificate fingerprint."
            })?;
        if response.status().is_success() {
            let bytes = response.bytes().await.map_err(|e| e.to_string())?;
            if bytes.len() > 64 * 1024 {
                return Err("Invalid discovery response".into());
            }
            let data: Value =
                serde_json::from_slice(&bytes).map_err(|_| "Invalid discovery response")?;
            connection.target_peer_id = Some(text(&data, "serviceIdentity")?.to_owned());
            connection = connection.validated()?;
        } else if ![401, 403].contains(&response.status().as_u16()) {
            return Err("服务授权入口暂不可用，请稍后重试".into());
        }
    }
    {
        let config = shell.config.lock().unwrap();
        if connection_conflict(&config, &connection) {
            return Err("Pinned target identity changed. Remove the old connection explicitly before adding it again.".into());
        }
    }
    let existing = shell
        .windows
        .lock()
        .unwrap()
        .iter()
        .find(|(_, w)| w.connection.key() == connection.key())
        .map(|(l, _)| l.clone());
    let label = existing.unwrap_or_else(|| connection.window_label());
    if let Some(window) = app.get_webview_window(&label) {
        // Deliver invitations only by reloading the same verified connection;
        // never let a stale window silently ignore a fresh authorization invite.
        if invitation.is_none() {
            window.show().map_err(|e| e.to_string())?;
            window.set_focus().map_err(|e| e.to_string())?;
            return Ok(json!({"ok":true,"url":connection.url}));
        }
        return Err("Close this service window before opening a new invitation for it.".into());
    }
    let port = shell
        .config
        .lock()
        .unwrap()
        .ports
        .get(&connection.key())
        .copied();
    let listener = proxy::bind(port).await?;
    let port = listener.local_addr().map_err(|e| e.to_string())?.port();
    // Persist the port before page creation. Do not silently move identities if
    // another process occupies that origin after restart.
    {
        let mut config = shell.config.lock().unwrap();
        config.ports.insert(connection.key(), port);
        config.save_connection(connection.clone(), true);
        connection = config
            .connections
            .iter()
            .find(|c| c.key() == connection.key())
            .cloned()
            .unwrap_or(connection);
        config.last_connection_url = Some(connection.url.clone());
        config.last_connected.insert(
            connection.id.clone(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap_or_default()
                .as_millis() as u64,
        );
        if !config.open_connections.contains(&connection.id) {
            config.open_connections.push(connection.id.clone());
        }
        config
            .profile_keys
            .entry(connection.key())
            .or_insert_with(|| crate::window_diagnostics::profile(&connection.key()).unwrap_or_else(||connection.key()));
        config.persist(&shell.file)?;
    }
    let assets = app
        .path()
        .resolve("workspace", tauri::path::BaseDirectory::Resource)
        .map_err(|e| e.to_string())?;
    let (proxy, origins) =
        proxy::start_with_assets(listener, &connection, &pins, Some(assets)).await?;
    let default_origin = connection
        .service_origin
        .as_ref()
        .unwrap_or(&connection.url);
    let default_route = origins.iter().position(|o| o == default_origin).unwrap();
    let boot = json!({"origin":proxy.origin,"origins":origins,"defaultRoute":default_route,"connection":connection,"invitation":invitation,
        "chromeCss":include_str!("../../renderer/chrome.css"),"version":app.package_info().version.to_string(),"bundledWorkspace":true,"ownedWindowChrome":crate::window_diagnostics::chrome_enabled(),"platform":if cfg!(target_os="macos") { "darwin" } else { std::env::consts::OS }});
    let script = format!(
        "window.__TD_PREVIEW_BOOT__={boot};\n{}",
        include_str!("../../renderer/bridge.js")
    );
    // Exact origin + exact webview label; no wildcard remote IPC capability and
    // no filesystem/shell/plugin permissions are granted to service pages.
    {
        let mut permissions = shell.permissions.lock().unwrap();
        if !permissions.contains(&label) {
            app.add_capability(
                CapabilityBuilder::new(format!("{label}-bridge"))
                    .local(false)
                    .remote(format!("{}/", proxy.origin))
                    .webview(&label)
                    .permission("allow-preview-dispatch"),
            )
            .map_err(|e| e.to_string())?;
            permissions.insert(label.clone());
        }
    }
    let url = proxy
        .launch_url
        .parse()
        .map_err(|_| "Invalid local window address")?;
    let allowed_origin = proxy.origin.clone();
    shell.windows.lock().unwrap().insert(
        label.clone(),
        ServiceWindow {
            connection: connection.clone(),
            proxy,
            activity: json!({"runningCount":0,"reviewCount":0}),
            pending_focus: None,
        },
    );
    let chrome_instance=crate::window_chrome::new_instance();
    let navigation_app = app.clone();
    let new_window_app = app.clone();
    let mut builder = WebviewWindowBuilder::new(app, &label, WebviewUrl::External(url))
        .title(format!("{} · Termdock Preview", connection.label))
        .visible(false)
        .background_color(initial_window_background())
        .inner_size(1500., 820.)
        .min_inner_size(760., 520.)
        .background_throttling(tauri::utils::config::BackgroundThrottlingPolicy::Disabled)
        .initialization_script(&script)
        .on_page_load(move |w, payload| {
            let route=match payload.url().path(){"/health"|"/api/auth/status"=>"bootstrap","/"=>"root",_=>"other"};
            eprintln!("Termdock workspace navigation: {:?} {}",payload.event(),route);
            if payload.event() == tauri::webview::PageLoadEvent::Started {
                state(w.app_handle())
                    .file_epochs
                    .lock()
                    .unwrap()
                    .insert(w.label().into(), uuid::Uuid::new_v4().to_string());
                if let Ok(mut files) = state(w.app_handle()).files.try_lock() {
                    files.close_window(w.label());
                }
                if let Ok(mut downloads) = state(w.app_handle()).downloads.try_lock() {
                    downloads.close_window(w.label());
                }
                crate::window_chrome::page_started(&w,chrome_instance);
            }
            if payload.event() == tauri::webview::PageLoadEvent::Finished {
                deliver_pending_focus(w.app_handle(), &w);
                publish_document_epoch(&w);
                crate::window_chrome::page_finished(&w,chrome_instance);
            }
        })
        .on_navigation(move |url| {
            if url.origin().ascii_serialization() == allowed_origin
                || url.scheme() == "blob"
                || url.as_str() == "about:blank"
            {
                return true;
            }
            if ["http", "https", "mailto"].contains(&url.scheme()) {
                let _ = open::that(url.as_str());
            }
            let _ = show_center(&navigation_app);
            false
        })
        .on_new_window(move |url, _| {
            if ["http", "https", "mailto"].contains(&url.scheme()) {
                let _ = open::that(url.as_str());
            } else {
                let _ = show_center(&new_window_app);
            }
            tauri::webview::NewWindowResponse::Deny
        });
    if let Some(bounds) = desktop_ui::window_bounds(app, &connection.key()) {
        builder = builder
            .position(bounds.x, bounds.y)
            .inner_size(bounds.width, bounds.height)
            .fullscreen(bounds.fullscreen);
    }
    // Open workspaces maximized even if an older normal-size frame was saved.
    // Preserve the existing true macOS fullscreen preference when requested.
    builder = builder.maximized(true);
    #[cfg(target_os = "macos")]
    {
        builder = builder
            .title_bar_style(tauri::TitleBarStyle::Overlay)
            .hidden_title(true);
        let profile = shell
            .config
            .lock()
            .unwrap()
            .profile_keys
            .get(&connection.key())
            .cloned()
            .unwrap_or_else(|| connection.key());
        let digest = Sha256::digest(format!("com.jovines.termdock.preview:{}", profile).as_bytes());
        let mut id = [0u8; 16];
        id.copy_from_slice(&digest[..16]);
        builder = builder.data_store_identifier(id);
    }
    #[cfg(not(target_os = "macos"))]
    {
        builder =
            builder.data_directory(shell.file.parent().unwrap().join("webviews").join(format!(
                "service-{}",
                hex::encode(sha2::Sha256::digest(
                    shell
                        .config
                        .lock()
                        .unwrap()
                        .profile_keys
                        .get(&connection.key())
                        .cloned()
                        .unwrap_or_else(|| connection.key())
                        .as_bytes()
                ))[..24]
                    .to_owned()
            )));
    }
    let window = match builder.build() {
        Ok(window) => window,
        Err(e) => {
            shell.windows.lock().unwrap().remove(&label);
            return Err(e.to_string());
        }
    };
    observe_window(app, &window, Some(connection.id.clone()),chrome_instance);
    present_window(&window)?;
    desktop_ui::publish(app);
    desktop_ui::install_menu(app)?;
    announce(app, "termdock:preview-connections", Value::Null);
    Ok(json!({"ok":true,"url":connection.url}))
}
// Return only metadata; callers invoke diagnostics after both mutex guards drop.
fn update_unpaired_window(windows:&Mutex<BTreeMap<String,ServiceWindow>>,config:&Mutex<Config>,label:&str,connection:&Connection)->Option<(Connection,Connection)> {
    let mut windows=windows.lock().unwrap();
    if let Some(service)=windows.get_mut(label) {
        if service.connection.url == connection.url
            && service.connection.target_peer_id.is_none()
            && connection.target_peer_id.is_some()
        {
            let previous=service.connection.clone();
            let old_key = service.connection.key();
            let new_key = connection.key();
            let mut config = config.lock().unwrap();
            if let Some(port) = config.ports.get(&old_key).copied() {
                config.ports.insert(new_key.clone(), port);
            }
            let profile = config
                .profile_keys
                .get(&old_key)
                .cloned()
                .unwrap_or(old_key);
            config.profile_keys.insert(new_key, profile);
            service.connection = config
                .connections
                .iter()
                .find(|c| c.key() == connection.key())
                .cloned()
                .unwrap_or_else(||connection.clone());
            return Some((previous,service.connection.clone()));
        }
    }
    None
}
#[tauri::command]
async fn preview_dispatch(
    app: AppHandle,
    window: WebviewWindow,
    op: String,
    args: Value,
) -> Result<Value, String> {
    let center = match check_caller(&app, &window){Ok(center)=>center,Err(error)=>{
        if op=="dragWindow"{crate::window_chrome::caller_rejected(&window);}
        return Err(error);
    }};
    if op == "startupObservation" {
        let category=args["category"].as_str().ok_or("Missing startup category")?;
        if !["login-visible","native-mounted","identity-open","identity-success","identity-error","identity-blocked","react-error","document-hidden","document-visible","status-loading","status-engine","status-other","root-mounted","root-empty","engine-ready","engine-failed","script-load-error","script-error","unhandled-rejection","document-loaded","terminal-mounted","terminal-absent","retry-identity","retry-authorization","retry-timeout","retry-socket","retry-bootstrap","retry-network","retry-route","retry-crypto","retry-other"].contains(&category){return Err("Invalid startup category".into());}
        if center{return Err("Startup observation requires a workspace".into());}
        eprintln!("Termdock workspace startup: {}",category);
        return Ok(Value::Null);
    }
    if op == "windowChromeObservation" { return crate::window_chrome::observe(&window,args); }
    if op == "windowBackground" {
        let rgb=args["rgb"].as_array().filter(|v|v.len()==3).ok_or("Invalid window background")?;
        let mut channels=[0u8;3];
        for (index,value) in rgb.iter().enumerate() {
            channels[index]=value.as_u64().filter(|v|*v<=255).ok_or("Invalid window background")? as u8;
        }
        window.set_background_color(Some(tauri::window::Color(channels[0],channels[1],channels[2],255))).map_err(|e|e.to_string())?;
        // Keep WK's public backing-page color on its actual AppKit thread too.
        #[cfg(target_os="macos")]
        window.with_webview(move |webview| unsafe {
            extern "C" {fn td_preview_window_background(wk_view:*mut std::ffi::c_void,red:u8,green:u8,blue:u8);}
            td_preview_window_background(webview.inner().cast(),channels[0],channels[1],channels[2]);
        }).map_err(|e|e.to_string())?;
        return Ok(Value::Null);
    }
    if op == "titlebarDoubleClick" {
        #[cfg(target_os = "macos")]
        {
            let restore=match args.get("restore") {Some(Value::Bool(value))=>*value,Some(_)=>return Err("Invalid titlebar restore flag".into()),None=>false};
            let restore_epoch=if restore {
                let epoch=page_epoch(&window).ok_or("Titlebar restore has no owned service page epoch")?;
                if !crate::window_diagnostics::consume_titlebar_restore(&window,&epoch){return Err("No current owned titlebar minimize is available to restore".into());}
                Some(epoch)
            }else{None};
            let receipt=titlebar_double_click(&window,args,restore_epoch).await?;
            if !restore&&receipt["action"]=="Minimize"&&receipt["after"]["isMiniaturized"]==true {
                if let Some(epoch)=page_epoch(&window){crate::window_diagnostics::arm_titlebar_restore(&window,&epoch);}
            }
            return Ok(receipt);
        }
        return Ok(Value::Null);
    }
    let shell = state(&app);
    if [
        "trustCertificate",
        "revokeCertificate",
        "inspectCertificate",
        "discardCertificateInspection",
        "certificatePins",
        "openLocal",
        "prepareLocal",
        "downloadNode",
        "notificationReceipts",
    ]
    .contains(&op.as_str())
        && !center
    {
        return Err("This operation is only available from the Preview connection center".into());
    }
    let file_owner_at_start = if [
        "clipboardImage",
        "clipboardFiles",
        "chooseFiles",
        "dropFiles",
        "fileChunk",
        "releaseFiles",
        "downloadStart",
        "downloadChunk",
        "downloadFinish",
        "downloadCancel",
    ]
    .contains(&op.as_str())
    {
        Some(file_owner(&app, &window)?)
    } else {
        None
    };
    match op.as_str() {
        "snapshot" => snapshot(&app).await,
        "desktopStatus" => Ok(desktop_ui::summary(&app, Some(window.label()))),
        "prepareLocal" => {
            let _operation = shell.setup_operation.lock().await;
            let pins = shell.config.lock().unwrap().certificate_pins.clone();
            let result = local_service::prepare(&pins, args["install"] == true, |v| {
                announce(&app, "termdock:preview-setup", v)
            })
            .await;
            if let Err(error) = result {
                announce(
                    &app,
                    "termdock:preview-setup",
                    json!({"phase":"error","message":"本机服务准备失败，请查看详情后重试。","details":error}),
                );
                return Err(error);
            }
            snapshot(&app).await
        }
        "downloadNode" => {
            open::that("https://nodejs.org/en/download").map_err(|e| e.to_string())?;
            Ok(Value::Null)
        }
        "probe" => {
            let pins = shell.config.lock().unwrap().certificate_pins.clone();
            Ok(local_service::probe(text(&args, "url")?, &pins).await)
        }
        "connect" => connect_address(&app, text(&args, "url")?).await,
        "preferences" => {
            {
                let mut config = shell.config.lock().unwrap();
                let patch = &args["preferences"];
                if let Some(v) = patch["menuBarStatusEnabled"].as_bool() {
                    config.desktop_preferences.menu_bar_status_enabled = v;
                }
                if let Some(v) = patch["floatingWidgetEnabled"].as_bool() {
                    config.desktop_preferences.floating_widget_enabled = v;
                }
            }
            store(&app)?;
            let enabled = shell
                .config
                .lock()
                .unwrap()
                .desktop_preferences
                .floating_widget_enabled;
            desktop_ui::floating(&app, enabled)?;
            desktop_ui::publish(&app);
            Ok(Value::Null)
        }
        "focusNext" => {
            desktop_ui::next(&app, args["scope"].as_str().unwrap_or("attention"))?;
            Ok(Value::Null)
        }
        "floatingSize" => {
            if window.label() != "floating" {
                return Err("Only the floating panel may resize itself".into());
            }
            let count = args["count"].as_u64().unwrap_or(1).clamp(1, 3);
            window
                .set_size(tauri::LogicalSize::new(
                    [64., 108., 152.][count as usize - 1],
                    40.,
                ))
                .map_err(|e| e.to_string())?;
            if let (Ok(point), Ok(scale)) = (window.outer_position(), window.scale_factor()) {
                let point: tauri::LogicalPosition<f64> = point.to_logical(scale);
                if let Some(p) = desktop_ui::constrain_floating(
                    &app,
                    Some(crate::config::Point {
                        x: point.x,
                        y: point.y,
                    }),
                    [64., 108., 152.][count as usize - 1],
                ) {
                    crate::window_chrome::invalidate(&window,false);
                    window
                        .set_position(tauri::LogicalPosition::new(p.x, p.y))
                        .map_err(|e| e.to_string())?;
                }
            }
            Ok(Value::Null)
        }
        "dragWindow" => {
            let current_epoch = current_document_epoch(&window);
            if !drag_epoch_matches(current_epoch.as_deref(), args["documentEpoch"].as_str()) {
                return Err("Window drag request belongs to a stale or unbound page".into());
            }
            let stamp=crate::window_chrome::drag_start(&window,&args);
            let result=window.start_dragging();
            crate::window_chrome::drag_end(&window,stamp,result.is_ok());
            result.map_err(|e| e.to_string())?;
            Ok(Value::Null)
        }
        "notificationSettings" => {
            open::that("x-apple.systempreferences:com.apple.Notifications-Settings.extension?bundleId=com.jovines.termdock.preview").map_err(|e|e.to_string())?;
            Ok(Value::Null)
        }
        "notificationTest" => {
            window.minimize().map_err(|e| e.to_string())?;
            Ok(Value::Null)
        }
        "notification" => show_notification(&app, &window, &args["payload"]).await,
        "notificationReceipts" => Ok(json!(shell.notification_receipts.lock().unwrap().clone())),
        "focusReceipt" => {
            let request = text(&args, "requestId")?;
            let mut windows = shell.windows.lock().unwrap();
            let service = windows
                .get_mut(window.label())
                .ok_or("Unknown focus window")?;
            if service
                .pending_focus
                .as_ref()
                .is_some_and(|(id, _)| id == request)
            {
                service.pending_focus = None;
            }
            Ok(Value::Null)
        }
        "updateState" => Ok(app.state::<crate::updater::Updater>().snapshot()),
        "checkUpdate" => Ok(app.state::<crate::updater::Updater>().check(&app).await),
        "installUpdate" => Ok(app.state::<crate::updater::Updater>().install(&app).await),
        "dropFiles" => {
            let token = text(&args, "token")?;
            let current_target = shell.windows.lock().unwrap().get(window.label())
                .and_then(|service| service.connection.target_peer_id.clone());
            let current_epoch = shell.file_epochs.lock().unwrap().get(window.label()).cloned();
            let drop = {
                let mut drops = shell.drops.lock().unwrap();
                let expected_view = args["viewId"].as_str();
                let expected_target = args["targetPeerId"].as_str();
                let valid = drops.get(token).is_some_and(|drop| {
                    drop.matches(window.label(), Instant::now(), expected_view, expected_target, current_epoch.as_deref())
                        && drop.target.as_deref().is_none_or(|target| Some(target.to_owned()) == current_target)
                });
                if !valid {
                    return Err("File drop capability expired or belongs to another window".into());
                }
                drops.remove(token).unwrap()
            };
            let pinned = shell
                .windows
                .lock()
                .unwrap()
                .get(window.label())
                .and_then(|w| w.connection.target_peer_id.clone());
            let local = local_files::verified_local(
                &local_service::home()?,
                pinned.as_deref(),
                args["targetPeerId"].as_str(),
            );
            let _limits = file_limits(&app).await?;
            prepare_files(
                &app,
                file_owner_at_start.clone().unwrap(),
                drop.paths
                    .into_iter()
                    .map(local_files::Input::selected)
                    .collect(),
                local,
                None,
            )
            .await
        }
        "collaborationFocus" => {
            let Some((origin, session)) = crate::collaboration_focus::address(text(&args, "id")?) else {
                return Ok(json!(false));
            };
            let open = shell.windows.lock().unwrap().iter()
                .map(|(label, service)| (label.clone(), service.connection.clone())).collect::<Vec<_>>();
            let peer=args["targetPeerId"].as_str();
            if peer.is_some_and(|value|value.is_empty()||value.len()>256){return Err("Invalid focus target identity".into());}
            let label = if let Some(peer)=peer {
                crate::collaboration_focus::peer_window(peer,&open)
            }else{crate::collaboration_focus::window(&origin, &open, &shell.config.lock().unwrap().connections)};
            let Some(target) = label.and_then(|label| app.get_webview_window(&label)) else {
                return Ok(json!(false));
            };
            {
                let mut windows = shell.windows.lock().unwrap();
                let Some(service) = windows.get_mut(target.label()) else { return Ok(json!(false)); };
                service.pending_focus = Some((uuid::Uuid::new_v4().to_string(), session));
            }
            deliver_pending_focus(&app, &target);
            desktop_ui::focus(&target)?;
            Ok(json!(true))
        }
        "connections" => Ok(json!(crate::config::service_connections(&shell.config.lock().unwrap().connections))),
        "saveConnection" | "importConnection" => {
            let connection = parse_connection(&args)?;
            {
                let mut config = shell.config.lock().unwrap();
                if connection_conflict(&config, &connection) {
                    return Err("Pinned service identity changed".into());
                }
                config.save_connection(connection.clone(), op == "saveConnection");
            }
            let _pairing=update_unpaired_window(&shell.windows,&shell.config,window.label(),&connection);
            store(&app)?;
            Ok(json!(crate::config::service_connections(&shell.config.lock().unwrap().connections)))
        }
        "removeConnection" => {
            let id = text(&args, "id")?;
            let removed = {
                let mut config = shell.config.lock().unwrap();
                let removed = config.connections.iter().find(|c| c.id == id).cloned();
                if let Some(c) = &removed {
                    config.removed_keys.push(c.key());
                }
                config.connections.retain(|c| c.id != id);
                removed
            };
            if let Some(c) = removed {
                if let Some(w) = app.get_webview_window(&c.window_label()) {
                    let _ = w.close();
                }
            }
            store(&app)?;
            Ok(json!(crate::config::service_connections(&shell.config.lock().unwrap().connections)))
        }
        "openConnection" => {
            let connection = parse_connection(&args)?;
            let invitation = args
                .get("invitation")
                .and_then(Value::as_str)
                .map(str::to_owned);
            open_connection(&app, connection, invitation).await
        }
        "openLocal" => connect_local(&app).await,
        "certificatePins" => {
            certificate_center_epoch(&app, &window)?;
            Ok(json!(shell.config.lock().unwrap().certificate_pins))
        }
        "inspectCertificate" => {
            let epoch = certificate_center_epoch(&app, &window)?;
            let origin = origin(text(&args, "origin")?)?;
            if !origin.starts_with("https:") { return Err("Certificate inspection requires an exact HTTPS address".into()); }
            let fingerprint = tls::inspect_https_certificate(&origin).await?;
            if certificate_center_epoch(&app, &window)? != epoch { return Err("Connection center changed during certificate inspection".into()); }
            let trusted = shell.config.lock().unwrap().certificate_pins.get(&origin).cloned();
            let receipt = uuid::Uuid::new_v4().to_string();
            shell.certificate_receipts.issue(receipt.clone(), CertificateReceipt { window:window.label().into(), epoch, origin:origin.clone(), fingerprint:fingerprint.clone(), expires:Instant::now()+Duration::from_secs(120), inflight:false, cancelled:false });
            Ok(json!({"origin":origin,"fingerprint":fingerprint,"trustedFingerprint":trusted,"receipt":receipt}))
        }
        "discardCertificateInspection" => {
            let epoch = certificate_center_epoch(&app, &window)?;
            let receipt = text(&args, "receipt")?;
            shell.certificate_receipts.discard(receipt,window.label(),&epoch);
            Ok(Value::Null)
        }
        "trustCertificate" | "revokeCertificate" => {
            let epoch = certificate_center_epoch(&app, &window)?;
            let origin = origin(text(&args, "origin")?)?;
            if !origin.starts_with("https:") {
                return Err("Certificate trust requires an exact HTTPS address".into());
            }
            if op == "trustCertificate" {
                let fingerprint = tls::normalize_pin(text(&args, "fingerprint")?)?;
                let receipt_id = text(&args, "receipt")?;
                let receipt = shell.certificate_receipts.claim(receipt_id,window.label(),&epoch,&origin,&fingerprint)?;
                let current = match tls::inspect_https_certificate(&origin).await {
                    Ok(value)=>value,
                    Err(error)=>{shell.certificate_receipts.finish(receipt_id,true);return Err(error);}
                };
                if current != receipt.fingerprint {
                    shell.certificate_receipts.finish(receipt_id,true);
                    return Err("PREVIEW_CERTIFICATE_CHANGED: Certificate changed after inspection; review the new fingerprint before trusting it".into());
                }
                // Check the Tauri caller after network I/O, then linearize discard
                // against persistence by holding the receipt lock through commit.
                if let Err(error)=certificate_center_epoch(&app,&window) {
                    shell.certificate_receipts.finish(receipt_id,true);return Err(error);
                }
                shell.certificate_receipts.commit(receipt_id, &receipt, || {
                    let mut config = shell.config.lock().unwrap();
                    let epochs = shell.file_epochs.lock().unwrap();
                    if epochs.get(window.label()).map(String::as_str) != Some(receipt.epoch.as_str()) {
                        return Err("Connection center changed before certificate trust was saved".into());
                    }
                    let mut next = config.clone();
                    next.certificate_pins.insert(origin.clone(), fingerprint);
                    next.persist(&shell.file)?;
                    *config = next;
                    Ok(())
                })?;
            } else {
                let mut config = shell.config.lock().unwrap();
                let epochs = shell.file_epochs.lock().unwrap();
                if epochs.get(window.label()) != Some(&epoch) { return Err("Connection center changed before revoking certificate trust".into()); }
                let mut next = config.clone();
                next.certificate_pins.remove(&origin);
                next.persist(&shell.file)?;
                *config = next;
            }
            let close: Vec<_> = shell
                .windows
                .lock()
                .unwrap()
                .iter()
                .filter(|(_, w)| w.connection.origins().contains(&origin))
                .map(|(label, _)| label.clone())
                .collect();
            for label in close {
                if let Some(w) = app.get_webview_window(&label) {
                    let _ = w.close();
                }
            }
            Ok(Value::Null)
        }
        "clipboardWriteText" => {
            if !window.is_focused().unwrap_or(false){return Err("Copy requires the focused workspace".into());}
            let value=text(&args,"text")?.to_owned();
            if value.is_empty()||value.len()>262144{return Err("Invalid clipboard text".into());}
            tauri::async_runtime::spawn_blocking(move ||arboard::Clipboard::new().map_err(|e|e.to_string())?.set_text(value).map_err(|e|e.to_string())).await.map_err(|e|e.to_string())??;
            Ok(Value::Null)
        }
        "showCenter" => { show_center(&app)?; Ok(Value::Null) }
        "revealConfig" => {
            open::that(local_service::home()?.join(".termdock")).map_err(|e| e.to_string())?;
            Ok(Value::Null)
        }
        "openExternal" => {
            let url = url::Url::parse(text(&args, "url")?).map_err(|_| "Invalid external link")?;
            if !["http", "https", "mailto"].contains(&url.scheme())
                || !url.username().is_empty()
                || url.password().is_some()
            {
                return Err("Unsupported external link".into());
            }
            open::that(url.as_str()).map_err(|e| e.to_string())?;
            Ok(Value::Null)
        }
        "deviceInfo" => Ok(
            json!({"system":std::env::consts::OS,"client":"Termdock Preview","arch":std::env::consts::ARCH,"mode":"desktop"}),
        ),
        "clipboardImage" => {
            let _limits = file_limits(&app).await?;
            clipboard_files(&app, file_owner_at_start.clone().unwrap(), false, true).await
        }
        "downloadStart" => {
            if center {
                return Err("Downloads require an active service page".into());
            }
            file_args(&args, &["name", "size"])?;
            let name = text(&args, "name")?;
            if name.is_empty()
                || name.len() > 255
                || name == "."
                || name == ".."
                || name.contains('/')
                || name.contains('\\')
                || name.chars().any(char::is_control)
            {
                return Err("Invalid suggested download name".into());
            }
            let size = download_save::expected_size(&args["size"])?;
            let owner = file_owner_at_start.clone().unwrap();
            let _request = Arc::clone(&shell.file_requests)
                .try_acquire_owned()
                .map_err(|_| "Preview file operations are busy")?;
            let selected = rfd::AsyncFileDialog::new()
                .set_file_name(name)
                .save_file()
                .await;
            let Some(selected) = selected else {
                return Ok(json!({"status":"canceled"}));
            };
            if file_owner(&app, &window)? != owner {
                return Err("Download target changed".into());
            }
            shell
                .downloads
                .lock()
                .unwrap()
                .begin(owner, selected.path().to_owned(), size)
        }
        "downloadChunk" => {
            file_args(&args, &["batch", "seq", "receipt", "base64"])?;
            let token = text(&args, "batch")?;
            uuid::Uuid::parse_str(token).map_err(|_| "Invalid native save capability")?;
            let seq = args["seq"].as_u64().ok_or("Invalid native save sequence")?;
            let receipt = text(&args, "receipt")?;
            uuid::Uuid::parse_str(receipt).map_err(|_| "Invalid native save receipt")?;
            let encoded = text(&args, "base64")?;
            if encoded.len() > 4 * local_files::CHUNK_BYTES.div_ceil(3) {
                return Err("Native save chunk exceeds limit".into());
            }
            let bytes = base64::Engine::decode(&base64::engine::general_purpose::STANDARD, encoded)
                .map_err(|_| "Invalid native save chunk")?;
            if bytes.is_empty() || bytes.len() > local_files::CHUNK_BYTES {
                return Err("Invalid native save chunk size".into());
            }
            let _io = Arc::clone(&shell.file_io)
                .acquire_owned()
                .await
                .map_err(|_| "Preview file writer closed")?;
            let owner = file_owner(&app, &window)?;
            shell
                .downloads
                .lock()
                .unwrap()
                .chunk(&owner, token, seq, receipt, &bytes)
        }
        "downloadFinish" => {
            file_args(&args, &["batch", "seq", "receipt", "written"])?;
            let token = text(&args, "batch")?;
            uuid::Uuid::parse_str(token).map_err(|_| "Invalid native save capability")?;
            let seq = args["seq"].as_u64().ok_or("Invalid native save sequence")?;
            let receipt = text(&args, "receipt")?;
            uuid::Uuid::parse_str(receipt).map_err(|_| "Invalid native save receipt")?;
            let _io = Arc::clone(&shell.file_io)
                .acquire_owned()
                .await
                .map_err(|_| "Preview file writer closed")?;
            let owner = file_owner(&app, &window)?;
            shell
                .downloads
                .lock()
                .unwrap()
                .finish(&owner, token, seq, receipt,args["written"].as_u64().ok_or("Invalid native save byte count")?)?;
            Ok(json!({"status":"saved"}))
        }
        "downloadCancel" => {
            file_args(&args, &["batch"])?;
            let token = text(&args, "batch")?;
            uuid::Uuid::parse_str(token).map_err(|_| "Invalid native save capability")?;
            shell
                .downloads
                .lock()
                .unwrap()
                .cancel(window.label(), token)?;
            Ok(json!({"status":"canceled"}))
        }
        "fileChunk" => {
            file_args(&args, &["batch", "index", "seq", "receipt"])?;
            let token = text(&args, "batch")?;
            uuid::Uuid::parse_str(token).map_err(|_| "Invalid file read capability")?;
            let token = token.to_owned();
            let index = args["index"]
                .as_u64()
                .filter(|v| *v < local_files::MAX_FILES as u64)
                .ok_or("Invalid file index")? as usize;
            let seq = args["seq"]
                .as_u64()
                .filter(|v| *v < 1024)
                .ok_or("Invalid file sequence")?;
            let receipt = match &args["receipt"] {
                Value::Null => None,
                Value::String(value) if uuid::Uuid::parse_str(value).is_ok() => Some(value.clone()),
                _ => return Err("Invalid file read receipt".into()),
            };
            let _limits = file_limits(&app).await?;
            let owner = file_owner(&app, &window)?;
            let files = Arc::clone(&shell.files);
            let read_owner = owner.clone();
            let read_token = token.clone();
            let chunk = tauri::async_runtime::spawn_blocking(move || {
                files.lock().unwrap().chunk(
                    &read_owner,
                    &read_token,
                    index,
                    seq,
                    receipt.as_deref(),
                )
            })
            .await
            .map_err(|e| e.to_string())??;
            if file_owner(&app, &window).as_ref() != Ok(&owner) {
                let _ = shell.files.lock().unwrap().release(&owner, &token);
                return Err("File read window/target changed".into());
            }
            Ok(chunk)
        }
        "releaseFiles" => {
            file_args(&args, &["batch"])?;
            let token = text(&args, "batch")?;
            uuid::Uuid::parse_str(token).map_err(|_| "Invalid file read capability")?;
            let token = token.to_owned();
            let owner = file_owner_at_start.clone().unwrap();
            let _limits = file_limits(&app).await?;
            let files = Arc::clone(&shell.files);
            tauri::async_runtime::spawn_blocking(move || {
                files.lock().unwrap().release(&owner, &token)
            })
            .await
            .map_err(|e| e.to_string())??;
            Ok(Value::Null)
        }
        "clipboardFiles" => {
            let pinned = shell
                .windows
                .lock()
                .unwrap()
                .get(window.label())
                .and_then(|w| w.connection.target_peer_id.clone());
            let local = local_files::verified_local(
                &local_service::home()?,
                pinned.as_deref(),
                args["options"]["localServiceId"].as_str(),
            );
            let _limits = file_limits(&app).await?;
            clipboard_files(&app, file_owner_at_start.clone().unwrap(), local, false).await
        }
        "chooseFiles" => {
            let _request = Arc::clone(&shell.file_requests)
                .try_acquire_owned()
                .map_err(|_| {
                    "Preview file selectors are busy; retry after the current selection"
                })?;
            let paths: Vec<PathBuf> = rfd::AsyncFileDialog::new()
                .pick_files()
                .await
                .unwrap_or_default()
                .into_iter()
                .map(|f| f.path().to_owned())
                .collect();
            let _io = Arc::clone(&shell.file_io)
                .acquire_owned()
                .await
                .map_err(|_| "Preview file reader closed")?;
            prepare_files(
                &app,
                file_owner_at_start.clone().unwrap(),
                paths
                    .into_iter()
                    .map(local_files::Input::selected)
                    .collect(),
                false,
                None,
            )
            .await
        }
        "reportActivity" => {
            let activity = args.get("activity").ok_or("Missing activity")?;
            let counts = |field| {
                activity
                    .get(field)
                    .and_then(Value::as_u64)
                    .unwrap_or(0)
                    .min(1_000_000)
            };
            if let Some(service) = shell.windows.lock().unwrap().get_mut(window.label()) {
                service.activity = json!({"runningCount":counts("runningCount"),"reviewCount":counts("reviewCount")});
            }
            desktop_ui::publish(&app);
            Ok(Value::Null)
        }
        "focusService" => {
            let origin = origin(text(&args, "origin")?)?;
            let label = shell
                .windows
                .lock()
                .unwrap()
                .iter()
                .find(|(_, w)| {
                    w.connection
                        .service_origin
                        .as_ref()
                        .unwrap_or(&w.connection.url)
                        == &origin
                })
                .map(|(label, _)| label.clone());
            if let Some(w) = label.and_then(|label| app.get_webview_window(&label)) {
                w.show().map_err(|e| e.to_string())?;
                w.set_focus().map_err(|e| e.to_string())?;
                Ok(json!(true))
            } else {
                Ok(json!(false))
            }
        }
        _ => Err("Unsupported Preview capability".into()),
    }
}
fn file_args(args: &Value, keys: &[&str]) -> Result<(), String> {
    let object = args.as_object().ok_or("Invalid file read request")?;
    if object.keys().any(|key| !keys.contains(&key.as_str())) {
        return Err("Unexpected file read field".into());
    }
    Ok(())
}
fn file_owner(app: &AppHandle, window: &WebviewWindow) -> Result<local_files::Owner, String> {
    let shell = state(app);
    let target = if window.label() == "center" {
        "center".to_owned()
    } else {
        let windows = shell.windows.lock().unwrap();
        let service = windows
            .get(window.label())
            .ok_or("Unknown file read window")?;
        format!(
            "{}\0{}\0{}",
            service.proxy.origin,
            service.connection.key(),
            service.connection.target_peer_id.as_deref().unwrap_or("")
        )
    };
    let epoch = shell
        .file_epochs
        .lock()
        .unwrap()
        .get(window.label())
        .cloned()
        .ok_or("File read window is not ready")?;
    Ok(local_files::Owner {
        window: window.label().into(),
        target: format!("{epoch}\0{target}"),
    })
}
async fn file_limits(
    app: &AppHandle,
) -> Result<
    (
        tokio::sync::OwnedSemaphorePermit,
        tokio::sync::OwnedSemaphorePermit,
    ),
    String,
> {
    let shell = state(app);
    // Only eight admitted requests can wait, and one native reader/collector
    // can allocate or block on disk. Waiting requests allocate no byte buffers.
    let request = Arc::clone(&shell.file_requests)
        .try_acquire_owned()
        .map_err(|_| "Preview file reads are busy; retry after the current read")?;
    let io = Arc::clone(&shell.file_io)
        .acquire_owned()
        .await
        .map_err(|_| "Preview file reader closed")?;
    Ok((request, io))
}
async fn prepare_files(
    app: &AppHandle,
    owner: local_files::Owner,
    inputs: Vec<local_files::Input>,
    local: bool,
    temporary: Option<tempfile::TempDir>,
) -> Result<Value, String> {
    let window = app
        .get_webview_window(&owner.window)
        .ok_or("File read window closed")?;
    if file_owner(app, &window)? != owner {
        return Err("File read window/target changed".into());
    }
    if local && !still_local(app, &owner)? {
        return Err("Local service identity changed; read the files again".into());
    }
    let files = Arc::clone(&state(app).files);
    let read_owner = owner.clone();
    let selected = tauri::async_runtime::spawn_blocking(move || {
        files
            .lock()
            .unwrap()
            .prepare(read_owner, inputs, local, temporary)
    })
    .await
    .map_err(|e| e.to_string())??;
    if file_owner(app, &window).as_ref() != Ok(&owner)
        || (local && !still_local(app, &owner).unwrap_or(false))
    {
        if let Some(token) = selected["batch"].as_str() {
            let _ = state(app).files.lock().unwrap().release(&owner, token);
        }
        return Err("File read window/target changed".into());
    }
    Ok(selected)
}
fn still_local(app: &AppHandle, owner: &local_files::Owner) -> Result<bool, String> {
    let pinned = state(app)
        .windows
        .lock()
        .unwrap()
        .get(&owner.window)
        .and_then(|w| w.connection.target_peer_id.clone());
    Ok(local_files::verified_local(
        &local_service::home()?,
        pinned.as_deref(),
        pinned.as_deref(),
    ))
}
async fn clipboard_files(
    app: &AppHandle,
    owner: local_files::Owner,
    local: bool,
    image: bool,
) -> Result<Value, String> {
    let parent = app.clone();
    let bound = owner.clone();
    let contents = native_desktop::clipboard(app, image, move || {
        parent
            .get_webview_window(&bound.window)
            .is_some_and(|window| file_owner(&parent, &window).as_ref() == Ok(&bound))
    })
    .await
    .map_err(|error| {
        if image {
            error
        } else {
            format!("TERMDOCK_CLIPBOARD_VIDEO_ERROR:{error}")
        }
    })?;
    if let Some(error) = contents.value["error"].as_str() {
        return Err(error.into());
    }
    let mut inputs = Vec::new();
    let rows = contents.value["files"]
        .as_array()
        .ok_or("Invalid native clipboard response")?;
    if rows.len() > local_files::MAX_FILES {
        return Err("Choose up to 50 clipboard files".into());
    }
    for file in rows {
        if let Some(path) = file["path"].as_str() {
            let mut input = local_files::Input::selected(PathBuf::from(path));
            input.mime = file["type"].as_str().map(str::to_owned);
            inputs.push(input);
        } else if let Some(path) = file["temporary"].as_str() {
            let path = PathBuf::from(path)
                .canonicalize()
                .map_err(|e| e.to_string())?;
            if path.parent()
                != Some(
                    contents
                        .directory
                        .path()
                        .canonicalize()
                        .map_err(|e| e.to_string())?
                        .as_path(),
                )
            {
                return Err("Native clipboard file escaped its private directory".into());
            }
            inputs.push(local_files::Input {
                path,
                name: file["name"].as_str().map(str::to_owned),
                mime: file["type"].as_str().map(str::to_owned),
                reusable: false,
            });
        } else {
            return Err("Invalid native clipboard file".into());
        }
    }
    let result = prepare_files(app, owner, inputs, local, Some(contents.directory)).await;
    if contents.value["hasMovie"] == true {
        result.map_err(|error| format!("TERMDOCK_CLIPBOARD_VIDEO_ERROR:{error}"))
    } else {
        result
    }
}
#[cfg(target_os = "macos")]
async fn titlebar_double_click(window: &WebviewWindow, args: Value, restore_epoch: Option<String>) -> Result<Value, String> {
    let restore = args.get("restore").and_then(Value::as_bool).unwrap_or(false);
    let setting=std::process::Command::new("/usr/bin/defaults").args(["read","-g","AppleActionOnDoubleClick"]).output().ok()
        .filter(|output|output.status.success()).and_then(|output|String::from_utf8(output.stdout).ok())
        .map(|value|value.trim().to_owned());
    let (action,preference_known)=crate::window_chrome::titlebar_double_click_preference(setting.as_deref());
    let (send, receive) = tokio::sync::oneshot::channel();
    let caller=window.clone();
    window.with_webview(move |webview| unsafe {
        if let Some(epoch)=restore_epoch.as_deref(){
            if crate::shell::page_epoch(&caller).as_deref()!=Some(epoch)||!crate::window_diagnostics::titlebar_restore_owner_matches(&caller,epoch){
                let _=send.send(Err("Titlebar restore owner or page epoch changed".to_owned()));return;
            }
        }
        let view=&*webview.inner().cast::<objc2::runtime::AnyObject>();
        let native_window:*mut objc2::runtime::AnyObject=objc2::msg_send![view, window];
        if native_window.is_null(){let _=send.send(Err("WKWebView has no native window".to_owned()));return;}
        let snapshot=|window:*mut objc2::runtime::AnyObject| {
            let frame:objc2_foundation::NSRect=objc2::msg_send![window, frame];
            let is_zoomed:bool=objc2::msg_send![window, isZoomed];
            let is_miniaturized:bool=objc2::msg_send![window, isMiniaturized];
            json!({"frame":{"x":frame.origin.x,"y":frame.origin.y,"width":frame.size.width,"height":frame.size.height},"isZoomed":is_zoomed,"isMiniaturized":is_miniaturized})
        };
        let before=snapshot(native_window);
        if restore {
            let is_minimized=before["isMiniaturized"].as_bool().unwrap_or(false);
            if action!=crate::window_chrome::TitlebarDoubleClickAction::Minimize||!is_minimized{
                let _=send.send(Err("Owned titlebar window is not in a restorable Minimize state".to_owned()));return;
            }
            let _:()=objc2::msg_send![native_window, deminiaturize: std::ptr::null_mut::<objc2::runtime::AnyObject>()];
        } else if preference_known { match action{
            crate::window_chrome::TitlebarDoubleClickAction::Zoom=>{let _:()=objc2::msg_send![native_window, performZoom: std::ptr::null_mut::<objc2::runtime::AnyObject>()];}
            crate::window_chrome::TitlebarDoubleClickAction::Minimize=>{let _:()=objc2::msg_send![native_window, performMiniaturize: std::ptr::null_mut::<objc2::runtime::AnyObject>()];}
            crate::window_chrome::TitlebarDoubleClickAction::None=>{}
        }}
        let after=snapshot(native_window);
        let action_name=if !preference_known{"unsupported"}else{match action{crate::window_chrome::TitlebarDoubleClickAction::Zoom=>"Zoom",crate::window_chrome::TitlebarDoubleClickAction::Minimize=>"Minimize",crate::window_chrome::TitlebarDoubleClickAction::None=>"None"}};
        let restored=restore&&before["isMiniaturized"]==true&&after["isMiniaturized"]==false;
        let _=send.send(Ok(json!({"action":action_name,"preferenceKnown":preference_known,"before":before,"after":after,"restored":restored})));
    }).map_err(|error|error.to_string())?;
    receive.await.map_err(|_|"Titlebar action receipt channel closed".to_owned())?
}

// App bootstrap embeds Info.plist; lib tests already embed it through updater fixtures.
#[cfg(not(test))]
pub fn run() {
    crate::window_diagnostics::initialize().expect("Invalid window diagnostic arguments");
    let mut context = tauri::generate_context!();
    if let Some(diagnostic) = crate::updater::prepare_startup(context.config_mut()) {
        eprintln!("Preview updater configuration: {diagnostic}");
    }
    tauri::Builder::default()
        .plugin(tauri_plugin_updater::Builder::new().build())
        .invoke_handler(tauri::generate_handler![preview_dispatch])
        .setup(|app| {
            let (file,config)=if let Some(isolated)=crate::window_diagnostics::configuration(){isolated}else{
                let file=app.path().app_config_dir()?.join("connections.json");
                let stable=PathBuf::from(std::env::var_os("HOME").ok_or("Missing home directory")?).join(".termdock/desktop.json");
                let config=Config::load(&file,&stable)?;(file,config)
            };
            config.persist(&file)?;
            let restore_connections=config.open_connections.iter()
                .filter_map(|id|config.connections.iter().find(|connection|&connection.id==id).cloned())
                .collect::<Vec<_>>();
            let restore_pending=!restore_connections.is_empty();
            let files = Arc::new(Mutex::new(local_files::Transfers::default()));
            let weak_files = Arc::downgrade(&files);
            let downloads = Arc::new(Mutex::new(download_save::DownloadWrites::default()));
            let weak_downloads = Arc::downgrade(&downloads);
            let file_epochs = Arc::new(Mutex::new(BTreeMap::<String, String>::new()));
            let weak_epochs = Arc::downgrade(&file_epochs);
            tauri::async_runtime::spawn(async move {
                let mut interval = tokio::time::interval(Duration::from_secs(5));
                loop {
                    interval.tick().await;
                    let Some(files) = weak_files.upgrade() else {
                        break;
                    };
                    let Some(epochs) = weak_epochs.upgrade() else {
                        break;
                    };
                    let epochs = epochs.lock().unwrap().clone();
                    if let Ok(mut files) = files.try_lock() {
                        files.purge();
                        files.retain_owners(|owner| {
                            epochs.get(&owner.window).is_some_and(|epoch| {
                                owner.target.starts_with(&format!("{epoch}\0"))
                            })
                        });
                    };
                    let Some(downloads) = weak_downloads.upgrade() else {
                        break;
                    };
                    if let Ok(mut downloads) = downloads.try_lock() {
                        downloads.retain_owners(|owner| {
                            epochs.get(&owner.window).is_some_and(|epoch| {
                                owner.target.starts_with(&format!("{epoch}\0"))
                            })
                        });
                    };
                }
            });
            app.manage(Shell {
                file,
                config: Mutex::new(config),
                windows: Mutex::new(BTreeMap::new()),
                openings: tokio::sync::Mutex::new(()),
                permissions: Mutex::new(Default::default()),
                last_focused: Mutex::new(None),
                tray: Mutex::new(None),
                zooms: Mutex::new(BTreeMap::new()),
                drops: Mutex::new(BTreeMap::new()),
                files,
                downloads,
                file_requests: Arc::new(tokio::sync::Semaphore::new(8)),
                file_io: Arc::new(tokio::sync::Semaphore::new(1)),
                file_epochs,
                certificate_receipts: CertificateReceipts::default(),
                quitting: AtomicBool::new(false),
                restoring: AtomicBool::new(restore_pending),
                setup_operation: tokio::sync::Mutex::new(()),
                notification_receipts: Mutex::new(vec![]),
                unread_notifications: Mutex::new(Default::default()),
            });
            app.add_capability(
                CapabilityBuilder::new("preview-center")
                    .webview("center")
                    .permission("allow-preview-dispatch"),
            )?;
            app.add_capability(
                CapabilityBuilder::new("preview-floating")
                    .webview("floating")
                    .permission("allow-preview-dispatch"),
            )?;
            app.manage(crate::updater::Updater::new(
                &app.package_info().version.to_string(),
            ));
            native_desktop::init(app.handle());
            desktop_ui::install_menu(app.handle())?;
            app.on_menu_event(|app, event| desktop_ui::menu_event(app, event.id().as_ref()));
            if !restore_pending||crate::window_diagnostics::chrome_enabled(){show_center(app.handle())?;}
            let preferences = state(app.handle())
                .config
                .lock()
                .unwrap()
                .desktop_preferences
                .clone();
            desktop_ui::floating(app.handle(), preferences.floating_widget_enabled)?;
            desktop_ui::publish(app.handle());
            let app = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                let mut restored=0;
                for connection in restore_connections {
                    match open_connection(&app, connection, crate::window_diagnostics::invitation()).await {
                        Ok(_)=>restored+=1,
                        Err(error)=>announce(&app, "termdock:preview-error", json!(error)),
                    }
                }
                state(&app).restoring.store(false,Ordering::SeqCst);
                if !crate::window_diagnostics::active()&&restored==0 {
                    let _=show_center(&app);
                }
                // Owned window inventory only; no addresses, bookmark identities
                // or page contents. Also verifies the actual startup policy.
                eprintln!("Termdock startup presentation: restored={} center={}",restored,app.get_webview_window("center").is_some());
                if crate::window_diagnostics::active(){return;}
                tokio::time::sleep(Duration::from_secs(15)).await;
                loop {
                    app.state::<crate::updater::Updater>().check(&app).await;
                    tokio::time::sleep(Duration::from_secs(6 * 60 * 60)).await;
                }
            });
            Ok(())
        })
        .build(context)
        .expect("Termdock Preview shell failed")
        .run(|app, event| match event {
            tauri::RunEvent::ExitRequested { code, api, .. } => {
                #[cfg(target_os = "macos")]
                if code.is_none() {
                    api.prevent_exit();
                    return;
                }
                let _ = api;
                let _ = code;
                state(app).quitting.store(true, Ordering::SeqCst);
            }
            #[cfg(target_os = "macos")]
            tauri::RunEvent::Reopen { .. } => {
                if let Some(w) = desktop_ui::focused(app) {
                    let _ = desktop_ui::focus(&w);
                } else if !state(app).restoring.load(Ordering::SeqCst) {
                    let _ = show_center(app);
                }
            }
            _ => {}
        });
}

pub(crate) fn local_bridge() -> &'static str {
    static SCRIPT: std::sync::OnceLock<String> = std::sync::OnceLock::new();
    SCRIPT.get_or_init(||format!("window.__TD_PREVIEW_BOOT__={{local:true,origin:location.origin,connection:{{}},version:{},platform:{},ownedWindowChrome:{}}};\n{}",json!(env!("CARGO_PKG_VERSION")),json!(if cfg!(target_os="macos"){"darwin"}else{std::env::consts::OS}),json!(crate::window_diagnostics::chrome_enabled()),include_str!("../../renderer/bridge.js")))
}
async fn snapshot(app: &AppHandle) -> Result<Value, String> {
    let shell = state(app);
    let config = shell.config.lock().unwrap().clone();
    let local = local_service::status(&config.certificate_pins).await;
    let mut connections = json!(crate::config::service_connections(&config.connections));
    if let Some(items) = connections.as_array_mut() {
        for c in items {
            let id = c["id"].as_str().unwrap_or("");
            let at = config.last_connected.get(id).copied();
            if let Some(at) = at {
                c["lastConnectedAt"] = json!(at);
            }
        }
    }
    Ok(
        json!({"appVersion":app.package_info().version.to_string(),"localService":local,"connections":connections,"lastConnectionUrl":config.last_connection_url,"desktopPreferences":config.desktop_preferences}),
    )
}
async fn connect_address(app: &AppHandle, address: &str) -> Result<Value, String> {
    let address = origin(address)?;
    let connection = state(app)
        .config
        .lock()
        .unwrap()
        .connections.clone();
    let connection = crate::config::connection_at(&connection, &address).cloned()
        .unwrap_or(Connection {
            id: address.clone(),
            url: address.clone(),
            label: crate::config::address_label(&address),
            target_peer_id: None,
            service_origin: None,
            entry_service_id: None,
            routes: vec![],
        });
    open_connection(app, connection, None).await
}
pub(crate) async fn connect_local(app: &AppHandle) -> Result<Value, String> {
    let Some(metadata) = local_service::metadata() else {
        show_center(app)?;
        return Err("尚未找到本机服务，请从连接中心准备环境".into());
    };
    connect_address(
        app,
        metadata["localUrl"]
            .as_str()
            .ok_or("Invalid local address")?,
    )
    .await
}
#[cfg(target_os = "macos")]
pub(crate) fn align_titlebar(window: &WebviewWindow, zoom: f64) {
    if !zoom.is_finite() || !(0.5..=3.).contains(&zoom) { return; }
    // Existing 46-CSS-pixel workspace chrome; no shared CSS/user setting change.
    let _ = window.with_webview(move |webview| unsafe {
        extern "C" { fn td_preview_align_titlebar(wk_view: *mut std::ffi::c_void, center: f64); }
        td_preview_align_titlebar(webview.inner().cast(), 23. * zoom);
    });
}
// A new window stays hidden until alignment is installed on its actual
// AppKit thread. Showing during build exposes the default button placement.
fn present_window(window:&WebviewWindow)->Result<(),String>{
    #[cfg(target_os="macos")]
    {
        let ready=window.clone();
        window.with_webview(move|webview|unsafe{
            extern "C" {fn td_preview_align_titlebar(wk_view:*mut std::ffi::c_void,center:f64);}
            td_preview_align_titlebar(webview.inner().cast(),23.);
            let _=ready.show();let _=ready.set_focus();
        }).map_err(|error|error.to_string())?;
    }
    #[cfg(not(target_os="macos"))]
    {window.show().map_err(|error|error.to_string())?;window.set_focus().map_err(|error|error.to_string())?;}
    Ok(())
}
fn observe_window(app: &AppHandle, window: &WebviewWindow, connection_id: Option<String>,chrome_instance:Option<u64>) {
    // Install owned diagnostic stamps before the existing alignment can queue.
    crate::window_chrome::created(window,chrome_instance);
    let app = app.clone();
    let label = window.label().to_owned();
    state(&app)
        .file_epochs
        .lock()
        .unwrap()
        .insert(label.clone(), uuid::Uuid::new_v4().to_string());
    window.on_window_event(move |event| {
        let shell = state(&app);
        match event {
            // Tauri's main WindowContent WebView synthesizes WINDOW drag events.
            tauri::WindowEvent::DragDrop(event) => handle_file_drag(&app, &label, event),
            tauri::WindowEvent::Focused(true) => {
                if connection_id.is_some() {
                    *shell.last_focused.lock().unwrap() = Some(label.clone());
                }
                shell.unread_notifications.lock().unwrap().clear();
                if let Some(w) = app.get_webview_window(&label) {
                    let _ = w.set_badge_count(None);
                }
                desktop_ui::publish(&app);
            }
            tauri::WindowEvent::Moved(_)
            | tauri::WindowEvent::Resized(_)
            | tauri::WindowEvent::ScaleFactorChanged { .. } => {
                if let Some(w) = app.get_webview_window(&label) {
                    if matches!(event,tauri::WindowEvent::Moved(_)){crate::window_chrome::moved(&w,chrome_instance);}else{crate::window_chrome::invalidate_instance(&w,false,chrome_instance);}
                    if let (Ok(position), Ok(size), Ok(scale)) =
                        (w.outer_position(), w.inner_size(), w.scale_factor())
                    {
                        let position: tauri::LogicalPosition<f64> = position.to_logical(scale);
                        let size: tauri::LogicalSize<f64> = size.to_logical(scale);
                        let key = shell
                            .windows
                            .lock()
                            .unwrap()
                            .get(&label)
                            .map(|s| s.connection.key())
                            .unwrap_or_else(|| label.clone());
                        let mut config = shell.config.lock().unwrap();
                        config.window_states.insert(
                            key,
                            crate::config::WindowState {
                                x: position.x,
                                y: position.y,
                                width: size.width,
                                height: size.height,
                                fullscreen: w.is_fullscreen().unwrap_or(false),
                            },
                        );
                        let _ = config.persist(&shell.file);
                    }
                    desktop_ui::emit(&w, "termdock:preview-layout", Value::Null);
                }
            }
            tauri::WindowEvent::CloseRequested { api, .. } => {
                #[cfg(target_os = "macos")]
                if label == "center" && !shell.quitting.load(Ordering::SeqCst) {
                    api.prevent_close();
                    if let Some(w) = app.get_webview_window(&label) {
                        let _ = w.hide();
                    }
                    return;
                }
                let _ = api;
                if !shell.quitting.load(Ordering::SeqCst) {
                    if let Some(id) = &connection_id {
                        let mut config = shell.config.lock().unwrap();
                        config.open_connections.retain(|c| c != id);
                        let _ = config.persist(&shell.file);
                    }
                }
            }
            tauri::WindowEvent::Destroyed => {
                crate::window_chrome::destroyed(&label,chrome_instance);
                shell.windows.lock().unwrap().remove(&label);
                shell.drops.lock().unwrap().retain(|_, d| d.owner != label);
                shell.file_epochs.lock().unwrap().remove(&label);
                if let Ok(mut files) = shell.files.try_lock() {
                    files.close_window(&label);
                }
                if let Ok(mut downloads) = shell.downloads.try_lock() {
                    downloads.close_window(&label);
                }
                {
                    let mut focused = shell.last_focused.lock().unwrap();
                    if focused.as_deref() == Some(&label) {
                        *focused = None;
                    }
                }
                desktop_ui::publish(&app);
            }
            _ => {}
        }
    });
    let app = window.app_handle().clone();
    let label = window.label().to_owned();
    window.on_webview_event(move |event| {
        if let tauri::WebviewEvent::DragDrop(event) = event { handle_file_drag(&app, &label, event); }
    });
}
fn handle_file_drag(app: &AppHandle, label: &str, event: &tauri::DragDropEvent) {
    let shell = state(app);
    let connection = shell.windows.lock().unwrap().get(label).map(|w| w.connection.clone());
    let Some(connection) = connection else { return; };
    let Some(window) = app.get_webview_window(label) else { return; };
    let zoom = shell.zooms.lock().unwrap().get(label).copied().unwrap_or(1.);
    match event {
        tauri::DragDropEvent::Enter { paths, position } => {
            let (x,y) = preview_drop_css_point(position.x as f64, position.y as f64, zoom);
            let local = local_service::home().ok().is_some_and(|home| local_files::verified_local(&home, connection.target_peer_id.as_deref(), connection.target_peer_id.as_deref()));
            desktop_ui::emit(&window,"termdock:preview-drag",json!({"phase":"enter","x":x,"y":y,"local":local,"count":paths.len()}));
        }
        tauri::DragDropEvent::Over { position } => {
            let (x,y) = preview_drop_css_point(position.x as f64, position.y as f64, zoom);
            desktop_ui::emit(&window,"termdock:preview-drag",json!({"phase":"over","x":x,"y":y}));
        }
        tauri::DragDropEvent::Leave => desktop_ui::emit(&window,"termdock:preview-drag",json!({"phase":"leave"})),
        tauri::DragDropEvent::Drop { paths, position } => {
            let shell = state(app);
            if !shell.windows.lock().unwrap().contains_key(label) {
                return;
            }
            let token = uuid::Uuid::new_v4().to_string();
            {
                let mut drops = shell.drops.lock().unwrap();
                drops.retain(|_, d| d.expires > Instant::now());
                if drops.len() >= 32 {
                    return;
                }
                drops.insert(
                    token.clone(),
                    NativeDrop {
                        owner: label.into(),
                        paths: paths.clone(),
                        expires: Instant::now() + Duration::from_secs(60),
                        view: None,
                        target: connection.target_peer_id.clone(),
                        epoch: shell.file_epochs.lock().unwrap().get(label).cloned(),
                    },
                );
            }
            if let Some(w) = app.get_webview_window(label) {
                let zoom = shell.zooms.lock().unwrap().get(label).copied().unwrap_or(1.);
                let (x, y) = preview_drop_css_point(position.x as f64, position.y as f64, zoom);
                desktop_ui::emit(
                    &w,
                    "termdock:preview-files",
                    json!({"token":token,"x":x,"y":y}),
                );
            }
        }
        _ => {}
    }
}

async fn show_notification(
    app: &AppHandle,
    window: &WebviewWindow,
    payload: &Value,
) -> Result<Value, String> {
    let title = payload["title"]
        .as_str()
        .ok_or("Missing notification title")?;
    if window.is_focused().unwrap_or(false) {
        return Ok(json!(true));
    }
    let connection = state(app)
        .windows
        .lock()
        .unwrap()
        .get(window.label())
        .map(|s| s.connection.clone());
    let tag = payload["tag"]
        .as_str()
        .filter(|s| !s.is_empty())
        .map(str::to_owned)
        .unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
    let identifier = hex::encode(Sha256::digest(
        format!(
            "{}:{tag}",
            connection
                .as_ref()
                .map(|c| c.key())
                .unwrap_or_else(|| window.label().into())
        )
        .as_bytes(),
    ));
    let mut native = json!({"identifier":identifier,"title":title.chars().take(160).collect::<String>(),"body":payload["body"].as_str().unwrap_or("").chars().take(1000).collect::<String>(),"silent":payload["silent"]==true,"sessionId":payload["sessionId"],"windowLabel":window.label(),"connection":connection});
    if native["sessionId"]
        .as_str()
        .is_some_and(|s| s.len() > 512 || s.chars().any(char::is_control))
    {
        native["sessionId"] = Value::Null;
    }
    let receipt = match native_desktop::show(app, native).await {
        Ok(v) => v,
        Err(error) => json!({"delivered":false,"error":error}),
    };
    {
        let shell = state(app);
        let mut receipts = shell.notification_receipts.lock().unwrap();
        if receipts.len() >= 100 {
            receipts.remove(0);
        }
        receipts.push(receipt.clone());
    }
    announce(
        app,
        "termdock:preview-notification-receipt",
        receipt.clone(),
    );
    if receipt["delivered"] == true {
        let shell = state(app);
        let count = {
            let mut unseen = shell.unread_notifications.lock().unwrap();
            unseen.insert(receipt["identifier"].as_str().unwrap_or("").to_owned());
            unseen.len()
        };
        let _ = window.set_badge_count(Some(count as i64));
        if payload["persistent"] == true {
            native_desktop::attention(app);
        }
    }
    Ok(json!(receipt["delivered"] == true))
}
fn deliver_pending_focus(app: &AppHandle, window: &WebviewWindow) {
    let value=state(app).windows.lock().unwrap().get(window.label()).and_then(|s|s.pending_focus.as_ref().map(|(request,session)|json!({"requestId":request,"sessionId":session,"targetPeerId":s.connection.target_peer_id})));
    if let Some(v) = value {
        desktop_ui::emit(window, "termdock:preview-focus-request", v);
    }
}
#[cfg(target_os = "macos")]
pub(crate) fn notification_clicked(app: &AppHandle, payload: Value) {
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        let label = payload["windowLabel"].as_str().unwrap_or("");
        let window = if let Some(w) = app.get_webview_window(label) {
            Some(w)
        } else if let Ok(c) = serde_json::from_value::<Connection>(payload["connection"].clone()) {
            let key = c.key();
            if open_connection(&app, c, None).await.is_err() {
                None
            } else {
                let label = state(&app)
                    .windows
                    .lock()
                    .unwrap()
                    .iter()
                    .find(|(_, w)| w.connection.key() == key)
                    .map(|(l, _)| l.clone());
                label.and_then(|l| app.get_webview_window(&l))
            }
        } else {
            None
        };
        if let Some(w) = window {
            if let Some(session) = payload["sessionId"].as_str() {
                if let Some(service) = state(&app).windows.lock().unwrap().get_mut(w.label()) {
                    service.pending_focus =
                        Some((uuid::Uuid::new_v4().to_string(), session.to_owned()));
                }
                deliver_pending_focus(&app, &w);
            }
            let _ = desktop_ui::focus(&w);
        }
    });
}

#[cfg(test)]
mod pairing_tests {
 use super::*;
 #[test]
 fn window_drag_requires_the_exact_current_page_epoch(){
  assert!(drag_epoch_matches(Some("page-a"),Some("page-a")));
  assert!(!drag_epoch_matches(Some("page-b"),Some("page-a")));
  assert!(!drag_epoch_matches(Some("page-a"),None));
  assert!(!drag_epoch_matches(None,Some("page-a")));
  assert!(!drag_epoch_matches(Some(""),Some("")));
 }
 fn certificate_fixture() -> (CertificateReceipts, CertificateReceipt) {
  let receipt=CertificateReceipt{window:"center".into(),epoch:"page-a".into(),origin:"https://owned.example".into(),fingerprint:"a".repeat(64),expires:Instant::now()+Duration::from_secs(120),inflight:false,cancelled:false};
  let receipts=CertificateReceipts::default();receipts.issue("owned".into(),receipt.clone());(receipts,receipt)
 }
 fn claim_certificate(receipts:&CertificateReceipts,r:&CertificateReceipt)->Result<CertificateReceipt,String>{receipts.claim("owned",&r.window,&r.epoch,&r.origin,&r.fingerprint)}
 #[test]
 fn certificate_cancel_during_tls_prevents_persistence_and_second_claim(){
  let (receipts,r)=certificate_fixture();let claimed=claim_certificate(&receipts,&r).unwrap();
  assert!(claim_certificate(&receipts,&r).is_err());
  receipts.discard("owned",&r.window,&r.epoch);
  let mut persisted=false;assert!(receipts.commit("owned",&claimed,||{persisted=true;Ok(())}).is_err());assert!(!persisted);
 }
 #[test]
 fn certificate_expiry_after_tls_prevents_persistence(){
  let (receipts,r)=certificate_fixture();let claimed=claim_certificate(&receipts,&r).unwrap();
  receipts.0.lock().unwrap().get_mut("owned").unwrap().expires=Instant::now()-Duration::from_secs(1);
  let mut persisted=false;assert!(receipts.commit("owned",&claimed,||{persisted=true;Ok(())}).is_err());assert!(!persisted);
 }
 #[test]
 fn certificate_wrong_page_window_origin_and_fingerprint_cannot_claim_or_cancel(){
  let(receipts,r)=certificate_fixture();
  for (w,e,o,f) in [("other",r.epoch.as_str(),r.origin.as_str(),r.fingerprint.as_str()),(r.window.as_str(),"old",r.origin.as_str(),r.fingerprint.as_str()),(r.window.as_str(),r.epoch.as_str(),"https://other.example",r.fingerprint.as_str()),(r.window.as_str(),r.epoch.as_str(),r.origin.as_str(),"wrong")] {assert!(receipts.claim("owned",w,e,o,f).is_err());assert!(receipts.0.lock().unwrap().contains_key("owned"));}
  // A same-window/page cancellation is authorized regardless of the supplied target.
  let(receipts,r)=certificate_fixture();receipts.discard("owned","other",&r.epoch);receipts.discard("owned",&r.window,"old");
  let claimed=claim_certificate(&receipts,&r).unwrap();let mut count=0;
  receipts.commit("owned",&claimed,||{count+=1;Ok(())}).unwrap();
  assert!(claim_certificate(&receipts,&r).is_err());assert_eq!(count,1);
 }
 #[test]
 fn certificate_failed_persistence_consumes_receipt_without_success(){
  let(receipts,r)=certificate_fixture();let claimed=claim_certificate(&receipts,&r).unwrap();
  assert_eq!(receipts.commit("owned",&claimed,||Err("owned disk error".into())).unwrap_err(),"owned disk error");
  assert!(claim_certificate(&receipts,&r).is_err());
 }

 #[test]
 fn native_drop_capability_is_bound_to_its_window_view_target_and_epoch(){
  let now=Instant::now();let drop=NativeDrop{owner:"window-a".into(),paths:vec![PathBuf::from("/tmp/a")],expires:now+Duration::from_secs(60),view:Some("view-a".into()),target:Some("peer-a".into()),epoch:Some("epoch-a".into())};
  assert!(drop.matches("window-a",now,Some("view-a"),Some("peer-a"),Some("epoch-a")));
  assert!(!drop.matches("window-b",now,Some("view-a"),Some("peer-a"),Some("epoch-a")));
  assert!(!drop.matches("window-a",now,Some("view-b"),Some("peer-a"),Some("epoch-a")));
  assert!(!drop.matches("window-a",now,Some("view-a"),Some("peer-b"),Some("epoch-a")));
  assert!(!drop.matches("window-a",now,Some("view-a"),Some("peer-a"),Some("epoch-b")));
  assert!(!drop.matches("window-a",now+Duration::from_secs(61),Some("view-a"),Some("peer-a"),Some("epoch-a")));
 }
 #[test]
 fn webview_drop_coordinates_keep_appkit_points_at_retina_and_apply_only_page_zoom(){
  assert_eq!(preview_drop_css_point(240.,120.,1.),(240.,120.));
  assert_eq!(preview_drop_css_point(240.,120.,2.),(120.,60.));
  assert_eq!(preview_drop_css_point(240.,120.,f64::NAN),(240.,120.));
 }
 #[tokio::test]
 async fn actual_unpaired_registry_update_releases_window_and_config_before_page_epoch_read(){
  let upstream=proxy::bind(None).await.unwrap();let address=upstream.local_addr().unwrap();
  let server=tokio::spawn(async move{axum::serve(upstream,axum::Router::new().route("/",axum::routing::get(||async{axum::response::Html("<html>Owned registry test</html>")}))).await.unwrap();});
  let old=Connection{id:"owned".into(),url:format!("http://{address}"),label:"Owned".into(),target_peer_id:None,service_origin:None,entry_service_id:None,routes:vec![]};
  let listener=proxy::bind(None).await.unwrap();let (proxy,_)=proxy::start(listener,&old,&BTreeMap::new()).await.unwrap();
  let windows=Mutex::new(BTreeMap::from([("owner".into(),ServiceWindow{connection:old.clone(),proxy,activity:Value::Null,pending_focus:None})]));
  let mut initial=Config::default();initial.ports.insert(old.key(),12345);initial.profile_keys.insert(old.key(),"controlled-profile".into());
  let config=Mutex::new(initial);let mut next=old.clone();next.target_peer_id=Some("controlled-peer".into());
  let (previous,current)=update_unpaired_window(&windows,&config,"owner",&next).unwrap();
  assert_eq!(previous,old);assert_eq!(current,next);
  // page_epoch and the diagnostic host_event reenter windows. They must be
  // able to acquire the actual registry mutex after this production operation.
  assert_eq!(windows.try_lock().unwrap().get("owner").unwrap().connection,next);
  assert_eq!(owned_gate_service_pin(&old,&old.url,"controlled-peer"),Ok(false));
  assert_eq!(owned_gate_service_pin(&windows.lock().unwrap().get("owner").unwrap().connection,&old.url,"controlled-peer"),Ok(true));
  assert!(owned_gate_service_pin(&next,&old.url,"different-peer").is_err());
  let saved=config.try_lock().unwrap();assert_eq!(saved.ports.get(&next.key()),Some(&12345));assert_eq!(saved.profile_keys.get(&next.key()).map(String::as_str),Some("controlled-profile"));drop(saved);
  assert!(update_unpaired_window(&windows,&config,"owner",&next).is_none());
  let mut other=next.clone();other.url="http://127.0.0.1:12346".into();assert!(update_unpaired_window(&windows,&config,"owner",&other).is_none());
  server.abort();
 }
}
