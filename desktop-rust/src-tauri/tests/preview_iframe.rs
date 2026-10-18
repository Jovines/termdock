//! Opt-in real Chromium regression for the sandboxed HTML preview entry.
use axum::{http::header, routing::get, Router};
use std::{collections::BTreeMap, process::Stdio};
use termdock_preview::{config::Connection, proxy};
use tokio::{net::TcpListener, process::Command};
#[tokio::test]
#[ignore = "requires installed agent-browser/Chromium; run explicitly for iframe acceptance"]
async fn sandboxed_preview_shell_loads_through_actual_boundary() {
    let html = r#"<!doctype html><html><body><h1>Preview boundary test</h1>
<script>
const capability='12345678-1234-1234-1234-123456789012';
window.addEventListener('message',event=>{ document.body.dataset.lastMessage=JSON.stringify(event.data);
 if(event.data?.type==='preview-ready' && event.data.capability===capability) {
  event.source.postMessage({type:'preview-init',capability,resources:[],html:`<!doctype html><html><body><p>Sandbox content loaded</p><script>let isolated=false;try{void parent.localStorage}catch(e){isolated=true}parent.postMessage({loaded:true,isolated,nativeBridge:typeof window.termdockDesktop},'*');<\/script></body></html>`},'*');
 }
 if(event.data?.loaded) document.body.dataset.result=JSON.stringify(event.data);
});
</script><iframe sandbox="allow-scripts" referrerpolicy="no-referrer" src="/preview-shell.html#12345678-1234-1234-1234-123456789012"></iframe></body></html>"#;
    let router = Router::new()
        .route(
            "/",
            get(move || async move { ([(header::CONTENT_TYPE, "text/html")], html) }),
        )
        .route(
            "/preview-shell.html",
            get(|| async {
                ([(header::CONTENT_TYPE, "text/html")], {
                    include_str!("../../../public/preview-shell.html")
                })
            }),
        )
        .route(
            "/preview-shell.js",
            get(|| async {
                ([(header::CONTENT_TYPE, "text/javascript")], {
                    include_str!("../../../public/preview-shell.js")
                })
            }),
        );
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let origin = format!("http://{}", listener.local_addr().unwrap());
    let upstream = tokio::spawn(async move {
        axum::serve(listener, router).await.unwrap();
    });
    let connection = Connection {
        id: "iframe-test".into(),
        url: origin,
        label: "Iframe".into(),
        target_peer_id: None,
        service_origin: None,
        entry_service_id: None,
        routes: vec![],
    };
    let (proxy, _) = proxy::start(
        proxy::bind(None).await.unwrap(),
        &connection,
        &BTreeMap::new(),
    )
    .await
    .unwrap();
    let session = format!("td-preview-iframe-{}", std::process::id());
    let browser = |args: Vec<String>| {
        let mut command = Command::new("agent-browser");
        command
            .arg("--session")
            .arg(&session)
            .args(args)
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        command
    };
    let open = browser(vec!["open".into(), proxy.launch_url.clone()])
        .output()
        .await
        .unwrap();
    assert!(
        open.status.success(),
        "{}",
        String::from_utf8_lossy(&open.stderr)
    );
    let ready = browser(vec![
        "wait".into(),
        "--fn".into(),
        "!!document.body.dataset.result".into(),
        "--timeout".into(),
        "5000".into(),
    ])
    .output()
    .await
    .unwrap();
    let result = browser(vec![
        "eval".into(),
        "JSON.parse(document.body.dataset.result || '{}')".into(),
    ])
    .output()
    .await
    .unwrap();
    let _ = browser(vec![
        "screenshot".into(),
        "/tmp/termdock-tauri-html-preview.png".into(),
    ])
    .output()
    .await;
    let _ = browser(vec!["close".into()]).output().await;
    upstream.abort();
    assert!(
        ready.status.success(),
        "{}",
        String::from_utf8_lossy(&ready.stderr)
    );
    let text = String::from_utf8_lossy(&result.stdout);
    assert!(text.contains("\"isolated\": true"), "{text}");
    assert!(text.contains("\"nativeBridge\": \"undefined\""), "{text}");
}
