use std::{collections::BTreeMap, path::PathBuf, process::Stdio};
use termdock_preview::{config::Connection, proxy};
use tokio::{
    io::{AsyncBufReadExt, AsyncWriteExt, BufReader},
    process::Command,
};
#[tokio::test]
async fn actual_node_noise_direct_relay_reconnect() {
    let root = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../..");
    let home = tempfile::tempdir().unwrap();
    let mut child = Command::new("node")
        .env("HOME", home.path())
        .env_remove("TERMDOCK_PASSWORD")
        .arg("--import")
        .arg("tsx")
        .arg(root.join("desktop-rust/scripts/transport-fixture.ts"))
        .current_dir(&root)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::inherit())
        .kill_on_drop(true)
        .spawn()
        .expect("Install root Node dependencies before transport tests");
    let mut output = BufReader::new(child.stdout.take().unwrap()).lines();
    let line = tokio::time::timeout(std::time::Duration::from_secs(20), output.next_line())
        .await
        .unwrap()
        .unwrap()
        .unwrap();
    let metadata: serde_json::Value = serde_json::from_str(&line).expect("Fixture metadata");
    let connection = Connection {
        id: "real-noise".into(),
        url: metadata["entryUrl"].as_str().unwrap().into(),
        label: "Target".into(),
        target_peer_id: Some(metadata["targetPeerId"].as_str().unwrap().into()),
        service_origin: Some(metadata["targetUrl"].as_str().unwrap().into()),
        entry_service_id: Some(metadata["entryPeerId"].as_str().unwrap().into()),
        routes: vec![],
    }
    .validated()
    .unwrap();
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
    let launch = http.get(&proxy.launch_url).send().await.unwrap();
    let cookie = launch
        .headers()
        .get("set-cookie")
        .unwrap()
        .to_str()
        .unwrap()
        .split(';')
        .next()
        .unwrap();
    let boot = serde_json::json!({"origin":proxy.origin,"origins":origins,"defaultRoute":origins.iter().position(|o|Some(o)==connection.service_origin.as_ref()).unwrap(),"cookie":cookie});
    child
        .stdin
        .take()
        .unwrap()
        .write_all(format!("{boot}\n").as_bytes())
        .await
        .unwrap();
    let result = tokio::time::timeout(std::time::Duration::from_secs(30), output.next_line())
        .await
        .unwrap()
        .unwrap()
        .unwrap();
    let result: serde_json::Value = serde_json::from_str(&result).unwrap();
    assert_eq!(result["ok"], true, "{result}");
    assert!(
        tokio::time::timeout(std::time::Duration::from_secs(10), child.wait())
            .await
            .unwrap()
            .unwrap()
            .success()
    );
}
