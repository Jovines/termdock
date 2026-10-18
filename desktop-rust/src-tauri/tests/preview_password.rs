use std::{collections::BTreeMap, path::PathBuf, process::Stdio};
use termdock_preview::{config::Connection, proxy};
use tokio::{
    io::{AsyncBufReadExt, AsyncWriteExt, BufReader},
    process::Command,
};
#[tokio::test]
async fn unchanged_old_server_url_only_password_then_same_device_noise_without_worker() {
    let root = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../..");
    let mut child = Command::new("node")
        .args(["--import", "tsx"])
        .arg(root.join("desktop-rust/scripts/password-fixture.ts"))
        .current_dir(root)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::inherit())
        .kill_on_drop(true)
        .spawn()
        .unwrap();
    let mut output = BufReader::new(child.stdout.take().unwrap()).lines();
    let line = tokio::time::timeout(std::time::Duration::from_secs(20), output.next_line())
        .await
        .unwrap()
        .unwrap()
        .unwrap();
    let metadata: serde_json::Value = serde_json::from_str(&line).unwrap();
    let connection = Connection {
        id: "password".into(),
        url: metadata["url"].as_str().unwrap().into(),
        label: "Old protected service".into(),
        target_peer_id: None,
        service_origin: None,
        entry_service_id: None,
        routes: vec![],
    };
    let (proxy, origins) = proxy::start(
        proxy::bind(None).await.unwrap(),
        &connection,
        &BTreeMap::new(),
    )
    .await
    .unwrap();
    let http = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .unwrap();
    let response = http.get(&proxy.launch_url).send().await.unwrap();
    let cookie = response
        .headers()
        .get("set-cookie")
        .unwrap()
        .to_str()
        .unwrap()
        .split(';')
        .next()
        .unwrap();
    let boot = serde_json::json!({"origin":proxy.origin,"origins":origins,"defaultRoute":0,"cookie":cookie});
    child
        .stdin
        .take()
        .unwrap()
        .write_all(format!("{boot}\n").as_bytes())
        .await
        .unwrap();
    let line = tokio::time::timeout(std::time::Duration::from_secs(30), output.next_line())
        .await
        .unwrap()
        .unwrap();
    assert!(line.is_some(), "Password fixture exited before its result");
    let result: serde_json::Value = serde_json::from_str(&line.unwrap()).unwrap();
    assert_eq!(result["ok"], true, "{result}");
    assert!(
        tokio::time::timeout(std::time::Duration::from_secs(10), child.wait())
            .await
            .unwrap()
            .unwrap()
            .success()
    );
}
