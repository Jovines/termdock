//! Only a build-pinned Preview manifest/key can select application updates.
//! Service pages cannot configure endpoints or replace trust keys.
use serde_json::{json, Value};
use std::{
    sync::Mutex,
    time::{SystemTime, UNIX_EPOCH},
};
use tauri::AppHandle;
use tauri_plugin_updater::{Update, UpdaterExt};

// Plugin setup must never depend on release material. The update endpoint/key
// are build-pinned and validated only when checking; empty values grant no trust.
fn safe_plugin_config() -> Value {
    json!({"pubkey":"","endpoints":[],"requireSignedVersion":true})
}
pub(crate) fn prepare_startup(config: &mut tauri::Config) -> Option<String> {
    let supplied = config
        .plugins
        .0
        .get("updater")
        .cloned()
        .unwrap_or(Value::Null);
    let parsed = serde_json::from_value::<tauri_plugin_updater::Config>(supplied);
    let diagnostic=match parsed {
        Ok(c) if c.endpoints.is_empty() && c.pubkey.is_empty() && c.require_signed_version && !c.dangerous_accept_invalid_certs && !c.dangerous_accept_invalid_hostnames && !c.dangerous_insecure_transport_protocol && !c.allow_downgrades => None,
        Ok(_) => Some("Updater startup options are build-owned; using safe defaults. Preview release configuration is checked separately.".into()),
        Err(_) => Some("Invalid updater startup configuration; using safe defaults. No update asset will be accepted without a valid Preview channel.".into()),
    };
    config
        .plugins
        .0
        .insert("updater".into(), safe_plugin_config());
    diagnostic
}
fn channel(endpoint: Option<&str>, key: Option<&str>) -> Result<(url::Url, String), String> {
    use base64::Engine;
    let endpoint = endpoint
        .filter(|v| !v.trim().is_empty())
        .ok_or("Preview 更新渠道尚未配置，请由发布构建提供独立 manifest 与公钥")?;
    let key = key
        .filter(|v| !v.trim().is_empty())
        .ok_or("Preview 更新签名公钥尚未配置")?;
    let endpoint = url::Url::parse(endpoint).map_err(|_| "Preview 更新地址格式无效")?;
    if endpoint.scheme() != "https"
        || !endpoint.username().is_empty()
        || endpoint.password().is_some()
        || endpoint.fragment().is_some()
        || !endpoint.path().contains("preview")
    {
        return Err("更新地址必须是独立 Preview HTTPS 渠道".into());
    }
    let decoded = base64::engine::general_purpose::STANDARD
        .decode(key)
        .map_err(|_| "Preview 更新签名公钥格式无效")?;
    let text = std::str::from_utf8(&decoded).map_err(|_| "Preview 更新签名公钥格式无效")?;
    minisign_verify::PublicKey::decode(text).map_err(|_| "Preview 更新签名公钥格式无效")?;
    Ok((endpoint, key.to_owned()))
}
pub struct Updater {
    state: Mutex<Value>,
    pending: Mutex<Option<(Update, Vec<u8>)>>,
    operation: tokio::sync::Mutex<()>,
}
impl Updater {
    pub fn new(version: &str) -> Self {
        Self {
            state: Mutex::new(
                json!({"status":"idle","currentVersion":version,"latestVersion":null,"releaseName":null,"checkedAt":null,"error":null}),
            ),
            pending: Mutex::new(None),
            operation: tokio::sync::Mutex::new(()),
        }
    }
    pub fn snapshot(&self) -> Value {
        self.state.lock().unwrap().clone()
    }
    fn publish<R: tauri::Runtime>(
        &self,
        app: &AppHandle<R>,
        status: &str,
        error: Option<String>,
    ) -> Value {
        let snapshot = {
            let mut value = self.state.lock().unwrap();
            value["status"] = json!(status);
            value["error"] = json!(error);
            value.clone()
        };
        crate::shell::announce(app, "termdock:preview-update", snapshot.clone());
        snapshot
    }
    pub async fn check<R: tauri::Runtime>(&self, app: &AppHandle<R>) -> Value {
        self.check_channel(
            app,
            channel(
                option_env!("TERMDOCK_PREVIEW_UPDATE_ENDPOINT"),
                option_env!("TERMDOCK_PREVIEW_UPDATE_PUBLIC_KEY"),
            ),
        )
        .await
    }
    async fn check_channel<R: tauri::Runtime>(
        &self,
        app: &AppHandle<R>,
        configured: Result<(url::Url, String), String>,
    ) -> Value {
        let _operation = self.operation.lock().await;
        self.publish(app, "checking", None);
        self.state.lock().unwrap()["checkedAt"] = json!(SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis() as u64);
        self.pending.lock().unwrap().take();
        let result = async {
            // No default stable GitHub feed. Missing Preview release material is
            // a visible error, never "current"/"unsupported" pretending parity.
            let (endpoint, key) = configured?;
            let updater = app
                .updater_builder()
                .pubkey(key)
                .endpoints(vec![endpoint])
                .map_err(|e| e.to_string())?
                .timeout(std::time::Duration::from_secs(30))
                .build()
                .map_err(|e| e.to_string())?;
            let Some(update) = updater.check().await.map_err(|e| e.to_string())? else {
                return Ok(false);
            };
            let filename = update
                .download_url
                .path()
                .rsplit('/')
                .next()
                .unwrap_or("")
                .to_lowercase();
            if update.download_url.scheme() != "https"
                || !filename.contains("preview")
                || !filename.ends_with(".app.tar.gz")
            {
                return Err(
                    "更新资产必须是签名的 Termdock Preview .app.tar.gz；拒绝稳定 Electron 包"
                        .into(),
                );
            }
            {
                let mut state = self.state.lock().unwrap();
                state["latestVersion"] = json!(update.version);
                state["releaseName"] = json!(format!("Termdock Preview {}", update.version));
            }
            self.publish(app, "downloading", None);
            let bytes = update
                .download(|_, _| {}, || {})
                .await
                .map_err(|e| e.to_string())?;
            // download verifies the minisign signature before these bytes become
            // installable; validate Preview bundle identity before making it ready.
            crate::update_artifact::validate(&bytes, &update.version)?;
            *self.pending.lock().unwrap() = Some((update, bytes));
            Ok(true)
        }
        .await;
        match result {
            Ok(true) => self.publish(app, "ready", None),
            Ok(false) => self.publish(app, "current", None),
            Err(error) => self.publish(app, "error", Some(error)),
        }
    }
    pub async fn install<R: tauri::Runtime>(&self, app: &AppHandle<R>) -> Value {
        let _operation = self.operation.lock().await;
        let Some((update, bytes)) = self.pending.lock().unwrap().take() else {
            return self.publish(
                app,
                "error",
                Some("尚无已验证可安装的 Preview 更新，请先检查更新".into()),
            );
        };
        self.publish(app, "installing", None);
        match update.install(bytes) {
            Ok(()) => {
                app.request_restart();
                self.snapshot()
            }
            Err(error) => self.publish(app, "error", Some(error.to_string())),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn public_test_key() -> String {
        use base64::Engine;
        // Public-only vector from the locked minisign-verify crate; no private
        // key is generated, stored or bundled.
        base64::engine::general_purpose::STANDARD.encode("untrusted comment: minisign public key\nRWQf6LRCGA9i53mlYecO4IzT51TGPpvWucNSCh1CBM0QTaLn73Y7GFO3")
    }
    fn production_context() -> tauri::Context<tauri::test::MockRuntime> {
        let mut context = tauri::test::mock_context(tauri::test::noop_assets());
        let generated: tauri::Context<tauri::Wry> = tauri::generate_context!();
        *context.config_mut() = generated.config().clone();
        context
    }
    #[test]
    fn real_plugin_initializes_from_default_production_context_without_a_channel() {
        let context = production_context();
        let parsed: tauri_plugin_updater::Config =
            serde_json::from_value(context.config().plugins.0["updater"].clone()).unwrap();
        assert!(parsed.pubkey.is_empty());
        assert!(parsed.endpoints.is_empty());
        assert!(parsed.require_signed_version);
        let _app = tauri::test::mock_builder()
            .plugin(tauri_plugin_updater::Builder::new().build())
            .build(context)
            .expect("production updater must initialize without release material");
    }
    #[test]
    fn exact_missing_config_regression_is_reproduced_by_the_real_plugin() {
        let mut context = production_context();
        context.config_mut().plugins.0.remove("updater");
        match tauri::test::mock_builder()
            .plugin(tauri_plugin_updater::Builder::new().build())
            .build(context)
        {
            Err(tauri::Error::PluginInitialization(name, error)) => {
                assert_eq!(name, "updater");
                assert!(error.to_string().contains("invalid type: null"));
            }
            _ => panic!("missing updater config must reproduce the observed production failure"),
        }
    }
    #[test]
    fn real_plugin_recovers_missing_null_and_malformed_config_with_a_diagnostic() {
        for supplied in [
            Value::Null,
            json!({}),
            json!({"pubkey":"","endpoints":["not-a-url"]}),
            json!({"pubkey":"invalid","endpoints":["http://unsafe/preview"]}),
            json!({"pubkey":"bad","endpoints":["https://example.test/preview"],"dangerousAcceptInvalidCerts":true}),
        ] {
            let mut context = production_context();
            context
                .config_mut()
                .plugins
                .0
                .insert("updater".into(), supplied);
            assert!(prepare_startup(context.config_mut()).is_some());
            let _app = tauri::test::mock_builder()
                .plugin(tauri_plugin_updater::Builder::new().build())
                .build(context)
                .expect("bad updater config must not abort the base client");
        }
    }
    #[tokio::test]
    async fn missing_or_bad_channel_reports_error_without_installable_assets() {
        for (endpoint, key) in [
            (None, None),
            (Some(""), Some("")),
            (Some("http://example.test/preview"), Some("invalid")),
            (Some("https://example.test/preview"), Some("invalid")),
        ] {
            let app = tauri::test::mock_builder()
                .plugin(tauri_plugin_updater::Builder::new().build())
                .build(production_context())
                .unwrap();
            let updater = Updater::new("0.1.0");
            let state = updater
                .check_channel(app.handle(), channel(endpoint, key))
                .await;
            assert_eq!(state["status"], "error");
            assert!(state["error"].as_str().is_some_and(|s| !s.is_empty()));
            assert!(updater.pending.lock().unwrap().is_none());
            assert_eq!(updater.install(app.handle()).await["status"], "error");
        }
    }
    #[test]
    fn absent_valid_and_invalid_release_material_do_not_control_plugin_startup() {
        let key = public_test_key();
        for (endpoint, key, valid) in [
            (None, None, false),
            (Some(""), Some(""), false),
            (
                Some("https://example.test/preview/manifest.json"),
                Some(key.as_str()),
                true,
            ),
            (
                Some("http://example.test/preview"),
                Some(key.as_str()),
                false,
            ),
            (
                Some("https://example.test/stable"),
                Some(key.as_str()),
                false,
            ),
            (
                Some("https://user:pass@example.test/preview"),
                Some(key.as_str()),
                false,
            ),
            (Some("https://example.test/preview"), Some("bad key"), false),
        ] {
            assert_eq!(channel(endpoint, key).is_ok(), valid);
            let mut context = production_context();
            assert!(prepare_startup(context.config_mut()).is_none());
            let _app = tauri::test::mock_builder()
                .plugin(tauri_plugin_updater::Builder::new().build())
                .build(context)
                .unwrap();
        }
    }
}
