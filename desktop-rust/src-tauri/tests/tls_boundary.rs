use rustls::pki_types::{CertificateDer, PrivateKeyDer, PrivatePkcs8KeyDer};
use sha2::{Digest, Sha256};
use std::sync::{
    atomic::{AtomicUsize, Ordering},
    Arc,
};
use termdock_preview::proxy;
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::TcpListener,
};
#[tokio::test]
async fn real_self_signed_tls_is_origin_scoped_and_rejects_changed_leaf_before_http() {
    let cert = rcgen::generate_simple_self_signed(vec!["localhost".into()]).unwrap();
    let fingerprint = hex::encode(Sha256::digest(cert.cert.der().as_ref()));
    let config = rustls::ServerConfig::builder_with_provider(Arc::new(
        rustls::crypto::ring::default_provider(),
    ))
    .with_safe_default_protocol_versions()
    .unwrap()
    .with_no_client_auth()
    .with_single_cert(
        vec![CertificateDer::from(cert.cert.der().to_vec())],
        PrivateKeyDer::Pkcs8(PrivatePkcs8KeyDer::from(cert.signing_key.serialize_der())),
    )
    .unwrap();
    let acceptor = tokio_rustls::TlsAcceptor::from(Arc::new(config));
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let origin = format!(
        "https://127.0.0.1:{}",
        listener.local_addr().unwrap().port()
    );
    let http_requests = Arc::new(AtomicUsize::new(0));
    let count = http_requests.clone();
    let server = tokio::spawn(async move {
        loop {
            let (socket, _) = listener.accept().await.unwrap();
            let acceptor = acceptor.clone();
            let count = count.clone();
            tokio::spawn(async move {
                if let Ok(mut socket) = acceptor.accept(socket).await {
                    let mut bytes = [0; 4096];
                    if let Ok(size) = socket.read(&mut bytes).await {
                        if size > 0 {
                            count.fetch_add(1, Ordering::SeqCst);
                            let _=socket.write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\nok").await;
                        }
                    }
                }
            });
        }
    });
    let pinned = proxy::upstream(origin.clone(), Some(&fingerprint)).unwrap();
    assert_eq!(
        pinned
            .http
            .get(&origin)
            .send()
            .await
            .unwrap()
            .text()
            .await
            .unwrap(),
        "ok"
    );
    let untrusted = proxy::upstream(origin.clone(), None).unwrap();
    assert!(untrusted.http.get(&origin).send().await.is_err());
    let changed = proxy::upstream(origin.clone(), Some(&"00".repeat(32))).unwrap();
    assert!(changed.http.get(&origin).send().await.is_err());
    // A different origin gets a different client and never inherits this pin.
    let another_origin = proxy::upstream(origin.replace("127.0.0.1", "localhost"), None).unwrap();
    assert!(another_origin
        .http
        .get(origin.replace("127.0.0.1", "localhost"))
        .send()
        .await
        .is_err());
    assert_eq!(http_requests.load(Ordering::SeqCst), 1);
    // Saved identities and routed invitations must pass the same entry TLS
    // check as a new address, without contacting the unreachable target.
    let connection = termdock_preview::config::Connection {
        id: "saved".into(), url: origin.clone(), label: "Saved target".into(),
        target_peer_id: Some("saved-target".into()),
        service_origin: Some("https://unreachable.invalid".into()),
        entry_service_id: Some("entry".into()), routes: vec![],
    };
    assert!(proxy::discover_connection_identity(&connection, &Default::default()).await.is_err());
    assert_eq!(http_requests.load(Ordering::SeqCst), 1);
    let pins = [(origin.clone(), fingerprint)].into_iter().collect();
    assert_eq!(proxy::discover_connection_identity(&connection, &pins).await.unwrap(), None);
    assert_eq!(http_requests.load(Ordering::SeqCst), 2);
    server.abort();
}

#[tokio::test]
async fn entry_probe_preserves_password_bootstrap_for_both_new_and_saved_services() {
    use axum::{routing::get, Router};
    for status in [401, 403] {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}", listener.local_addr().unwrap());
        let app = Router::new().route("/api/auth/open/parameters", get(move || async move {
            axum::http::StatusCode::from_u16(status).unwrap()
        }));
        let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap(); });
        for peer in [None, Some("saved-target".into())] {
            let connection = termdock_preview::config::Connection {
                id: "protected".into(), url: url.clone(), label: "Protected".into(),
                target_peer_id: peer, service_origin: None, entry_service_id: None, routes: vec![],
            };
            assert_eq!(proxy::discover_connection_identity(&connection, &Default::default()).await.unwrap(), None);
        }
        server.abort();
    }
}
