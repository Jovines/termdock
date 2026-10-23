//! A transport-only loopback boundary, not an authenticated business client.
//! It has no device key, grant, login cookie, daemon lifecycle or cleartext API fallback.
use crate::{config::Connection, tls};
use axum::{
    body::Body,
    extract::{
        ws::{Message, WebSocket, WebSocketUpgrade},
        State,
    },
    http::{header, Request, Response, StatusCode},
    response::IntoResponse,
    routing::any,
    Router,
};
use futures_util::{SinkExt, StreamExt};
use sha2::{Digest, Sha256};
use std::{collections::BTreeMap, sync::Arc, time::Duration};
use tokio::{net::TcpListener, sync::oneshot};
use tokio_tungstenite::{
    connect_async_tls_with_config,
    tungstenite::{
        client::IntoClientRequest,
        protocol::{Message as WireMessage, WebSocketConfig},
    },
    Connector,
};
use url::Url;

#[derive(Clone)]
pub struct Upstream {
    pub origin: String,
    pub http: reqwest::Client,
    pub tls: Arc<rustls::ClientConfig>,
}
#[derive(Clone)]
struct Boundary {
    host: String,
    token: String,
    sources: Vec<Upstream>,
    static_source: usize,
    default_source: usize,
    assets: Option<Arc<AssetBundle>>,
}
pub struct ProxyHandle {
    pub origin: String,
    pub launch_url: String,
    pub bundled_workspace: bool,
    stop: Option<oneshot::Sender<()>>,
}
impl Drop for ProxyHandle {
    fn drop(&mut self) {
        if let Some(stop) = self.stop.take() {
            let _ = stop.send(());
        }
    }
}

pub fn upstream(origin: String, pin: Option<&str>) -> Result<Upstream, String> {
    let tls = tls::client(pin)?;
    let http = reqwest::Client::builder()
        .use_preconfigured_tls((*tls).clone())
        .no_proxy()
        .redirect(reqwest::redirect::Policy::none())
        .connect_timeout(Duration::from_secs(5))
        .timeout(Duration::from_secs(30))
        .build()
        .map_err(|e| e.to_string())?;
    Ok(Upstream { origin, http, tls })
}
/// Validate the actual entry's TLS before opening any workspace, including
/// invitations and saved peers. A routed target need not be directly reachable.
/// This is public bootstrap metadata only; authorization stays in the page.
pub async fn discover_connection_identity(
    connection: &Connection,
    pins: &std::collections::BTreeMap<String, String>,
) -> Result<Option<String>, String> {
    let source = upstream(connection.url.clone(), pins.get(&connection.url).map(String::as_str))?;
    let response = source.http.get(format!("{}/api/auth/open/parameters", connection.url))
        .send().await.map_err(|error| {
            eprintln!("[Termdock Preview] service discovery failed for {}: {error:#}", connection.url);
            "Cannot discover service. Verify the address and Preview certificate fingerprint."
        })?;
    if [401, 403].contains(&response.status().as_u16()) { return Ok(None); }
    if !response.status().is_success() { return Err("服务授权入口暂不可用，请稍后重试".into()); }
    if connection.target_peer_id.is_some() { return Ok(None); }
    let bytes = response.bytes().await.map_err(|e| e.to_string())?;
    if bytes.len() > 64 * 1024 { return Err("Invalid discovery response".into()); }
    let data: serde_json::Value = serde_json::from_slice(&bytes).map_err(|_| "Invalid discovery response")?;
    data["serviceIdentity"].as_str().map(|id| Some(id.to_owned())).ok_or_else(|| "Missing serviceIdentity".into())
}
/// This public discovery is a compatibility hint, never device authorization.
/// Pinned relay/legacy connections still validate Noise and actual packet support.
pub fn validate_metadata(meta: &serde_json::Value) -> Result<(), String> {
    if meta["product"] != "termdock" {
        return Err("这不是可连接的 Termdock 服务".into());
    }
    if meta["protocolVersion"] != 1
        || !meta["capabilities"]
            .as_array()
            .is_some_and(|caps| caps.iter().any(|c| c == "terminal-ws"))
    {
        return Err("这台服务没有声明受支持的终端通信协议；请检查服务地址与版本".into());
    }
    Ok(())
}
pub async fn bind(port: Option<u16>) -> Result<TcpListener, String> {
    TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, port.unwrap_or(0))).await
        .map_err(|error| bind_error_message(&error).to_owned())
}

