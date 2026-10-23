//! Real Chromium loading the production bundle and production init script.
//! Native OS callbacks remain a harness; this is not WKWebView/Mac acceptance.
use axum::{
    body::{to_bytes, Body},
    extract::State,
    http::{Request, StatusCode},
    response::{IntoResponse, Response},
    routing::any,
    Json, Router,
};
use serde_json::json;
use sha2::{Digest, Sha256};
use std::{
    collections::BTreeMap,
    fs,
    path::PathBuf,
    process::Stdio,
    sync::{Arc, Mutex},
};
use termdock_preview::{config::Connection, local_files, proxy};
struct FileFixture {
    transfers: Mutex<local_files::Transfers>,
    owner: local_files::Owner,
    path: PathBuf,
    secret: String,
    origin: String,
}
async fn file_ipc(State(state): State<Arc<FileFixture>>, request: Request<Body>) -> Response {
    let origin = request
        .headers()
        .get("origin")
        .and_then(|v| v.to_str().ok());
    if origin != Some(state.origin.as_str()) {
        return StatusCode::FORBIDDEN.into_response();
    }
    let mut response = if request.method() == "OPTIONS" {
        StatusCode::NO_CONTENT.into_response()
    } else {
        if request
            .headers()
            .get("x-native-test")
            .and_then(|v| v.to_str().ok())
            != Some(state.secret.as_str())
        {
            return StatusCode::FORBIDDEN.into_response();
        }
        let bytes = to_bytes(request.into_body(), 2048).await.unwrap();
        let body: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
        let args = &body["args"];
        let mut store = state.transfers.lock().unwrap();
        let result = match body["op"].as_str().unwrap() {
            "chooseFiles" => store.prepare(
                state.owner.clone(),
                vec![local_files::Input::selected(state.path.clone())],
                false,
                None,
            ),
            "fileChunk" => store.chunk(
                &state.owner,
                args["batch"].as_str().unwrap(),
                args["index"].as_u64().unwrap() as usize,
                args["seq"].as_u64().unwrap(),
                args["receipt"].as_str(),
            ),
            "releaseFiles" => store
                .release(&state.owner, args["batch"].as_str().unwrap())
                .map(|_| serde_json::Value::Null),
            _ => Err("Unsupported fixture IPC".into()),
        };
        match result {
            Ok(value) => Json(value).into_response(),
            Err(error) => (StatusCode::BAD_REQUEST, Json(json!({"error":error}))).into_response(),
        }
    };
    response
        .headers_mut()
        .insert("access-control-allow-origin", state.origin.parse().unwrap());
    response.headers_mut().insert(
        "access-control-allow-headers",
        "content-type,x-native-test".parse().unwrap(),
    );
    response.headers_mut().insert(
        "access-control-allow-methods",
        "POST,OPTIONS".parse().unwrap(),
    );
    response
}
use tokio::{
    io::{AsyncBufReadExt, AsyncWriteExt, BufReader},
    process::Command,
};
#[tokio::test]
#[ignore = "requires prepared production workspace, agent-browser and an immutable old-server archive"]
async fn actual_bundled_authorization_ui_uses_old_router_without_peer_input() {
    run(false,false).await;
}
#[tokio::test]
#[ignore = "requires production workspace, Chromium and fixed old-server source"]
async fn actual_bundled_entry_only_invitation_and_password_use_old_noise() {
    run(true,false).await;
}
#[tokio::test]
#[ignore = "requires production bundle/Chromium/fixed old router; ordinary browser renderer only"]
async fn actual_react_terminal_model_direct_consumes_encrypted_stream() {run(false,true).await;}
#[tokio::test]
#[ignore = "requires production bundle/Chromium/fixed entry-only router; no native host"]
async fn actual_react_terminal_model_entry_only_consumes_encrypted_stream() {run(true,true).await;}
async fn run(relay: bool, native_react: bool) {
    let root = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../..");
    let manifest =
        fs::read(root.join("desktop-rust/.workspace-dist/workspace-manifest.json")).unwrap();
    let resource: serde_json::Value = serde_json::from_slice(&manifest).unwrap();
    eprintln!("production workspace source={} dirty={} manifestSHA256={} resourceCount={} bridgeSHA256={}",resource["sourceRevision"],resource["dirty"],hex::encode(Sha256::digest(&manifest)),resource["files"].as_object().unwrap().len(),hex::encode(Sha256::digest(include_str!("../../renderer/bridge.js"))));

    let mut child = Command::new("node")
        .args(["--import", "tsx"])
        .arg(root.join("desktop-rust/scripts/browser-server-fixture.ts"))
        .args(if relay { vec!["--relay"] } else { vec![] })
        .args(if native_react {vec!["--native-react"]}else{vec![]})
        .current_dir(&root)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::inherit())
        .kill_on_drop(true)
        .spawn()
        .unwrap();
    let mut output = BufReader::new(child.stdout.take().unwrap()).lines();
    let line = output.next_line().await.unwrap().unwrap();
    let metadata: serde_json::Value = serde_json::from_str(&line).unwrap();
    eprintln!(
        "old server source={} hashes={}",
        metadata["serverRevision"], metadata["oldSourceHashes"]
    );
    let target = if relay {
        metadata["serviceOrigin"].as_str().unwrap()
    } else {
        metadata["url"].as_str().unwrap()
    };
    let connection = Connection {
        id: target.into(),
        url: metadata["url"].as_str().unwrap().into(),
        label: "Existing service".into(),
        target_peer_id: metadata["targetPeerId"].as_str().map(str::to_owned),
        service_origin: metadata["serviceOrigin"].as_str().map(str::to_owned),
        entry_service_id: metadata["entryServiceId"].as_str().map(str::to_owned),
        routes: vec![],
    };
    let (proxy, origins) = proxy::start_with_assets(
        proxy::bind(None).await.unwrap(),
        &connection,
        &BTreeMap::new(),
        Some(root.join("desktop-rust/.workspace-dist")),
    )
    .await
    .unwrap();
    let boot = json!({"origin":proxy.origin,"origins":origins,"defaultRoute":origins.iter().position(|o|o==target).unwrap(),"connection":connection,"invitation":metadata["invitation"],"version":"0.1.0","platform":"linux"});
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("native-fixture.bin");
    fs::write(&path, vec![127u8; 2 * 1024 * 1024]).unwrap();
    let file_state = Arc::new(FileFixture {
        transfers: Mutex::new(Default::default()),
        owner: local_files::Owner {
            window: "fixture".into(),
            target: target.into(),
        },
        path,
        secret: uuid::Uuid::new_v4().to_string(),
        origin: proxy.origin.clone(),
    });
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let native_url = format!("http://{}/ipc", listener.local_addr().unwrap());
    let native_router = Router::new()
        .route("/ipc", any(file_ipc))
        .with_state(file_state.clone());
    let file_server =
        tokio::spawn(async move { axum::serve(listener, native_router).await.unwrap() });
    let native_secret = json!(file_state.secret);
    let init = directory.path().join("init.js");
    // Only native directory/device/status IPC is adapted. OPAQUE, identity, page
    // fetch, Noise, original authorization UI and bundle imports are all real.
    let script = format!(
        r#"if(window===window.top) {{ window.__TD_PREVIEW_BOOT__={boot};
const nativeRead=window.fetch.bind(window);
const initialDirectory=[window.__TD_PREVIEW_BOOT__.connection];
window.__TAURI_INTERNALS__={{invoke:async (_command,{{op,args}})=>{{
 if(['chooseFiles','fileChunk','releaseFiles'].includes(op)){{const response=await nativeRead({native_url:?},{{method:'POST',headers:{{'Content-Type':'application/json','X-Native-Test':{native_secret}}},body:JSON.stringify({{op,args}}),credentials:'omit'}});const data=await response.json();if(!response.ok)throw Error(data.error);return data;}}
 const key='termdock-secure-test-native-directory';const records=JSON.parse(localStorage.getItem(key)||JSON.stringify(initialDirectory));
 if(op==='connections')return records;
 if(op==='saveConnection'||op==='importConnection'){{localStorage.setItem(key,JSON.stringify([args.connection]));return [args.connection];}}
 if(op==='deviceInfo')return {{system:'Linux',client:'Preview fixture',arch:'x64',mode:'desktop'}};
 if(op==='snapshot')return {{appVersion:'0.1.0',localService:{{running:false,probe:null}},connections:records}};
 if(op==='reportActivity')return null;
 throw new Error('OS callback outside this bundle test: '+op);
}}}}; }}
{}
if(window===window.top && !sessionStorage.getItem('termdock-secure-test-first-load'))sessionStorage.setItem('termdock-secure-test-first-load',JSON.stringify({{worker:!!navigator.serviceWorker.controller}}));"#,
        include_str!("../../renderer/bridge.js")
    );
    fs::write(&init, script).unwrap();
    let session = format!("td-bundled-{}-{}-{}", std::process::id(), relay,native_react);
    let browser = |args: Vec<String>| {
        let mut command = Command::new("agent-browser");
        command.args(["--session", &session]).args(args);
        command
    };
    let open = browser(vec![
        "--init-script".into(),
        init.to_string_lossy().into_owned(),
        "open".into(),
        proxy.launch_url.clone(),
    ])
    .output()
    .await
    .unwrap();
    assert!(
        open.status.success(),
        "{}",
        String::from_utf8_lossy(&open.stderr)
    );
    if relay {
        let invitation = browser(vec![
            "wait".into(),
            "--fn".into(),
            "Array.from(document.querySelectorAll('button')).some(b=>b.textContent==='接受邀请')"
                .into(),
            "--timeout".into(),
            "10000".into(),
        ])
        .output()
        .await
        .unwrap();
        if !invitation.status.success() {
            let snapshot = browser(vec!["eval".into(), "document.body.innerText".into()])
                .output()
                .await
                .unwrap();
            eprintln!(
                "entry invitation UI: {}",
                String::from_utf8_lossy(&snapshot.stdout)
            );
        }
        assert!(
            invitation.status.success(),
            "{}",
            String::from_utf8_lossy(&invitation.stderr)
        );
        let accepted = browser(vec![
            "find".into(),
            "role".into(),
            "button".into(),
            "click".into(),
            "--name".into(),
            "接受邀请".into(),
            "--exact".into(),
        ])
        .output()
        .await
        .unwrap();
        assert!(
            accepted.status.success(),
            "{}",
            String::from_utf8_lossy(&accepted.stderr)
        );
    }
    let password_selector = if relay {
        "[role=dialog] input[type=password]"
    } else {
        "input[type=password]"
    };
    let ready = browser(vec![
        "wait".into(),
        password_selector.into(),
        "--timeout".into(),
        "10000".into(),
    ])
    .output()
    .await
    .unwrap();
    let first=browser(vec!["eval".into(),"JSON.stringify({worker:JSON.parse(sessionStorage.getItem('termdock-secure-test-first-load')).worker,controlledNow:!!navigator.serviceWorker.controller,selected:sessionStorage.getItem('termdock-secure-target-v1'),hook:window.termdockDesktop.passwordBootstrapOrigin(location.origin),passwordField:!!document.querySelector('input[type=password]'),targetName:document.body.innerText.includes('Existing service'),oldHtml:document.body.innerText.includes('OLD HTML')})".into()]).output().await.unwrap();
    eprintln!(
        "first actual bundle: {}",
        String::from_utf8_lossy(&first.stdout)
    );
    assert!(
        first.status.success(),
        "{}",
        String::from_utf8_lossy(&first.stderr)
    );
    let first: serde_json::Value = serde_json::from_slice(&first.stdout).unwrap();
    let first = first
        .as_str()
        .map(|s| serde_json::from_str::<serde_json::Value>(s).unwrap())
        .unwrap_or(first);
    assert_eq!(
        first["worker"], false,
        "first load must have no SW controller"
    );
    if relay {
        assert_eq!(
            first["targetName"], true,
            "existing invitation UI must show the native target name"
        );
        assert!(first["selected"]
            .as_str()
            .unwrap()
            .contains(metadata["targetPeerId"].as_str().unwrap()));
    } else {
        assert_eq!(first["selected"], serde_json::Value::Null);
    }
    assert_eq!(
        first["hook"], target,
        "actual packaged hook binds the old router Origin"
    );
    assert_eq!(first["oldHtml"], false);
    let display = browser(vec!["eval".into(), "Array.from(document.querySelectorAll('p[title]')).map(p=>({origin:p.title,text:p.textContent}))".into()]).output().await.unwrap();
    let display: serde_json::Value = serde_json::from_slice(&display.stdout).unwrap();
    let expected_host = url::Url::parse(target).unwrap().authority().to_owned();
    assert!(
        display
            .as_array()
            .unwrap()
            .iter()
            .any(|p| p["origin"] == target
                && p["text"]
                    .as_str()
                    .is_some_and(|s| s.contains(&expected_host))),
        "real login UI must show the original target: {display}"
    );
    assert!(!display
        .as_array()
        .unwrap()
        .iter()
        .any(|p| p["origin"] == proxy.origin));
    let fill = browser(vec![
        "fill".into(),
        password_selector.into(),
        "wrong-password".into(),
    ])
    .output()
    .await
    .unwrap();
    assert!(fill.status.success());
    let wrong = browser(vec!["press".into(), "Enter".into()])
        .output()
        .await
        .unwrap();
    assert!(wrong.status.success());
    let error=browser(vec!["wait".into(),"--fn".into(),"!!document.querySelector('input[type=password]') && !!document.querySelector('[role=alert]')".into(),"--timeout".into(),"10000".into()]).output().await.unwrap();
    assert!(
        error.status.success(),
        "wrong password feedback: {}",
        String::from_utf8_lossy(&error.stderr)
    );
    child
        .stdin
        .as_mut()
        .unwrap()
        .write_all(b"inspect\n")
        .await
        .unwrap();
    assert_eq!(
        serde_json::from_str::<serde_json::Value>(&output.next_line().await.unwrap().unwrap())
            .unwrap()["targetGrants"],
        0,
        "wrong password must not grant target authorization"
    );
    let correct = browser(vec![
        "fill".into(),
        password_selector.into(),
        "preview-bundle-test-password".into(),
    ])
    .output()
    .await
    .unwrap();
    assert!(correct.status.success());
    let enter = browser(vec!["press".into(), "Enter".into()])
        .output()
        .await
        .unwrap();
    assert!(enter.status.success());
    let logged=browser(vec!["wait".into(),"--fn".into(),"!document.querySelector('input[type=password]') && !!sessionStorage.getItem('termdock-secure-target-v1')".into(),"--timeout".into(),"15000".into()]).output().await.unwrap();
    let retained_name = browser(vec![
        "eval".into(),
        "JSON.parse(sessionStorage.getItem('termdock-secure-target-v1')).serviceName".into(),
    ])
    .output()
    .await
    .unwrap();
    assert_eq!(
        serde_json::from_slice::<serde_json::Value>(&retained_name.stdout).unwrap(),
        "Existing service",
        "real login must retain the original native bookmark label across scope reload"
    );
    let result = browser(vec![
        "eval".into(),
        "fetch('/api/terminal/test-health').then(r=>r.json())".into(),
    ])
    .output()
    .await
    .unwrap();
    eprintln!(
        "actual bundle authenticated business: {}",
        String::from_utf8_lossy(&result.stdout)
    );
    if native_react {
        let consumed=browser(vec!["eval".into(),"(async()=>{const end=performance.now()+15000;let state;do{state=await fetch('/api/terminal/test-health',{signal:AbortSignal.timeout(3000)}).then(r=>r.json());if(document.querySelector('.xterm')&&state.events.some(e=>e.type==='output-ack'&&e.since===state.sequence&&e.flowSeq===state.sequence&&e.epoch===state.epoch))return {consumed:true,sequence:state.sequence,epoch:state.epoch};await new Promise(r=>setTimeout(r,50));}while(performance.now()<end);throw Error('Initial consumption deadline: '+JSON.stringify(state));})()".into()]).output().await.unwrap();
        assert!(consumed.status.success(),"actual React/stream model: {}",String::from_utf8_lossy(&consumed.stderr));assert_eq!(serde_json::from_slice::<serde_json::Value>(&consumed.stdout).unwrap()["consumed"],true);
        let state=browser(vec!["eval".into(),"fetch('/api/terminal/test-health').then(r=>r.json()).then(s=>({fixture:s.fixture,sequence:s.sequence,opens:s.events.filter(e=>e.type==='terminal-open'),acks:s.events.filter(e=>e.type==='output-ack'),resize:s.events.filter(e=>e.type==='resize'),xterm:!!document.querySelector('.xterm')}))".into()]).output().await.unwrap();
        assert!(state.status.success());eprintln!("actual ordinary browser React TerminalView fixture: {}",String::from_utf8_lossy(&state.stdout));
        let state:serde_json::Value=serde_json::from_slice(&state.stdout).unwrap();assert_eq!(state["fixture"],"actual-old-router-react-terminal-model-v1");assert_eq!(state["xterm"],true);assert!(!state["acks"].as_array().unwrap().is_empty());
        let disconnected=browser(vec!["eval".into(),"fetch('/api/terminal/test-health',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({action:'disconnect'})}).then(r=>r.json()).then(s=>s.fixture)".into()]).output().await.unwrap();assert!(disconnected.status.success());
        let reconnected=browser(vec!["eval".into(),"(async()=>{const end=performance.now()+15000;let state;do{state=await fetch('/api/terminal/test-health',{signal:AbortSignal.timeout(3000)}).then(r=>r.json());if(state.events.filter(e=>e.type==='terminal-open').length>=2&&state.events.some(e=>e.type==='output-ack'&&e.since===state.sequence&&e.flowSeq===state.sequence&&e.epoch===state.epoch))return {reconnected:true,sequence:state.sequence,epoch:state.epoch};await new Promise(r=>setTimeout(r,50));}while(performance.now()<end);throw Error('Reconnect consumption deadline: '+JSON.stringify(state));})()".into()]).output().await.unwrap();assert!(reconnected.status.success(),"{}",String::from_utf8_lossy(&reconnected.stderr));assert_eq!(serde_json::from_slice::<serde_json::Value>(&reconnected.stdout).unwrap()["reconnected"],true);
        child.stdin.as_mut().unwrap().write_all(b"done\n").await.unwrap();let server=output.next_line().await.unwrap().unwrap();eprintln!("controlled React terminal model final: {server}");assert_eq!(serde_json::from_str::<serde_json::Value>(&server).unwrap()["ok"],true);assert_eq!(serde_json::from_str::<serde_json::Value>(&server).unwrap()["ordinary"],0);let observed:serde_json::Value=serde_json::from_str(&server).unwrap();let events=observed["react"]["events"].as_array().unwrap();assert!(events.iter().filter(|event|event["type"]=="terminal-open").count()>=2);assert!(events.iter().any(|event|event["type"]=="output-ack"&&event["since"]==observed["react"]["sequence"]&&event["flowSeq"]==observed["react"]["sequence"]&&event["epoch"]==observed["react"]["epoch"]));
        assert!(child.wait().await.unwrap().success());let _=browser(vec!["close".into()]).output().await;file_server.abort();return;
    }
    let upload=browser(vec!["eval".into(),r#"(async()=>{const files=await window.termdockDesktop.readLocalFiles();if(files.length!==1||files[0].path||files[0].bytes.byteLength!==2*1024*1024)throw Error('native read contract');const csrf=await fetch('/api/csrf-token').then(r=>r.json());const body=new FormData();body.append('files',new Blob([files[0].bytes]),files[0].name);const response=await fetch('/api/terminal/fs/upload?dir=%2Ftmp&fileCount=1',{method:'POST',headers:{'X-XSRF-TOKEN':csrf.csrfToken},body});if(!response.ok)throw Error('encrypted upload failed');return response.json()})()"#.into()]).output().await.unwrap();
    assert!(
        upload.status.success(),
        "real read/upload: {} {}",
        String::from_utf8_lossy(&upload.stdout),
        String::from_utf8_lossy(&upload.stderr)
    );
    assert_eq!(
        serde_json::from_slice::<serde_json::Value>(&upload.stdout).unwrap()["secure"],
        true
    );
    assert_eq!(file_state.transfers.lock().unwrap().usage(), (0, 0));
    eprintln!("actual Rust 2MiB chunk reader -> production bridge ArrayBuffer -> same device encrypted upload: {}",String::from_utf8_lossy(&upload.stdout));
    let controlled = browser(vec![
        "wait".into(),
        "--fn".into(),
        "!!navigator.serviceWorker.controller".into(),
        "--timeout".into(),
        "10000".into(),
    ])
    .output()
    .await
    .unwrap();
    let preview = browser(vec!["eval".into(), r#"new Promise((resolve,reject)=>{const cap=crypto.randomUUID();const frame=document.createElement('iframe');frame.sandbox='allow-scripts';frame.src='/preview-shell.html#'+cap;const timeout=setTimeout(()=>reject(Error('HTML preview timed out')),5000);const handler=e=>{if(e.source!==frame.contentWindow)return;if(e.data?.type==='preview-ready'&&e.data.capability===cap)frame.contentWindow.postMessage({type:'preview-init',capability:cap,resources:[],html:'<p>Bundled preview loaded</p><script>let isolated=false;try{void parent.localStorage}catch{isolated=true}parent.postMessage({loaded:true,isolated,bridge:typeof window.termdockDesktop},"*");<\/script>'},'*');if(e.data?.loaded){clearTimeout(timeout);window.removeEventListener('message',handler);frame.remove();resolve(e.data)}};window.addEventListener('message',handler);document.body.append(frame)})"#.into()]).output().await.unwrap();
    eprintln!(
        "actual bundled HTML preview: {}",
        String::from_utf8_lossy(&preview.stdout)
    );
    assert!(
        preview.status.success(),
        "{}",
        String::from_utf8_lossy(&preview.stderr)
    );
    let preview: serde_json::Value = serde_json::from_slice(&preview.stdout).unwrap();
    assert_eq!(preview["isolated"], true);
    assert_eq!(preview["bridge"], "undefined");
    child
        .stdin
        .as_mut()
        .unwrap()
        .write_all(b"disconnect\n")
        .await
        .unwrap();
    assert_eq!(
        serde_json::from_str::<serde_json::Value>(&output.next_line().await.unwrap().unwrap())
            .unwrap()["disconnected"],
        true
    );
    let offline = browser(vec![
        "eval".into(),
        "fetch('/api/terminal/test-health').then(r=>({failed:!r.ok}),()=>({failed:true}))".into(),
    ])
    .output()
    .await
    .unwrap();
    assert!(offline.status.success());
    assert_eq!(
        serde_json::from_slice::<serde_json::Value>(&offline.stdout).unwrap()["failed"],
        true,
        "disconnected encrypted business must fail closed"
    );
    let offline_upload=browser(vec!["eval".into(),r#"(async()=>{const files=await window.termdockDesktop.readLocalFiles();const body=new FormData();body.append('files',new Blob([files[0].bytes]),files[0].name);try{const response=await fetch('/api/terminal/fs/upload?dir=%2Ftmp&fileCount=1',{method:'POST',body});return {failed:!response.ok}}catch{return {failed:true}}})()"#.into()]).output().await.unwrap();
    assert!(offline_upload.status.success());
    assert_eq!(
        serde_json::from_slice::<serde_json::Value>(&offline_upload.stdout).unwrap()["failed"],
        true
    );
    assert_eq!(file_state.transfers.lock().unwrap().usage(), (0, 0));
    let _ = browser(vec![
        "screenshot".into(),
        "/tmp/termdock-preview-bundled-auth.png".into(),
    ])
    .output()
    .await;
    let errors = browser(vec!["errors".into()]).output().await.unwrap();
    eprintln!(
        "bundle page errors: {}",
        String::from_utf8_lossy(&errors.stdout)
    );
    let _ = browser(vec!["close".into()]).output().await;
    child
        .stdin
        .take()
        .unwrap()
        .write_all(b"done\n")
        .await
        .unwrap();
    let server = output.next_line().await.unwrap().unwrap();
    assert!(child.wait().await.unwrap().success());
    assert!(
        ready.status.success(),
        "{}",
        String::from_utf8_lossy(&ready.stderr)
    );
    assert!(
        error.status.success(),
        "wrong password feedback: {}",
        String::from_utf8_lossy(&error.stderr)
    );
    assert!(
        logged.status.success(),
        "{}",
        String::from_utf8_lossy(&logged.stderr)
    );
    assert!(controlled.status.success());
    assert!(String::from_utf8_lossy(&result.stdout).contains("true"));
    assert_eq!(
        serde_json::from_str::<serde_json::Value>(&server).unwrap()["ok"],
        true
    );
    file_server.abort();
}
