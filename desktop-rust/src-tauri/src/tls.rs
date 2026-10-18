use rustls::{
    client::danger::{HandshakeSignatureValid, ServerCertVerified, ServerCertVerifier},
    pki_types::{CertificateDer, ServerName, UnixTime},
    DigitallySignedStruct, Error, SignatureScheme,
};
use sha2::{Digest, Sha256};
use std::{net::SocketAddr, sync::Arc, time::Duration};
use tokio::{net::TcpStream, time::timeout};
use tokio_rustls::TlsConnector;
use url::Url;

#[derive(Debug)]
struct PinnedLeaf {
    fingerprint: Vec<u8>,
    provider: Arc<rustls::crypto::CryptoProvider>,
}
impl ServerCertVerifier for PinnedLeaf {
    fn verify_server_cert(
        &self,
        leaf: &CertificateDer<'_>,
        _: &[CertificateDer<'_>],
        _: &ServerName<'_>,
        _: &[u8],
        _: UnixTime,
    ) -> Result<ServerCertVerified, Error> {
        // This verifier is attached ONLY to a client for one exact configured origin.
        if Sha256::digest(leaf.as_ref()).as_slice() == self.fingerprint {
            Ok(ServerCertVerified::assertion())
        } else {
            Err(Error::General(
                "Certificate differs from the origin-scoped Preview pin".into(),
            ))
        }
    }
    fn verify_tls12_signature(
        &self,
        message: &[u8],
        cert: &CertificateDer<'_>,
        dss: &DigitallySignedStruct,
    ) -> Result<HandshakeSignatureValid, Error> {
        rustls::crypto::verify_tls12_signature(
            message,
            cert,
            dss,
            &self.provider.signature_verification_algorithms,
        )
    }
    fn verify_tls13_signature(
        &self,
        message: &[u8],
        cert: &CertificateDer<'_>,
        dss: &DigitallySignedStruct,
    ) -> Result<HandshakeSignatureValid, Error> {
        rustls::crypto::verify_tls13_signature(
            message,
            cert,
            dss,
            &self.provider.signature_verification_algorithms,
        )
    }
    fn supported_verify_schemes(&self) -> Vec<SignatureScheme> {
        self.provider
            .signature_verification_algorithms
            .supported_schemes()
    }
}

/// One-shot certificate inspection for the Preview center. The verifier accepts
/// the leaf only so this function can display its fingerprint; this connection
/// sends no HTTP/WebSocket request and is never used for service traffic.
#[derive(Debug)]
struct InspectLeaf {
    provider: Arc<rustls::crypto::CryptoProvider>,
}
impl ServerCertVerifier for InspectLeaf {
    fn verify_server_cert(
        &self,
        _: &CertificateDer<'_>,
        _: &[CertificateDer<'_>],
        _: &ServerName<'_>,
        _: &[u8],
        _: UnixTime,
    ) -> Result<ServerCertVerified, Error> {
        Ok(ServerCertVerified::assertion())
    }
    fn verify_tls12_signature(&self, message: &[u8], cert: &CertificateDer<'_>, dss: &DigitallySignedStruct) -> Result<HandshakeSignatureValid, Error> {
        rustls::crypto::verify_tls12_signature(message, cert, dss, &self.provider.signature_verification_algorithms)
    }
    fn verify_tls13_signature(&self, message: &[u8], cert: &CertificateDer<'_>, dss: &DigitallySignedStruct) -> Result<HandshakeSignatureValid, Error> {
        rustls::crypto::verify_tls13_signature(message, cert, dss, &self.provider.signature_verification_algorithms)
    }
    fn supported_verify_schemes(&self) -> Vec<SignatureScheme> {
        self.provider.signature_verification_algorithms.supported_schemes()
    }
}

pub async fn inspect_https_certificate(origin: &str) -> Result<String, String> {
    let url = Url::parse(origin).map_err(|_| "Invalid HTTPS service address")?;
    if url.scheme() != "https" || url.host_str().is_none() || !url.username().is_empty() || url.password().is_some()
        || !url.path().is_empty() && url.path() != "/" || url.query().is_some() || url.fragment().is_some() {
        return Err("Certificate inspection requires an exact HTTPS origin".into());
    }
    let host = url.host_str().unwrap().to_owned();
    let port = url.port_or_known_default().ok_or("Invalid HTTPS service port")?;
    let provider = Arc::new(rustls::crypto::ring::default_provider());
    let config = rustls::ClientConfig::builder_with_provider(provider.clone())
        .with_safe_default_protocol_versions().map_err(|_| "Unable to configure certificate inspection")?
        .dangerous().with_custom_certificate_verifier(Arc::new(InspectLeaf { provider }))
        .with_no_client_auth();
    let connect = async {
        let addresses: Vec<SocketAddr> = tokio::net::lookup_host((host.as_str(), port)).await
            .map_err(|_| "Unable to resolve HTTPS service address")?.collect();
        let mut last_error = "Unable to connect to HTTPS service";
        for address in addresses {
            let Ok(stream) = TcpStream::connect(address).await else { continue; };
            let server_name = ServerName::try_from(host.clone()).map_err(|_| "Invalid HTTPS service host")?;
            match TlsConnector::from(Arc::new(config.clone())).connect(server_name, stream).await {
                Ok(stream) => {
                    let certificate = stream.get_ref().1.peer_certificates().and_then(|chain| chain.first())
                        .ok_or("HTTPS service did not present a certificate")?;
                    return Ok(hex::encode(Sha256::digest(certificate.as_ref())));
                }
                Err(_) => last_error = "Unable to complete HTTPS certificate inspection",
            }
        }
        Err(last_error.into())
    };
    timeout(Duration::from_secs(5), connect).await.map_err(|_| "HTTPS certificate inspection timed out")?
}
pub fn normalize_pin(value: &str) -> Result<String, String> {
    let normalized = value.replace(':', "").to_lowercase();
    if normalized.len() != 64 || hex::decode(&normalized).is_err() {
        return Err(
            "Enter the certificate SHA-256 fingerprint (64 hex digits), verified independently"
                .into(),
        );
    }
    Ok(normalized)
}
pub fn client(pin: Option<&str>) -> Result<Arc<rustls::ClientConfig>, String> {
    let provider = Arc::new(rustls::crypto::ring::default_provider());
    let builder = rustls::ClientConfig::builder_with_provider(provider.clone())
        .with_safe_default_protocol_versions()
        .map_err(|e| e.to_string())?;
    let result = if let Some(pin) = pin {
        let fingerprint = hex::decode(normalize_pin(pin)?).unwrap();
        builder
            .dangerous()
            .with_custom_certificate_verifier(Arc::new(PinnedLeaf {
                fingerprint,
                provider,
            }))
            .with_no_client_auth()
    } else {
        let mut roots =
            rustls::RootCertStore::from_iter(webpki_roots::TLS_SERVER_ROOTS.iter().cloned());
        // Honor the machine's system roots, including user-installed local CAs.
        // A failed root load does not disable leaf/hostname/signature verification.
        for certificate in rustls_native_certs::load_native_certs().certs {
            let _ = roots.add(certificate);
        }
        builder.with_root_certificates(roots).with_no_client_auth()
    };
    Ok(Arc::new(result))
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn exact_leaf_and_handshake_signature_required() {
        let cert = rcgen::generate_simple_self_signed(vec!["localhost".into()])
            .unwrap()
            .cert
            .der()
            .clone();
        let pin = hex::encode(Sha256::digest(cert.as_ref()));
        let verifier = PinnedLeaf {
            fingerprint: hex::decode(pin).unwrap(),
            provider: Arc::new(rustls::crypto::ring::default_provider()),
        };
        let host = ServerName::try_from("localhost").unwrap();
        assert!(verifier
            .verify_server_cert(&cert, &[], &host, &[], UnixTime::now())
            .is_ok());
        assert!(verifier
            .verify_server_cert(
                &CertificateDer::from(vec![1, 2, 3]),
                &[],
                &host,
                &[],
                UnixTime::now()
            )
            .is_err());
        assert!(!verifier.supported_verify_schemes().is_empty());
    }
}

#[cfg(test)]
mod inspection_tests {
 use super::*;
 use rustls::pki_types::PrivatePkcs8KeyDer;
 #[tokio::test]
 async fn inspect_self_signed_does_not_relax_normal_tls_or_changed_pin() {
  let generated=rcgen::generate_simple_self_signed(vec!["localhost".into()]).unwrap();
  let certificate=generated.cert.der().clone();let pin=hex::encode(Sha256::digest(certificate.as_ref()));
  let server=rustls::ServerConfig::builder_with_provider(Arc::new(rustls::crypto::ring::default_provider()))
   .with_safe_default_protocol_versions().unwrap().with_no_client_auth()
   .with_single_cert(vec![certificate],PrivatePkcs8KeyDer::from(generated.signing_key.serialize_der()).into()).unwrap();
  let listener=tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();let address=listener.local_addr().unwrap();
  let task=tokio::spawn(async move {
   let acceptor=tokio_rustls::TlsAcceptor::from(Arc::new(server));
   for _ in 0..4 {let(socket,_)=listener.accept().await.unwrap();let _=acceptor.accept(socket).await;}
  });
  assert_eq!(inspect_https_certificate(&format!("https://{address}")).await.unwrap(),pin);
  for (configured,accepted) in [(None,false),(Some(pin.as_str()),true),(Some("b".repeat(64)).as_deref(),false)] {
   let socket=TcpStream::connect(address).await.unwrap();
   let result=TlsConnector::from(client(configured).unwrap()).connect(ServerName::try_from("localhost").unwrap(),socket).await;
   assert_eq!(result.is_ok(),accepted);
  }
  timeout(Duration::from_secs(5),task).await.unwrap().unwrap();
 }
 #[tokio::test]
 async fn inspection_rejects_non_origin_or_secret_bearing_addresses() {
  for address in ["http://localhost", "https://user:secret@localhost", "https://localhost/path", "https://localhost?token=secret", "https://localhost/#secret"] {
   assert!(inspect_https_certificate(address).await.is_err());
  }
 }
}