fn bind_error_message(error: &std::io::Error) -> &'static str {
    if error.kind() == std::io::ErrorKind::AddrInUse {
        "另一个 Preview 正在使用此连接的本地代理端口。关闭旧 Preview 后重试；无需停止 Termdock 服务。"
    } else {
        "无法启动此连接的本地代理，请重试或检查本机权限。"
    }
}
pub async fn start(
    listener: TcpListener,
    connection: &Connection,
    pins: &BTreeMap<String, String>,
) -> Result<(ProxyHandle, Vec<String>), String> {
    start_with_assets(listener, connection, pins, None).await
}
pub async fn start_with_assets(
    listener: TcpListener,
    connection: &Connection,
    pins: &BTreeMap<String, String>,
    assets: Option<std::path::PathBuf>,
) -> Result<(ProxyHandle, Vec<String>), String> {
    let origins = connection.origins();
    let sources: Vec<_> = origins
        .iter()
        .map(|o| upstream(o.clone(), pins.get(o).map(String::as_str)))
        .collect::<Result<_, _>>()?;
    let target = connection
        .service_origin
        .as_ref()
        .unwrap_or(&connection.url);
    let default_source = origins.iter().position(|o| o == target).unwrap();
    // Only addresses explicitly belonging to this target can supply its page.
    // A relay's frontend belongs to the relay, even when it carries target traffic.
    let mut candidates = Vec::new();
    let entry_is_target = match &connection.entry_service_id {
        Some(entry) => Some(entry) == connection.target_peer_id.as_ref(),
        None => connection.service_origin.as_ref().is_none_or(|origin| origin == &connection.url),
    };
    if connection.service_origin.is_some() || entry_is_target {
        candidates.push(default_source);
    }
    if entry_is_target {
        candidates.push(origins.iter().position(|o| o == &connection.url).unwrap());
    }
    candidates.extend(connection.routes.iter()
        .filter(|route| Some(&route.target_peer_id) == connection.target_peer_id.as_ref())
        .filter_map(|route| origins.iter().position(|o| o == &route.url)));
    let mut seen = std::collections::BTreeSet::new();
    candidates.retain(|index| seen.insert(*index));
    let mut static_source = None;
    for index in candidates {
        let source = &sources[index];
        if let Ok(response) = source.http.get(format!("{}/", source.origin))
            .timeout(Duration::from_secs(5)).send().await
        {
            if response.status().is_success()
                && response.headers().get(header::CONTENT_TYPE)
                    .and_then(|v| v.to_str().ok())
                    .is_some_and(|v| v.starts_with("text/html"))
            {
                static_source = Some(index);
                break;
            }
        }
    }
    // Load the verified package only when this target's own page is unavailable.
    // Never switch sources for a missing asset or failed business request.
    let assets = if static_source.is_none() {
        Some(Arc::new(AssetBundle::load(assets.ok_or(
            "Could not load this service's page. Check its address and Preview certificate pin.")?)?))
    } else { None };
    let bundled_workspace = assets.is_some();
    let static_source = static_source.unwrap_or(default_source);
    let host = format!(
        "127.0.0.1:{}",
        listener.local_addr().map_err(|e| e.to_string())?.port()
    );
    let token = uuid::Uuid::new_v4().simple().to_string();
    let origin = format!("http://{host}");
    let boundary = Arc::new(Boundary {
        host,
        token: token.clone(),
        sources,
        static_source,
        default_source,
        assets,
    });
    let router = Router::new().fallback(any(handle)).with_state(boundary);
    let (tx, rx) = oneshot::channel();
    tokio::spawn(async move {
        let _ = axum::serve(listener, router)
            .with_graceful_shutdown(async {
                let _ = rx.await;
            })
            .await;
    });
    Ok((
        ProxyHandle {
            origin: origin.clone(),
            launch_url: format!("{origin}/api/auth/status?__td_launch={token}"),
            bundled_workspace,
            stop: Some(tx),
        },
        origins,
    ))
}
fn rejected(status: StatusCode, text: &str) -> Response<Body> {
    (
        status,
        [(header::CACHE_CONTROL, "no-store")],
        text.to_owned(),
    )
        .into_response()
}
#[derive(Debug, PartialEq, Eq)]
enum Access {
    Static,
    Bootstrap,
    Socket,
    PasswordProof,
}
fn access(method: &str, path: &str) -> Option<Access> {
    if method == "GET" && ["/api/federation/secure", "/api/federation/relay"].contains(&path) {
        return Some(Access::Socket);
    }
    if method == "POST" && ["/api/auth/password/start", "/api/auth/password/finish"].contains(&path)
    {
        return Some(Access::PasswordProof);
    }
    if method == "GET"
        && [
            "/api/meta",
            "/api/auth/status",
            "/api/auth/open/parameters",
            "/api/auth/password/parameters",
        ]
        .contains(&path)
    {
        return Some(Access::Bootstrap);
    }
    if !["GET", "HEAD"].contains(&method)
        || path.contains('%')
        || path.contains('\\')
        || path.contains("..")
    {
        return None;
    }
    if [
        "/",
        "/index.html",
        "/workspace.html",
        "/manifest.webmanifest",
        "/favicon.ico",
        "/ipad-status-bar.js",
        "/pwa-512x512.svg",
        "/pwa-192x192.png",
        "/pwa-512x512.png",
        "/apple-touch-icon-180x180.png",
        "/boot-logo.png",
        "/maskable-icon-512x512.png",
        "/robots.txt",
        "/preview-shell.html",
        "/preview-shell.js",
        "/third-party-notices.txt",
        "/sw.js",
        "/sw-encrypted-background.js",
        "/sw-secure-api.js",
        "/sw-notifications.js",
        "/sw-downloads.js",
    ]
    .contains(&path)
        || (path.starts_with("/workbox-") && path.ends_with(".js"))
        || path.starts_with("/assets/")
        || (path.starts_with("/apple-splash-") && path.ends_with(".png"))
        || path.starts_with("/fonts/")
        || path.starts_with("/icons/")
    {
        return Some(Access::Static);
    }
    // Worker business fetches remain default-denied at this boundary. Existing
    // sw-secure-api delegates media to its exact encrypted document owner.
    None
}
async fn handle(
    State(boundary): State<Arc<Boundary>>,
    ws: Result<WebSocketUpgrade, axum::extract::ws::rejection::WebSocketUpgradeRejection>,
    request: Request<Body>,
) -> Response<Body> {
    let host = request
        .headers()
        .get(header::HOST)
        .and_then(|v| v.to_str().ok());
    let page_origin = format!("http://{}", boundary.host);
    if host != Some(boundary.host.as_str()) {
        return rejected(StatusCode::FORBIDDEN, "Invalid Preview host");
    }
    if request
        .headers()
        .get(header::ORIGIN)
        .is_some_and(|v| v.to_str().ok() != Some(page_origin.as_str()))
    {
        return rejected(StatusCode::FORBIDDEN, "Cross-origin request denied");
    }
    let cookie = format!(
        "td_preview_{}={}",
        boundary.host.split(':').next_back().unwrap(),
        boundary.token
    );
    let authenticated = request
        .headers()
        .get(header::COOKIE)
        .and_then(|v| v.to_str().ok())
        .is_some_and(|v| v.split(';').any(|c| c.trim() == cookie));
    let launch = matches!(request.uri().path(), "/" | "/health" | "/api/auth/status")
        && request.uri().query() == Some(format!("__td_launch={}", boundary.token).as_str());
    if launch {
        return Response::builder()
            .status(303)
            .header(header::LOCATION, "/")
            .header(header::CACHE_CONTROL, "no-store")
            .header(
                header::SET_COOKIE,
                format!("{cookie}; HttpOnly; SameSite=Strict; Path=/"),
            )
            .body(Body::empty())
            .unwrap();
    }
    if !authenticated {
        static REJECTS:std::sync::atomic::AtomicUsize=std::sync::atomic::AtomicUsize::new(0);
        if REJECTS.fetch_add(1,std::sync::atomic::Ordering::Relaxed)<8{eprintln!("Termdock loopback capability missing: {}",if request.uri().path()=="/"{"document"}else{"request"});}
        return rejected(StatusCode::FORBIDDEN, "Preview window capability required");
    }
    let original_path = request.uri().path();
    let (index, path) = if let Some(route) = original_path.strip_prefix("/__td_route/") {
        let Some((index, path)) = route.split_once('/') else {
            return rejected(StatusCode::NOT_FOUND, "Invalid route");
        };
        let Ok(index) = index.parse::<usize>() else {
            return rejected(StatusCode::NOT_FOUND, "Invalid route");
        };
        (index, format!("/{path}"))
    } else {
        (boundary.default_source, original_path.to_owned())
    };
    let Some(kind) = access(request.method().as_str(), &path) else {
        return rejected(
            StatusCode::FORBIDDEN,
            "Business APIs require the page's encrypted transport",
        );
    };
    // A route prefix only exists for public bootstrap and encrypted sockets.
    if kind == Access::Static && original_path.starts_with("/__td_route/") {
        return rejected(StatusCode::FORBIDDEN, "Static route denied");
    }
    if kind == Access::Static {
        if let Some(root) = &boundary.assets {
            return serve_asset(root, &path, request.method().as_str(), &boundary).await;
        }
    }
    let source = if kind == Access::Static {
        &boundary.sources[boundary.static_source]
    } else {
        let Some(source) = boundary.sources.get(index) else {
            return rejected(StatusCode::NOT_FOUND, "Unknown service route");
        };
        source
    };
    let mut url = Url::parse(&source.origin).unwrap();
    url.set_path(&path);
    if kind == Access::Socket {
        if request
            .headers()
            .get(header::ORIGIN)
            .and_then(|v| v.to_str().ok())
            != Some(page_origin.as_str())
        {
            return rejected(
                StatusCode::FORBIDDEN,
                "Secure sockets require this window's origin",
            );
        }
        if path == "/api/federation/relay" {
            let query = request.uri().query().unwrap_or("");
            let params: Vec<_> = url::form_urlencoded::parse(query.as_bytes()).collect();
            if params.len() != 1
                || params[0].0 != "routeToken"
                || params[0].1.len() > 4096
                || params[0].1.is_empty()
            {
                return rejected(StatusCode::BAD_REQUEST, "Invalid relay ticket");
            }
            url.set_query(Some(query));
        } else if request.uri().query().is_some() {
            return rejected(StatusCode::BAD_REQUEST, "Unexpected secure query");
        }
        let Ok(ws) = ws else {
            return rejected(StatusCode::BAD_REQUEST, "WebSocket required");
        };
        url.set_scheme(if source.origin.starts_with("https:") {
            "wss"
        } else {
            "ws"
        })
        .unwrap();
        let source = source.clone();
        return ws
            .max_message_size(4 * 1024 * 1024)
            .on_upgrade(move |socket| relay(socket, url, source))
            .into_response();
    }
    if matches!(kind, Access::Bootstrap | Access::PasswordProof) && request.uri().query().is_some()
    {
        return rejected(StatusCode::BAD_REQUEST, "Unexpected bootstrap query");
    }
    let mut upstream = source.http.request(request.method().clone(), url);
    if kind == Access::PasswordProof {
        // OPAQUE bootstrap is the existing public encrypted proof protocol, not
        // ordinary login. Drop ambient cookies/headers; bind only the exact source Origin.
        let Ok(bytes) = axum::body::to_bytes(request.into_body(), 64 * 1024).await else {
            return rejected(StatusCode::PAYLOAD_TOO_LARGE, "Password proof limit");
        };
        let Ok(data) = serde_json::from_slice::<serde_json::Value>(&bytes) else {
            return rejected(StatusCode::BAD_REQUEST, "Invalid password proof");
        };
        let allowed = if path.ends_with("/start") {
            ["startLoginRequest", "clientIdentity"]
        } else {
            ["attemptId", "finishLoginRequest"]
        };
        if !data.as_object().is_some_and(|o| {
            o.len() == 2
                && allowed.iter().all(|k| {
                    o.get(*k)
                        .is_some_and(|v| v.as_str().is_some_and(|v| !v.is_empty()))
                })
        }) {
            return rejected(StatusCode::BAD_REQUEST, "Invalid password proof fields");
        }
        upstream = upstream
            .header(header::CONTENT_TYPE, "application/json")
            .header(header::ORIGIN, &source.origin)
            .body(bytes);
    }
    let Ok(response) = upstream.send().await else {
        return rejected(
            StatusCode::BAD_GATEWAY,
            "Selected service transport failed; no business fallback",
        );
    };
    if response.status().is_redirection() {
        return rejected(
            StatusCode::BAD_GATEWAY,
            "Service redirects require an explicit connection",
        );
    }
    let status = response.status();
    let content_type = response.headers().get(header::CONTENT_TYPE).cloned();
    let mut result = Response::builder()
        .status(status)
        .header(header::CACHE_CONTROL, "no-store")
        .header("X-Content-Type-Options", "nosniff")
        .header(
            header::CONTENT_SECURITY_POLICY,
            if path == "/preview-shell.html" {
                "frame-ancestors 'self'; object-src 'none'; base-uri 'self'"
            } else {
                "frame-ancestors 'none'; object-src 'none'; base-uri 'self'"
            },
        );
    if let Some(value) = content_type {
        result = result.header(header::CONTENT_TYPE, value);
    }
    if matches!(kind, Access::Bootstrap | Access::PasswordProof) {
        let mut stream = response.bytes_stream();
        let mut bytes = Vec::new();
        while let Some(chunk) = stream.next().await {
            let Ok(chunk) = chunk else {
                return rejected(StatusCode::BAD_GATEWAY, "Bootstrap response failed");
            };
            if bytes.len() + chunk.len() > 64 * 1024 {
                return rejected(StatusCode::BAD_GATEWAY, "Bootstrap response limit");
            }
            bytes.extend_from_slice(&chunk);
        }
        if path == "/api/meta" && status.is_success() {
            let Ok(meta) = serde_json::from_slice::<serde_json::Value>(&bytes) else {
                return rejected(StatusCode::BAD_GATEWAY, "Invalid service metadata");
            };
            if let Err(error) = validate_metadata(&meta) {
                return rejected(StatusCode::BAD_GATEWAY, &error);
            }
        }
        return result.body(Body::from(bytes)).unwrap();
    }
    if path == "/sw-encrypted-background.js" {
        let Ok(bytes) = response.bytes().await else {
            return rejected(StatusCode::BAD_GATEWAY, "Background bundle unavailable");
        };
        if bytes.len() > 5 * 1024 * 1024 {
            return rejected(StatusCode::BAD_GATEWAY, "Background bundle limit");
        }
        let boot = serde_json::json!({"origins":boundary.sources.iter().map(|s| &s.origin).collect::<Vec<_>>(),"defaultRoute":boundary.default_source});
        let mut script = format!(
            "self.__TD_PREVIEW_TRANSPORT__={boot};\n{}\n",
            include_str!("../../renderer/worker-transport.js")
        )
        .into_bytes();
        script.extend(bytes);
        return result.body(Body::from(script)).unwrap();
    }
    // Sandboxed opaque-origin children cannot send this window's SameSite
    // cookie for their script subresource. Inline ONLY the trusted inert shell
    // bootstrap from the same selected frontend; no auth exemption is added.
    if path == "/preview-shell.html" {
        let Ok(bytes) = response.bytes().await else {
            return rejected(StatusCode::BAD_GATEWAY, "Preview shell failed");
        };
        if bytes.len() > 64 * 1024 {
            return rejected(StatusCode::BAD_GATEWAY, "Invalid preview shell");
        }
        let Ok(html) = String::from_utf8(bytes.to_vec()) else {
            return rejected(StatusCode::BAD_GATEWAY, "Invalid preview shell");
        };
        let Ok(script_response) = source
            .http
            .get(format!("{}/preview-shell.js", source.origin))
            .send()
            .await
        else {
            return rejected(StatusCode::BAD_GATEWAY, "Preview bootstrap failed");
        };
        if !script_response.status().is_success() {
            return rejected(StatusCode::BAD_GATEWAY, "Preview bootstrap unavailable");
        }
        let Ok(script) = script_response.bytes().await else {
            return rejected(StatusCode::BAD_GATEWAY, "Preview bootstrap failed");
        };
        if script.len() > 64 * 1024 {
            return rejected(StatusCode::BAD_GATEWAY, "Invalid preview bootstrap");
        }
        let Ok(script) = String::from_utf8(script.to_vec()) else {
            return rejected(StatusCode::BAD_GATEWAY, "Invalid preview bootstrap");
        };
        let marker = "<script src=\"/preview-shell.js\"></script>";
        if !html.contains(marker) {
            return rejected(StatusCode::BAD_GATEWAY, "Incompatible preview shell");
        }
        let html = html.replace(
            marker,
            &format!(
                "<script>{}</script>",
                script.replace("</script", "<\\/script")
            ),
        );
        return result.body(Body::from(html)).unwrap();
    }
    // Never copy Set-Cookie, redirects, or arbitrary upstream security headers.
    result
        .body(Body::from_stream(response.bytes_stream()))
        .unwrap()
}
async fn relay(mut page: WebSocket, url: Url, source: Upstream) {
    let Ok(mut request) = url.as_str().into_client_request() else {
        return;
    };
    // The page's exact origin and capability cookie were checked before upgrade.
    // Preserve direct-browser semantics for the selected service: open access
    // requires its own Origin. Never forward the loopback origin or credentials,
    // and never give a relay connection the direct-service open-access context.
    if url.path() == "/api/federation/secure" {
        let Ok(origin) = source.origin.parse() else { return; };
        request.headers_mut().insert(header::ORIGIN, origin);
    }
    let config = WebSocketConfig::default()
        .max_message_size(Some(4 * 1024 * 1024))
        .max_frame_size(Some(4 * 1024 * 1024));
    let Ok(Ok((mut upstream, _))) = tokio::time::timeout(
        Duration::from_secs(8),
        connect_async_tls_with_config(
            request,
            Some(config),
            false,
            Some(Connector::Rustls(source.tls)),
        ),
    )
    .await
    else {
        let _ = page.close().await;
        return;
    };
    loop {
        tokio::select! {
            incoming = page.next() => {
                let Some(Ok(message)) = incoming else { break; };
                let wire = match message { Message::Binary(v) => WireMessage::Binary(v), Message::Text(v) => WireMessage::Text(v.as_str().into()), Message::Ping(v) => WireMessage::Ping(v), Message::Pong(v) => WireMessage::Pong(v), Message::Close(_) => break };
                if upstream.send(wire).await.is_err() { break; }
            },
            incoming = upstream.next() => {
                let Some(Ok(message)) = incoming else { break; };
                let message = match message { WireMessage::Binary(v) => Message::Binary(v), WireMessage::Text(v) => Message::Text(v.as_str().into()), WireMessage::Ping(v) => Message::Ping(v), WireMessage::Pong(v) => Message::Pong(v), WireMessage::Close(_) => break, WireMessage::Frame(_) => continue };
                if page.send(message).await.is_err() { break; }
            }
        }
    }
    let _ = upstream.close(None).await;
    let _ = page.close().await;
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn bind_error_only_calls_address_in_use_a_preview_port_conflict() {
        assert!(bind_error_message(&std::io::Error::from(
            std::io::ErrorKind::AddrInUse
        ))
        .contains("另一个 Preview"));
        assert!(bind_error_message(&std::io::Error::from(
            std::io::ErrorKind::PermissionDenied
        ))
        .contains("无法启动此连接的本地代理"));
    }
    #[test]
    fn default_deny_business_and_worker_paths() {
        for path in [
            "/api/terminal/fs/upload",
            "/api/terminal/ws",
            "/api/auth/login",
            "/api/auth/password/unknown",
            "/api/federation/info",
            "/assets/../api/terminal",
            "/assets/%2e%2e/api",
            "/unknown",
        ] {
            assert!(access("GET", path).is_none());
        }
        assert_eq!(access("GET", "/api/auth/status"), Some(Access::Bootstrap));
        assert_eq!(
            access("GET", "/api/federation/secure"),
            Some(Access::Socket)
        );
        assert!(access("POST", "/assets/main.js").is_none());
    }
    async fn fixture() -> (ProxyHandle, tokio::task::JoinHandle<()>) {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let origin = format!("http://{}", listener.local_addr().unwrap());
        let app = Router::new()
            .route(
                "/",
                axum::routing::get(|| async {
                    (
                        [(header::CONTENT_TYPE, "text/html")],
                        "<html>service page</html>",
                    )
                }),
            )
            .route(
                "/api/federation/secure",
                axum::routing::get(|ws: WebSocketUpgrade, request: Request<Body>| async move {
                    // A password-free service only grants open access to a
                    // direct connection carrying its own validated Origin.
                    assert_eq!(
                        request.headers().get(header::ORIGIN).unwrap(),
                        format!("http://{}", request.headers()[header::HOST].to_str().unwrap()).as_str()
                    );
                    assert!(request.headers().get(header::COOKIE).is_none());
                    assert!(request.headers().get(header::AUTHORIZATION).is_none());
                    ws.on_upgrade(|mut socket| async move {
                        while let Some(Ok(message)) = socket.next().await {
                            if socket.send(message).await.is_err() {
                                break;
                            }
                        }
                    })
                }),
            );
        let task = tokio::spawn(async move {
            axum::serve(listener, app).await.unwrap();
        });
        let c = Connection {
            id: "test".into(),
            url: origin,
            label: "Test".into(),
            target_peer_id: None,
            service_origin: None,
            entry_service_id: None,
            routes: vec![],
        };
        let (proxy, _) = start(bind(None).await.unwrap(), &c, &BTreeMap::new())
            .await
            .unwrap();
        (proxy, task)
    }
    #[tokio::test]
    async fn first_load_boundary_and_binary_socket_without_service_worker() {
        let (proxy, task) = fixture().await;
        let http = reqwest::Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .build()
            .unwrap();
        assert_eq!(url::Url::parse(&proxy.launch_url).unwrap().path(), "/api/auth/status");
        assert_eq!(http.get(format!("{}/health?__td_launch=wrong",proxy.origin)).send().await.unwrap().status(),403);
        assert_eq!(http.get(&proxy.origin).send().await.unwrap().status(), 403);
        let launch = http.get(&proxy.launch_url).send().await.unwrap();
        assert_eq!(launch.status(),303);
        assert_eq!(launch.headers()[header::LOCATION],"/");
        let cookie = launch
            .headers()
            .get(header::SET_COOKIE)
            .unwrap()
            .to_str()
            .unwrap()
            .split(';')
            .next()
            .unwrap()
            .to_owned();
        let result = http
            .get(&proxy.origin)
            .header(header::COOKIE, &cookie)
            .send()
            .await
            .unwrap();
        assert_eq!(result.text().await.unwrap(), "<html>service page</html>");
        for path in ["/api/terminal/fs/upload", "/__td_route/8/api/meta"] {
            assert!(!http
                .get(format!("{}{path}", proxy.origin))
                .header(header::COOKIE, &cookie)
                .send()
                .await
                .unwrap()
                .status()
                .is_success());
        }
        assert_eq!(
            http.get(&proxy.origin)
                .header(header::COOKIE, &cookie)
                .header(header::ORIGIN, "https://attacker.test")
                .send()
                .await
                .unwrap()
                .status(),
            403
        );
        let mut request = format!(
            "{}/api/federation/secure",
            proxy.origin.replace("http:", "ws:")
        )
        .into_client_request()
        .unwrap();
        request
            .headers_mut()
            .insert(header::COOKIE, cookie.parse().unwrap());
        request
            .headers_mut()
            .insert(header::ORIGIN, proxy.origin.parse().unwrap());
        let (mut socket, _) = tokio_tungstenite::connect_async(request).await.unwrap();
        let bytes = vec![0, 255, 1, 9, 128];
        socket
            .send(WireMessage::Binary(bytes.clone().into()))
            .await
            .unwrap();
        assert_eq!(
            socket.next().await.unwrap().unwrap().into_data().to_vec(),
            bytes
        );
        task.abort();
        let _ = socket.close(None).await;
    }
    #[tokio::test]
    async fn occupied_persistent_port_does_not_move_origin() {
        let listener = bind(None).await.unwrap();
        assert!(bind(Some(listener.local_addr().unwrap().port()))
            .await
            .is_err());
    }
}

