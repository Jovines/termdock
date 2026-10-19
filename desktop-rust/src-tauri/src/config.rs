use base64::Engine;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{collections::BTreeMap, fs, path::Path};
use url::Url;

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Route {
    pub url: String,
    pub target_peer_id: String,
}
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Connection {
    pub id: String,
    pub url: String,
    pub label: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub target_peer_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub service_origin: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub entry_service_id: Option<String>,
    #[serde(default)]
    pub routes: Vec<Route>,
}
pub fn origin(value: &str) -> Result<String, String> {
    let url = Url::parse(value).map_err(|_| "Invalid service address")?;
    if value.len() > 2048
        || !["http", "https"].contains(&url.scheme())
        || url.host_str().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
        || !["", "/"].contains(&url.path())
    {
        return Err("Use a service home address without credentials or invitation secrets".into());
    }
    Ok(url.origin().ascii_serialization())
}
pub fn address_label(value: &str) -> String {
    Url::parse(value).map(|url|url[url::Position::BeforeHost..url::Position::AfterPort].to_owned()).unwrap_or_else(|_|value.to_owned())
}
/// Resolve the same exact address as connect_local. Prefer an accepted pin over
/// a bootstrap alias only when that address has one unambiguous recorded peer.
pub fn connection_at<'a>(connections: &'a [Connection], address: &str) -> Option<&'a Connection> {
    let matching=connections.iter().filter(|c|c.url==address||c.service_origin.as_deref()==Some(address)).collect::<Vec<_>>();
    let pins=matching.iter().filter_map(|c|c.target_peer_id.as_deref()).collect::<std::collections::BTreeSet<_>>();
    if pins.len()==1 {matching.iter().find(|c|c.target_peer_id.is_some()).copied()} else {matching.first().copied()}
}
/// Fold only recorded identities and exact-address bootstrap aliases. This is
/// a view: profile keys, saved routes and window restoration IDs remain intact.
fn directory_groups(connections: &[Connection]) -> Vec<&Connection> {
    let mut groups: Vec<&Connection> = Vec::new();
    for c in connections {
        if c.target_peer_id.is_none() {
            let pins=connections.iter().filter(|other|other.url==c.url)
                .filter_map(|other|other.target_peer_id.as_deref()).collect::<std::collections::BTreeSet<_>>();
            if pins.len()==1 {continue;}
        }
        if groups.iter().any(|old| match (&old.target_peer_id,&c.target_peer_id) {
            (Some(a),Some(b)) => a==b,
            (None,None) => old.url==c.url && old.service_origin==c.service_origin,
            _ => false,
        }) {continue;}
        groups.push(c);
    }
    groups
}
pub fn service_connections(connections: &[Connection]) -> Vec<Connection> {
    directory_groups(connections).into_iter().cloned().collect()
}
/// URL-only legacy entries must reuse an unambiguous saved pin before opening.
/// Never infer that localhost/IPv4/IPv6, schemes or different ports are identical.
pub fn resolve_saved_connection(connections: &[Connection], connection: Connection) -> Connection {
    if connection.target_peer_id.is_some() {return connection;}
    let peers=connections.iter().filter(|c|c.url==connection.url)
        .filter_map(|c|c.target_peer_id.as_deref()).collect::<std::collections::BTreeSet<_>>();
    if peers.len()==1 {
        if let Some(saved)=connections.iter().find(|c|c.url==connection.url&&c.target_peer_id.is_some()) {return saved.clone();}
    }
    connection
}
#[derive(Clone, Debug, Serialize)]
pub struct ServiceMenuRow { pub id: String, pub label: String }
/// Presentation only. Never deletes bookmarks, routes, profiles or open windows.
pub fn service_menu_rows(connections: &[Connection], local_address: Option<&str>) -> Vec<ServiceMenuRow> {
    let groups=directory_groups(connections);
    let local_is_saved=local_address.and_then(|address|connection_at(connections,address)).is_some_and(|c|c.target_peer_id.is_some());
    let mut rows=Vec::new();
    if !local_is_saved {rows.push(ServiceMenuRow{id:"local-service".into(),label:"本机服务（快捷入口）".into()});}
    for c in &groups {
        let host=Url::parse(&c.url).ok().and_then(|u|u.host_str().map(str::to_owned));let address=address_label(&c.url);
        let mut label=if c.label.is_empty()||Some(c.label.as_str())==host.as_deref()||c.label==address {address.clone()}else{c.label.clone()};
        if groups.iter().any(|other|other.id!=c.id&&other.label==c.label) {
            let suffix=c.target_peer_id.as_deref().unwrap_or(&c.id);let tail=suffix.chars().rev().take(8).collect::<String>().chars().rev().collect::<String>();
            label=format!("{label} · {address} · {tail}");
        }
        rows.push(ServiceMenuRow{id:format!("open:{}",c.id),label});
    }
    rows
}
fn peer(value: &str) -> bool {
    value.len() == 52
        && value.starts_with("12D3KooW")
        && value
            .bytes()
            .all(|c| b"123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz".contains(&c))
}
impl Connection {
    pub fn validated(mut self) -> Result<Self, String> {
        self.url = origin(&self.url)?;
        self.service_origin = self.service_origin.map(|v| origin(&v)).transpose()?;
        if self.id.is_empty() || self.id.len() > 512 || self.id.chars().any(char::is_control) {
            return Err("Invalid connection ID".into());
        }
        self.label = self.label.trim().to_owned();
        if self.label.len() > 240 || self.label.chars().any(char::is_control) {
            return Err("Invalid connection name".into());
        }
        if self.label.is_empty() {
            self.label = Url::parse(&self.url)
                .unwrap()
                .host_str()
                .unwrap()
                .to_owned();
        }
        for id in self
            .target_peer_id
            .iter()
            .chain(self.entry_service_id.iter())
        {
            if !peer(id) {
                return Err("Invalid pinned service identity".into());
            }
        }
        if self.entry_service_id.is_some() && self.target_peer_id.is_none() {
            return Err("A relay requires the target identity".into());
        }
        if self.routes.len() > 4 {
            return Err("At most four routes are supported".into());
        }
        for route in &mut self.routes {
            route.url = origin(&route.url)?;
            if !peer(&route.target_peer_id) {
                return Err("Invalid route identity".into());
            }
        }
        Ok(self)
    }
    pub fn key(&self) -> String {
        self.target_peer_id.clone().unwrap_or_else(|| {
            self.service_origin
                .clone()
                .unwrap_or_else(|| self.url.clone())
        })
    }
    pub fn window_label(&self) -> String {
        format!(
            "service-{}",
            hex::encode(Sha256::digest(self.key().as_bytes()))[..24].to_owned()
        )
    }
    pub fn origins(&self) -> Vec<String> {
        let mut values = vec![self
            .service_origin
            .clone()
            .unwrap_or_else(|| self.url.clone())];
        values.push(self.url.clone());
        values.extend(self.routes.iter().map(|r| r.url.clone()));
        values.sort();
        values.dedup();
        values
    }
    pub fn validate_invitation(&self, value: &str) -> Result<(), String> {
        let url = Url::parse(value).map_err(|_| "Invalid invitation")?;
        if value.len() > 12000
            || url.origin().ascii_serialization() != self.url
            || url.path() != "/"
            || url.query().is_some()
            || !url.username().is_empty()
            || url.password().is_some()
            || !url
                .fragment()
                .is_some_and(|f| f.starts_with("termdock-invite="))
        {
            return Err("Invitation does not match this connection".into());
        }
        let encoded = url
            .fragment()
            .unwrap()
            .strip_prefix("termdock-invite=")
            .unwrap();
        let decoded = base64::engine::general_purpose::URL_SAFE_NO_PAD
            .decode(encoded)
            .map_err(|_| "Invalid invitation encoding")?;
        let data: serde_json::Value =
            serde_json::from_slice(&decoded).map_err(|_| "Invalid invitation descriptor")?;
        let valid_secret = |key: &str| {
            data.get(key).and_then(|v| v.as_str()).is_some_and(|s| {
                (32..=128).contains(&s.len())
                    && s.bytes()
                        .all(|c| c.is_ascii_alphanumeric() || c == b'_' || c == b'-')
            })
        };
        if data.get("v").and_then(|v| v.as_u64()) != Some(1)
            || data.get("serviceId").and_then(|v| v.as_str()) != self.target_peer_id.as_deref()
            || data.get("entryServiceId").and_then(|v| v.as_str())
                != self.entry_service_id.as_deref()
            || data.get("entryUrl").and_then(|v| v.as_str()) != Some(self.url.as_str())
            || data
                .get("serviceUrl")
                .and_then(|v| v.as_str())
                .map(origin)
                .transpose()?
                .as_deref()
                .unwrap_or(&self.url)
                != self.service_origin.as_deref().unwrap_or(&self.url)
            || if data.get("routeOnly").and_then(|v| v.as_bool()) == Some(true) {
                self.entry_service_id.is_none()
                    || data.get("code").is_some()
                    || !valid_secret("routeCode")
            } else {
                !valid_secret("code")
            }
        {
            return Err("Invitation identity does not match this service window".into());
        }
        // The page still verifies the Noise peer and pairing code. The secret
        // remains in memory and never enters the saved connection whitelist.
        Ok(())
    }
}
#[derive(Clone, Copy, Debug, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all="lowercase")]
pub enum TerminalEngine { #[default] Web, Native }
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Preferences {
    pub terminal_engine: TerminalEngine,
    pub menu_bar_status_enabled: bool,
    pub floating_widget_enabled: bool,
    pub floating_widget_position: Option<Point>,
}
impl Default for Preferences {
    fn default() -> Self {
        Self {
            terminal_engine: TerminalEngine::Web,
            menu_bar_status_enabled: true,
            floating_widget_enabled: false,
            floating_widget_position: None,
        }
    }
}
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Point {
    pub x: f64,
    pub y: f64,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct WindowState {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
    pub fullscreen: bool,
}
impl WindowState {
    pub fn constrained(&self, x: f64, y: f64, width: f64, height: f64) -> Self {
        let w = self.width.max(760.).min(width);
        let h = self.height.max(520.).min(height);
        Self {
            x: self.x.max(x).min(x + width - w),
            y: self.y.max(y).min(y + height - h),
            width: w,
            height: h,
            fullscreen: self.fullscreen,
        }
    }
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Config {
    pub version: u8,
    pub imported_bookmarks: bool,
    pub connections: Vec<Connection>,
    pub removed_keys: Vec<String>,
    pub ports: BTreeMap<String, u16>,
    pub certificate_pins: BTreeMap<String, String>,
    pub desktop_preferences: Preferences,
    pub last_connection_url: Option<String>,
    pub open_connections: Vec<String>,
    pub window_states: BTreeMap<String, WindowState>,
    pub last_connected: BTreeMap<String, u64>,
    pub profile_keys: BTreeMap<String, String>,
}
impl Default for Config {
    fn default() -> Self {
        Self {
            version: 1,
            imported_bookmarks: false,
            connections: vec![],
            removed_keys: vec![],
            ports: BTreeMap::new(),
            certificate_pins: BTreeMap::new(),
            desktop_preferences: Preferences::default(),
            last_connection_url: None,
            open_connections: vec![],
            window_states: BTreeMap::new(),
            last_connected: BTreeMap::new(),
            profile_keys: BTreeMap::new(),
        }
    }
}
impl Config {
    pub fn load(file: &Path, stable: &Path) -> Result<Self, String> {
        let mut config: Self = match fs::read(file) {
            Ok(bytes) => serde_json::from_slice(&bytes)
                .map_err(|_| "Preview configuration is invalid; file preserved")?,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Self::default(),
            Err(e) => return Err(e.to_string()),
        };
        config.connections = config
            .connections
            .into_iter()
            .map(Connection::validated)
            .collect::<Result<_, _>>()?;
        config.window_states.retain(|_, w| {
            [w.x, w.y, w.width, w.height].iter().all(|n| n.is_finite())
                && w.width > 0.
                && w.height > 0.
        });
        if config
            .desktop_preferences
            .floating_widget_position
            .as_ref()
            .is_some_and(|p| !p.x.is_finite() || !p.y.is_finite())
        {
            config.desktop_preferences.floating_widget_position = None;
        }
        if !config.imported_bookmarks {
            // Read only bookmarks, never auth, private keys, cookies or certificate trust.
            if let Ok(bytes) = fs::read(stable) {
                if let Ok(value) = serde_json::from_slice::<serde_json::Value>(&bytes) {
                    if let Some(items) = value.get("connections").and_then(|v| v.as_array()) {
                        for item in items.iter().take(256) {
                            if let Ok(connection) =
                                serde_json::from_value::<Connection>(item.clone())
                                    .and_then(|c| c.validated().map_err(serde::de::Error::custom))
                            {
                                if let Some(at) =
                                    item.get("lastConnectedAt").and_then(|v| v.as_u64())
                                {
                                    config.last_connected.insert(connection.id.clone(), at);
                                }
                                config.save_connection(connection, false);
                            }
                        }
                    }
                }
            }
            if let Ok(bytes) = fs::read(stable) {
                if let Ok(value) = serde_json::from_slice::<serde_json::Value>(&bytes) {
                    config.last_connection_url = value
                        .get("lastConnectionUrl")
                        .and_then(|v| v.as_str())
                        .and_then(|v| origin(v).ok());
                    if let Some(urls) = value.get("openConnectionUrls").and_then(|v| v.as_array()) {
                        config.open_connections = urls
                            .iter()
                            .filter_map(|v| v.as_str())
                            .filter_map(|v| origin(v).ok())
                            .filter_map(|url| {
                                config
                                    .connections
                                    .iter()
                                    .find(|c| {
                                        c.url == url || c.service_origin.as_ref() == Some(&url)
                                    })
                                    .map(|c| c.id.clone())
                            })
                            .collect();
                    }
                    if let Some(patch) = value.get("desktopPreferences") {
                        if let Some(v) = patch.get("menuBarStatusEnabled").and_then(|v| v.as_bool())
                        {
                            config.desktop_preferences.menu_bar_status_enabled = v;
                        }
                        if let Some(v) =
                            patch.get("floatingWidgetEnabled").and_then(|v| v.as_bool())
                        {
                            config.desktop_preferences.floating_widget_enabled = v;
                        }
                        if let Some(point) = patch
                            .get("floatingWidgetPosition")
                            .and_then(|v| serde_json::from_value::<Point>(v.clone()).ok())
                            .filter(|p| p.x.is_finite() && p.y.is_finite())
                        {
                            config.desktop_preferences.floating_widget_position = Some(point);
                        }
                    }
                }
            }
            config.imported_bookmarks = true;
        }
        Ok(config)
    }
    pub fn save_connection(&mut self, connection: Connection, explicit: bool) {
        let key = connection.key();
        if !explicit && self.removed_keys.contains(&key) {
            return;
        }
        if explicit {
            self.removed_keys.retain(|k| k != &key);
        }
        if let Some(old) = self.connections.iter_mut().find(|old| {
            old.key() == key
                || old.id == connection.id
                || old.url == connection.url
                    && (old.target_peer_id.is_none()
                        || old.target_peer_id == connection.target_peer_id)
        }) {
            // Legacy page saves retain the target/route identity.
            let mut merged = connection;
            merged.id = old.id.clone();
            if merged.target_peer_id.is_none() {
                merged.target_peer_id = old.target_peer_id.clone();
            }
            if merged.service_origin.is_none() {
                merged.service_origin = old.service_origin.clone();
            }
            if merged.entry_service_id.is_none() {
                merged.entry_service_id = old.entry_service_id.clone();
            }
            if merged.routes.is_empty() {
                merged.routes = old.routes.clone();
            }
            *old = merged;
        } else {
            self.connections.push(connection);
        }
    }
    pub fn persist(&self, file: &Path) -> Result<(), String> {
        let parent = file.parent().ok_or("Missing configuration directory")?;
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(parent, fs::Permissions::from_mode(0o700))
                .map_err(|e| e.to_string())?;
        }
        let temp = file.with_extension(format!("{}.tmp", uuid::Uuid::new_v4()));
        let mut options = fs::OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        use std::io::Write;
        let mut out = options.open(&temp).map_err(|e| e.to_string())?;
        out.write_all(&serde_json::to_vec_pretty(self).map_err(|e| e.to_string())?)
            .map_err(|e| e.to_string())?;
        out.sync_all().map_err(|e| e.to_string())?;
        fs::rename(temp, file).map_err(|e| e.to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn menu_connection(id:&str,url:&str,peer:Option<&str>,label:&str)->Connection {
        Connection{id:id.into(),url:url.into(),label:label.into(),target_peer_id:peer.map(str::to_owned),service_origin:None,entry_service_id:None,routes:vec![]}
    }
    #[test]
    fn service_menu_folds_only_recorded_peer_and_exact_bootstrap_alias_without_mutating_config() {
        let mut config=Config::default();
        config.connections=vec![menu_connection("bootstrap","http://127.0.0.1:9834",None,"127.0.0.1"),menu_connection("paired","http://127.0.0.1:9834",Some("peer-a"),"127.0.0.1:9834"),menu_connection("alias","https://host.test",Some("peer-a"),"Alias"),menu_connection("other-port","http://127.0.0.1:9881",Some("peer-b"),"127.0.0.1"),menu_connection("unproven","http://localhost:9834",None,"Unproven")];
        config.profile_keys.insert("bootstrap".into(),"existing-profile".into());config.open_connections.push("bootstrap".into());let before=serde_json::to_value(&config).unwrap();
        let rows=service_menu_rows(&config.connections,Some("http://127.0.0.1:9834"));
        assert_eq!(rows.len(),3);assert!(!rows.iter().any(|r|r.id=="local-service"||r.id=="open:alias"||r.id=="open:bootstrap"));
        assert!(rows.iter().any(|r|r.id=="open:paired"&&r.label.contains(":9834")));assert!(rows.iter().any(|r|r.id=="open:other-port"&&r.label.contains(":9881")));assert!(rows.iter().any(|r|r.id=="open:unproven"));
        assert_eq!(serde_json::to_value(&config).unwrap(),before);assert_eq!(connection_at(&config.connections,"http://127.0.0.1:9834").unwrap().id,"paired");
    }
    #[test]
    fn same_address_conflicting_pins_stay_distinct_and_unknown_local_shortcut_remains() {
        let connections=vec![menu_connection("a","https://host.test",Some("peer-a"),"Home"),menu_connection("b","https://host.test",Some("peer-b"),"Home"),menu_connection("unknown","https://host.test",None,"Home")];
        let rows=service_menu_rows(&connections,Some("http://127.0.0.1:9834"));assert_eq!(rows.len(),4);assert_eq!(rows[0].id,"local-service");
        assert_ne!(rows[1].label,rows[2].label);assert_eq!(connection_at(&connections,"https://host.test").unwrap().id,"a");
    }
    #[test]
    fn service_directory_folds_bootstrap_and_aliases_without_touching_profiles() {
        let mut config=Config::default();
        config.connections=vec![menu_connection("local","https://127.0.0.1:9834",None,"本机"),menu_connection("paired","https://127.0.0.1:9834",Some("peer-a"),"127.0.0.1:9834"),menu_connection("alias","https://mac.test",Some("peer-a"),"Mac"),menu_connection("other-port","https://127.0.0.1:9881",Some("peer-b"),"Other"),menu_connection("localhost","https://localhost:9834",None,"Unknown"),menu_connection("http","http://127.0.0.1:9834",None,"Unknown HTTP")];
        config.profile_keys.insert("local".into(),"existing-profile".into());config.open_connections.push("local".into());
        let before=serde_json::to_value(&config).unwrap();
        let rows=service_connections(&config.connections);
        assert_eq!(rows.iter().map(|c|c.id.as_str()).collect::<Vec<_>>(),vec!["paired","other-port","localhost","http"]);
        let selected=resolve_saved_connection(&config.connections,config.connections[0].clone());
        assert_eq!(selected.id,"paired");assert_eq!(selected.window_label(),rows[0].window_label());
        assert_eq!(serde_json::to_value(&config).unwrap(),before);
    }
    #[test]
    fn directory_and_resolution_preserve_conflicting_pins_and_unproven_addresses() {
        let connections=vec![menu_connection("a","https://host.test",Some("peer-a"),"Home"),menu_connection("b","https://host.test",Some("peer-b"),"Home"),menu_connection("unknown","https://host.test",None,"Home")];
        assert_eq!(service_connections(&connections),connections);
        assert_eq!(resolve_saved_connection(&connections,connections[2].clone()).id,"unknown");
        assert_eq!(resolve_saved_connection(&connections,connections[1].clone()).target_peer_id.as_deref(),Some("peer-b"));
        let unpaired=vec![menu_connection("local","https://127.0.0.1:9834",None,"本机"),menu_connection("address","https://127.0.0.1:9834",None,"127.0.0.1:9834")];
        assert_eq!(service_connections(&unpaired).len(),1);
    }
    #[test]
    fn address_labels_keep_ports_and_ipv6_without_guessing_service_identity() {
        assert_eq!(address_label("http://127.0.0.1:9834"),"127.0.0.1:9834");assert_eq!(address_label("http://[::1]:9881"),"[::1]:9881");assert_eq!(address_label("https://host.test"),"host.test");
    }

    #[test]
    fn invitation_cannot_change_window_target_or_entry_identity() {
        let target = format!("12D3KooW{}", "1".repeat(44));
        let entry = format!("12D3KooW{}", "2".repeat(44));
        let c: Connection = serde_json::from_value(serde_json::json!({"id":"a","url":"https://entry.test","label":"A","serviceOrigin":"https://target.test","targetPeerId":target,"entryServiceId":entry})).unwrap();
        let descriptor = serde_json::json!({"v":1,"serviceId":target,"entryServiceId":entry,"entryUrl":"https://entry.test","serviceUrl":"https://target.test","code":"x".repeat(43)});
        let invitation = |d: &serde_json::Value| {
            format!(
                "https://entry.test/#termdock-invite={}",
                base64::engine::general_purpose::URL_SAFE_NO_PAD
                    .encode(serde_json::to_vec(d).unwrap())
            )
        };
        assert!(c.validate_invitation(&invitation(&descriptor)).is_ok());
        let mut forged = descriptor.clone();
        forged["serviceId"] = serde_json::json!(entry);
        assert!(c.validate_invitation(&invitation(&forged)).is_err());
        forged = descriptor.clone();
        forged["entryUrl"] = serde_json::json!("https://attacker.test");
        assert!(c.validate_invitation(&invitation(&forged)).is_err());
        forged = descriptor;
        forged["serviceUrl"] = serde_json::json!("https://another-target.test");
        assert!(c.validate_invitation(&invitation(&forged)).is_err());
    }
    #[test]
    fn rejects_credentials_and_api_urls() {
        for value in [
            "https://u:p@a",
            "https://a/api/terminal",
            "https://a/#invite=secret",
            "file:///tmp",
            "https://a/?token=secret",
        ] {
            assert!(origin(value).is_err());
        }
    }
    #[test]
    fn import_is_copy_only_and_drops_secrets() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("preview/config.json");
        let stable = dir.path().join("desktop.json");
        let bytes = br#"{"connections":[{"id":"a","url":"https://a","label":"A","token":"secret"}],"trustedCertificateAuthorities":["secret"],"auth":"secret"}"#;
        fs::write(&stable, bytes).unwrap();
        let c = Config::load(&file, &stable).unwrap();
        c.persist(&file).unwrap();
        assert_eq!(fs::read(&stable).unwrap(), bytes);
        let raw = fs::read_to_string(&file).unwrap();
        assert!(!raw.contains("secret"));
        assert!(c.certificate_pins.is_empty());
        fs::write(stable, "{}").unwrap();
        assert_eq!(
            Config::load(&file, &dir.path().join("desktop.json"))
                .unwrap()
                .connections
                .len(),
            1
        );
    }
    #[test]
    fn metadata_rejects_invalid_route_identity() {
        let c: Connection = serde_json::from_value(
            serde_json::json!({"id":"a","url":"https://a","label":"A","entryServiceId":"A"}),
        )
        .unwrap();
        assert!(c.validated().is_err());
    }
}

#[cfg(test)]
mod terminal_engine_preference_tests {
 use super::*;
 #[test]fn engine_preference_is_optional_web_by_default_and_persists_native(){
  let old:Config=serde_json::from_str("{}").unwrap();assert_eq!(old.desktop_preferences.terminal_engine,TerminalEngine::Web);
  let mut config=old;config.desktop_preferences.terminal_engine=TerminalEngine::Native;
  let encoded=serde_json::to_string(&config).unwrap();let restored:Config=serde_json::from_str(&encoded).unwrap();assert_eq!(restored.desktop_preferences.terminal_engine,TerminalEngine::Native);
  let directory=tempfile::tempdir().unwrap();let file=directory.path().join("preview.json");
  config.persist(&file).unwrap();let loaded=Config::load(&file,&directory.path().join("missing-stable.json")).unwrap();
  assert_eq!(loaded.desktop_preferences.terminal_engine,TerminalEngine::Native);
  assert!(serde_json::from_str::<TerminalEngine>("\"unknown\"").is_err());
 }
}