async fn serve_asset(
    bundle: &AssetBundle,
    path: &str,
    method: &str,
    boundary: &Boundary,
) -> Response<Body> {
    let relative = if path == "/" {
        "index.html"
    } else {
        path.trim_start_matches('/')
    };
    let root = &bundle.root;
    let Some(expected) = bundle.files.get(relative) else {
        return rejected(StatusCode::NOT_FOUND, "Unlisted Preview asset");
    };
    let file = root.join(relative);
    let Ok(file) = file.canonicalize() else {
        return rejected(StatusCode::NOT_FOUND, "Preview asset unavailable");
    };
    if !file.starts_with(root) {
        return rejected(StatusCode::FORBIDDEN, "Invalid asset path");
    }
    let mime = match file.extension().and_then(|e| e.to_str()).unwrap_or("") {
        "html" => "text/html; charset=utf-8",
        "js" | "mjs" => "text/javascript",
        "css" => "text/css",
        "png" => "image/png",
        "svg" => "image/svg+xml",
        "woff2" => "font/woff2",
        "json" | "webmanifest" => "application/json",
        "wasm" => "application/wasm",
        _ => "application/octet-stream",
    };
    let mut response = Response::builder()
        .header(header::CONTENT_TYPE, mime)
        .header(header::CACHE_CONTROL, "no-store")
        .header("X-Content-Type-Options", "nosniff")
        .header(
            header::CONTENT_SECURITY_POLICY,
            if path == "/preview-shell.html" {
                "frame-ancestors 'self'; object-src 'none'; base-uri 'self'"
            } else {
                "frame-ancestors 'none'; object-src 'none'; base-uri 'self'"
            },
        );
    if path == "/sw.js" {
        response = response.header("Service-Worker-Allowed", "/");
    }
    let Ok(bytes) = tokio::fs::read(&file).await else {
        return rejected(StatusCode::NOT_FOUND, "Preview asset unavailable");
    };
    if bytes.len() as u64 != expected.size || hex::encode(Sha256::digest(&bytes)) != expected.sha256
    {
        return rejected(StatusCode::BAD_GATEWAY, "Preview asset hash mismatch");
    }
    if method == "HEAD" {
        return response.body(Body::empty()).unwrap();
    }
    if ["/preview-shell.html", "/sw-encrypted-background.js"].contains(&path) {
        if path == "/preview-shell.html" {
            let Ok(html) = String::from_utf8(bytes) else {
                return rejected(StatusCode::BAD_GATEWAY, "Invalid preview shell");
            };
            let Some(expected) = bundle.files.get("preview-shell.js") else {
                return rejected(StatusCode::BAD_GATEWAY, "Preview bootstrap unlisted");
            };
            let Ok(script_file) = root.join("preview-shell.js").canonicalize() else {
                return rejected(StatusCode::BAD_GATEWAY, "Preview bootstrap missing");
            };
            if !script_file.starts_with(root) {
                return rejected(StatusCode::FORBIDDEN, "Invalid preview bootstrap path");
            }
            let Ok(script) = tokio::fs::read_to_string(script_file).await else {
                return rejected(StatusCode::BAD_GATEWAY, "Preview bootstrap missing");
            };
            if script.len() as u64 != expected.size
                || hex::encode(Sha256::digest(script.as_bytes())) != expected.sha256
            {
                return rejected(StatusCode::BAD_GATEWAY, "Preview bootstrap hash mismatch");
            }
            let html = html.replace(
                "<script src=\"/preview-shell.js\"></script>",
                &format!(
                    "<script>{}</script>",
                    script.replace("</script", "<\\/script")
                ),
            );
            return response.body(Body::from(html)).unwrap();
        }
        let boot = serde_json::json!({"origins":boundary.sources.iter().map(|s|&s.origin).collect::<Vec<_>>(),"defaultRoute":boundary.default_source});
        let mut script = format!(
            "self.__TD_PREVIEW_TRANSPORT__={boot};\n{}\n",
            include_str!("../../renderer/worker-transport.js")
        )
        .into_bytes();
        script.extend(bytes);
        return response.body(Body::from(script)).unwrap();
    }
    response.body(Body::from(bytes)).unwrap()
}

#[derive(serde::Deserialize)]
struct AssetEntry {
    size: u64,
    sha256: String,
}
struct AssetBundle {
    root: std::path::PathBuf,
    files: BTreeMap<String, AssetEntry>,
}
impl AssetBundle {
    fn load(root: std::path::PathBuf) -> Result<Self, String> {
        let root = root
            .canonicalize()
            .map_err(|_| "Preview workspace resources missing; rebuild the app")?;
        #[derive(serde::Deserialize)]
        #[serde(rename_all = "camelCase")]
        struct Manifest {
            version: u8,
            source_revision: String,
            files: BTreeMap<String, AssetEntry>,
        }
        let manifest = root
            .join("workspace-manifest.json")
            .canonicalize()
            .map_err(|_| "Preview workspace manifest missing")?;
        if !manifest.starts_with(&root) {
            return Err("Preview manifest escapes resource directory".into());
        }
        let data = std::fs::read(manifest).map_err(|_| "Preview workspace manifest missing")?;
        if data.len() > 8 * 1024 * 1024 {
            return Err("Invalid workspace manifest".into());
        }
        let manifest: Manifest =
            serde_json::from_slice(&data).map_err(|_| "Invalid workspace manifest")?;
        if manifest.version != 1
            || manifest.source_revision.len() != 40
            || !manifest
                .source_revision
                .bytes()
                .all(|b| b.is_ascii_hexdigit())
            || !manifest.files.contains_key("index.html")
        {
            return Err("Invalid workspace revision/entry".into());
        }
        for (path, entry) in &manifest.files {
            if path.starts_with('/')
                || path.contains('%')
                || path.contains('\\')
                || path
                    .split('/')
                    .any(|p| p.is_empty() || p == "." || p == "..")
                || entry.size > 512 * 1024 * 1024
                || entry.sha256.len() != 64
                || hex::decode(&entry.sha256).is_err()
            {
                return Err("Invalid workspace asset descriptor".into());
            }
        }
        Ok(Self {
            root,
            files: manifest.files,
        })
    }
}

#[cfg(test)]
mod bundle_tests {
    use super::*;
    async fn page_server(page: &'static str) -> (String, tokio::task::JoinHandle<()>) {
        let listener = bind(None).await.unwrap();
        let origin = format!("http://{}", listener.local_addr().unwrap());
        let server = Router::new().route("/", axum::routing::get(move || async move {
            axum::response::Html(page)
        })).route("/assets/own.js", axum::routing::get(move || async move { page }));
        let task = tokio::spawn(async move { axum::serve(listener, server).await.unwrap(); });
        (origin, task)
    }
    async fn capability(proxy: &ProxyHandle) -> (reqwest::Client, String) {
        let http = reqwest::Client::builder().redirect(reqwest::redirect::Policy::none()).build().unwrap();
        let response = http.get(&proxy.launch_url).send().await.unwrap();
        let cookie = response.headers()[header::SET_COOKIE].to_str().unwrap()
            .split(';').next().unwrap().to_owned();
        (http, cookie)
    }
    #[tokio::test]
    async fn target_page_wins_over_package_and_relay_and_never_mixes_missing_resources() {
        let (target, target_task) = page_server("<html>target</html>").await;
        let (entry, entry_task) = page_server("<html>relay</html>").await;
        let connection = Connection {
            id: "target".into(), url: entry, label: "Target through entry".into(),
            target_peer_id: Some("target".into()), service_origin: Some(target),
            entry_service_id: Some("entry".into()), routes: vec![],
        };
        // An invalid/missing package must not prevent loading the service page.
        let (proxy, _) = start_with_assets(bind(None).await.unwrap(), &connection,
            &BTreeMap::new(), Some(std::path::PathBuf::from("/missing-workspace"))).await.unwrap();
        assert!(!proxy.bundled_workspace);
        let (http, cookie) = capability(&proxy).await;
        for path in ["/", "/assets/own.js"] {
            let response = http.get(format!("{}{path}", proxy.origin))
                .header(header::COOKIE, &cookie).send().await.unwrap();
            assert_eq!(response.text().await.unwrap(), "<html>target</html>");
        }
        assert_eq!(http.get(format!("{}/assets/missing.js", proxy.origin))
            .header(header::COOKIE, &cookie).send().await.unwrap().status(), 404);
        // Another saved direct address may supply the same target's frontend;
        // relay addresses in the same route list cannot.
        let mut alternate = connection.clone();
        alternate.service_origin = Some("http://127.0.0.1:1".into());
        alternate.routes = vec![crate::config::Route {
            url: connection.service_origin.clone().unwrap(), target_peer_id: "target".into()
        }];
        let (alternate_proxy, _) = start(bind(None).await.unwrap(), &alternate,
            &BTreeMap::new()).await.unwrap();
        let (alternate_http, alternate_cookie) = capability(&alternate_proxy).await;
        assert_eq!(alternate_http.get(&alternate_proxy.origin)
            .header(header::COOKIE, &alternate_cookie).send().await.unwrap().text().await.unwrap(),
            "<html>target</html>");
        // Reload gets the target's current page, not a startup copy.
        target_task.abort();
        let _ = target_task.await;
        let address = connection.service_origin.as_ref().unwrap().trim_start_matches("http://");
        let listener = TcpListener::bind(address).await.unwrap();
        let replacement = tokio::spawn(async move {
            axum::serve(listener, Router::new().route("/", axum::routing::get(|| async {
                axum::response::Html("<html>updated target</html>")
            }))).await.unwrap();
        });
        assert_eq!(http.get(&proxy.origin).header(header::COOKIE, &cookie)
            .send().await.unwrap().text().await.unwrap(), "<html>updated target</html>");
        replacement.abort();
        let _ = replacement.await;
        assert_eq!(http.get(&proxy.origin).header(header::COOKIE, &cookie)
            .send().await.unwrap().status(), 502);
        assert_eq!(http.post(format!("{}/api/terminal/fs/upload", proxy.origin))
            .header(header::COOKIE, &cookie).send().await.unwrap().status(), 403);
        entry_task.abort();
    }
    #[tokio::test]
    async fn entry_only_and_offline_target_use_package_without_loading_entry_frontend() {
        let (entry, task) = page_server("<html>wrong service</html>").await;
        let dir = tempfile::tempdir().unwrap();
        let index = b"<html>packaged fallback</html>";
        std::fs::write(dir.path().join("index.html"), index).unwrap();
        std::fs::write(dir.path().join("workspace-manifest.json"), serde_json::json!({
            "version":1,"sourceRevision":"a".repeat(40),"files":{
                "index.html":{"size":index.len(),"sha256":hex::encode(Sha256::digest(index))}
            }
        }).to_string()).unwrap();
        for service_origin in [None, Some("http://127.0.0.1:1".to_owned())] {
            let connection = Connection {
                id: "target".into(), url: entry.clone(), label: "Relay only".into(),
                target_peer_id: Some("target".into()), service_origin,
                entry_service_id: Some("entry".into()), routes: vec![crate::config::Route {
                    url: entry.clone(), target_peer_id: "entry".into()
                }],
            };
            assert!(start(bind(None).await.unwrap(), &connection, &BTreeMap::new()).await.is_err());
            let (proxy, _) = start_with_assets(bind(None).await.unwrap(), &connection,
                &BTreeMap::new(), Some(dir.path().to_owned())).await.unwrap();
            assert!(proxy.bundled_workspace);
            let (http, cookie) = capability(&proxy).await;
            assert_eq!(http.get(&proxy.origin).header(header::COOKIE, &cookie)
                .send().await.unwrap().text().await.unwrap(), String::from_utf8_lossy(index));
            assert_eq!(http.get(format!("{}/assets/own.js", proxy.origin))
                .header(header::COOKIE, &cookie).send().await.unwrap().status(), 404);
        }
        task.abort();
    }
    #[tokio::test]
    async fn manifest_resources_cannot_escape_or_fallback_to_remote_static_assets() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("workspace");
        std::fs::create_dir(&root).unwrap();
        let index = b"<html>fixed local workspace</html>";
        let script = b"console.log('fixed')";
        std::fs::write(root.join("index.html"), index).unwrap();
        std::fs::create_dir(root.join("assets")).unwrap();
        std::fs::write(root.join("assets/fixed.js"), script).unwrap();
        let entry = |bytes: &[u8]| serde_json::json!({"size":bytes.len(),"sha256":hex::encode(Sha256::digest(bytes))});
        let mut manifest = serde_json::json!({"version":1,"sourceRevision":"a".repeat(40),"files":{"index.html":entry(index),"assets/fixed.js":entry(script),"assets/missing.js":entry(script)}});
        std::fs::write(root.join("workspace-manifest.json"), manifest.to_string()).unwrap();
        let connection = Connection {
            id: "local-assets".into(),
            url: "http://127.0.0.1:1".into(),
            label: "unreachable target".into(),
            target_peer_id: None,
            service_origin: None,
            entry_service_id: None,
            routes: vec![],
        };
        let (proxy, _) = start_with_assets(
            bind(None).await.unwrap(),
            &connection,
            &BTreeMap::new(),
            Some(root.clone()),
        )
        .await
        .unwrap();
        let http = reqwest::Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .build()
            .unwrap();
        let launch = http.get(&proxy.launch_url).send().await.unwrap();
        let cookie = launch.headers()[header::SET_COOKIE]
            .to_str()
            .unwrap()
            .split(';')
            .next()
            .unwrap();
        let get = |path: &str| {
            http.get(format!("{}{path}", proxy.origin))
                .header(header::COOKIE, cookie)
        };
        assert_eq!(
            get("/").send().await.unwrap().text().await.unwrap(),
            String::from_utf8_lossy(index)
        );
        assert_eq!(get("/assets/fixed.js").send().await.unwrap().status(), 200);
        assert_eq!(
            get("/assets/missing.js").send().await.unwrap().status(),
            404
        );
        assert_eq!(
            get("/assets/unlisted.js").send().await.unwrap().status(),
            404
        );
        std::fs::write(root.join("assets/fixed.js"), "tampered").unwrap();
        assert_eq!(get("/assets/fixed.js").send().await.unwrap().status(), 502);
        #[cfg(unix)]
        {
            std::fs::remove_file(root.join("assets/fixed.js")).unwrap();
            std::fs::write(dir.path().join("outside.js"), script).unwrap();
            std::os::unix::fs::symlink(dir.path().join("outside.js"), root.join("assets/fixed.js"))
                .unwrap();
            assert_eq!(get("/assets/fixed.js").send().await.unwrap().status(), 403);
        }
        manifest["files"]["../private"] = entry(script);
        std::fs::write(root.join("workspace-manifest.json"), manifest.to_string()).unwrap();
        assert!(AssetBundle::load(root).is_err());
    }
}

#[cfg(test)]
mod compatibility_tests {
    use super::*;
    #[tokio::test]
    async fn actual_metadata_gate_keeps_v1_and_rejects_unknown_or_oversized_bootstrap() {
        for (meta, accepted) in [
            (
                serde_json::json!({"product":"termdock","version":"1.4.320","protocolVersion":1,"capabilities":["terminal-ws","filesystem"]}),
                true,
            ),
            (
                serde_json::json!({"product":"termdock","protocolVersion":2,"capabilities":["terminal-ws"]}),
                false,
            ),
            (
                serde_json::json!({"product":"other","protocolVersion":1,"capabilities":["terminal-ws"]}),
                false,
            ),
            (
                serde_json::json!({"product":"termdock","protocolVersion":1,"capabilities":[]}),
                false,
            ),
            (
                serde_json::json!({"product":"termdock","protocolVersion":1,"capabilities":["terminal-ws"],"padding":"x".repeat(70*1024)}),
                false,
            ),
        ] {
            let listener = bind(None).await.unwrap();
            let url = format!("http://{}", listener.local_addr().unwrap());
            let server = Router::new().route(
                "/api/meta",
                axum::routing::get(move || async move { axum::Json(meta) }),
            );
            let task = tokio::spawn(async move {
                axum::serve(listener, server).await.unwrap();
            });
            let connection = Connection {
                id: url.clone(),
                url,
                label: "Existing service".into(),
                target_peer_id: None,
                service_origin: None,
                entry_service_id: None,
                routes: vec![],
            };
            let assets = tempfile::tempdir().unwrap();
            let index = b"<html>trusted client</html>";
            std::fs::write(assets.path().join("index.html"), index).unwrap();
            std::fs::write(assets.path().join("workspace-manifest.json"),serde_json::to_vec(&serde_json::json!({"version":1,"sourceRevision":"a".repeat(40),"files":{"index.html":{"size":index.len(),"sha256":hex::encode(Sha256::digest(index))}}})).unwrap()).unwrap();
            let (proxy, _) = start_with_assets(
                bind(None).await.unwrap(),
                &connection,
                &BTreeMap::new(),
                Some(assets.path().into()),
            )
            .await
            .unwrap();
            let http = reqwest::Client::builder()
                .redirect(reqwest::redirect::Policy::none())
                .build()
                .unwrap();
            let launch = http.get(&proxy.launch_url).send().await.unwrap();
            let cookie = launch
                .headers()
                .get(header::SET_COOKIE)
                .unwrap()
                .to_str()
                .unwrap()
                .split(';')
                .next()
                .unwrap();
            let response = http
                .get(format!("{}/api/meta", proxy.origin))
                .header(header::COOKIE, cookie)
                .header(header::ORIGIN, &proxy.origin)
                .send()
                .await
                .unwrap();
            assert_eq!(response.status().is_success(), accepted);
            task.abort();
        }
    }
}
