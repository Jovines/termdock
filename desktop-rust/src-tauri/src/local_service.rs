//! Reuse the standalone Node daemon. Detection never installs, stops or takes
//! ownership of a service; only an explicit center action can prepare one.
use crate::{config::origin, proxy};
use base64::Engine;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{collections::BTreeMap, fs, path::PathBuf, time::Duration};
use tokio::{net::TcpStream, process::Command};

pub fn home() -> Result<PathBuf, String> {
    std::env::var_os("HOME")
        .map(PathBuf::from)
        .ok_or("Missing home directory".into())
}
pub fn metadata() -> Option<Value> {
    let raw: Value =
        serde_json::from_slice(&fs::read(home().ok()?.join(".termdock/server.json")).ok()?).ok()?;
    let port = raw
        .get("port")?
        .as_u64()
        .filter(|p| *p > 0 && *p <= 65535)?;
    let scheme = if raw["scheme"] == "https" {
        "https"
    } else {
        "http"
    };
    // server.json may contain an API token. Return only public daemon metadata.
    Some(
        json!({"pid":raw["pid"],"host":raw["host"],"port":port,"scheme":scheme,"localUrl":format!("{scheme}://127.0.0.1:{port}"),"startedAt":raw["startedAt"]}),
    )
}
pub fn local_pin(address: &str) -> Option<String> {
    let state = metadata()?;
    if origin(address).ok()? != state["localUrl"].as_str()? || state["scheme"] != "https" {
        return None;
    }
    let pem = fs::read_to_string(home().ok()?.join(".termdock/certs/termdock-local.pem")).ok()?;
    let raw = pem
        .split("-----BEGIN CERTIFICATE-----")
        .nth(1)?
        .split("-----END CERTIFICATE-----")
        .next()?;
    let der = base64::engine::general_purpose::STANDARD
        .decode(raw.split_whitespace().collect::<String>())
        .ok()?;
    Some(hex::encode(Sha256::digest(der)))
}
pub async fn probe(address: &str, pins: &BTreeMap<String, String>) -> Value {
    let Ok(address) = origin(address) else {
        return json!({"ok":false,"url":address,"error":"请输入 Termdock 服务首页地址"});
    };
    let local = local_pin(&address);
    let result:Result<Value,String> = async {
        let source = proxy::upstream(address.clone(), pins.get(&address).or(local.as_ref()).map(String::as_str))?;
        let response = source.http.get(format!("{address}/api/meta")).timeout(Duration::from_secs(5)).send().await.map_err(|e| e.to_string())?;
        if !response.status().is_success() { return Err("服务暂不可用，请检查地址与网络".into()); }
        let bytes = response.bytes().await.map_err(|e| e.to_string())?;
        if bytes.len() > 64 * 1024 { return Err("Invalid service metadata".into()); }
        let meta: Value = serde_json::from_slice(&bytes).map_err(|e| e.to_string())?;
        proxy::validate_metadata(&meta)?;
        Ok(json!({"ok":true,"url":address,"version":meta["version"],"protocolVersion":meta["protocolVersion"]}))
    }.await;
    match result {
        Ok(value) => value,
        Err(error) => json!({"ok":false,"url":address,"error":error}),
    }
}
async fn paths() -> Vec<PathBuf> {
    // Retry must detect runtimes installed while this window is open.
    // Keep discovery read-only and bounded rather than caching a missing Node.
    async {
        let mut dirs = Vec::new();
        let home = home().unwrap_or_default();
        dirs.push(home.join(".termdock/cli/bin"));
        // Finder's PATH omits nvm/fnm. Read only the login shell PATH, bounded.
        let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".into());
        if let Ok(Ok(out)) = tokio::time::timeout(
            Duration::from_secs(5),
            Command::new(shell)
                .args(["-ilc", "printf '\\nTERMDOCK_SETUP_PATH=%s\\n' \"$PATH\""])
                .kill_on_drop(true)
                .output(),
        )
        .await
        {
            if let Some(line) = String::from_utf8_lossy(&out.stdout)
                .lines()
                .find_map(|l| l.strip_prefix("TERMDOCK_SETUP_PATH="))
            {
                dirs.extend(std::env::split_paths(line));
            }
        }
        dirs.extend(std::env::split_paths(
            &std::env::var_os("PATH").unwrap_or_default(),
        ));
        dirs.extend(
            [
                "/opt/homebrew/bin",
                "/usr/local/bin",
                "/usr/bin",
                "/bin",
                "/opt/homebrew/opt/node@22/bin",
                "/usr/local/opt/node@22/bin",
                "/opt/homebrew/opt/node@24/bin",
                "/usr/local/opt/node@24/bin",
            ]
            .into_iter()
            .map(PathBuf::from),
        );
        dirs.extend([home.join(".local/bin"), home.join(".volta/bin")]);
        for (root, suffix) in [
            (home.join(".nvm/versions/node"), "bin"),
            (
                home.join(".local/share/fnm/node-versions"),
                "installation/bin",
            ),
            (home.join(".fnm/node-versions"), "installation/bin"),
            (home.join(".asdf/installs/nodejs"), "bin"),
            (home.join(".volta/tools/image/node"), "bin"),
        ] {
            if let Ok(entries) = fs::read_dir(root) {
                let mut rows = entries.flatten().map(|e| e.path()).collect::<Vec<_>>();
                rows.sort();
                rows.reverse();
                dirs.extend(rows.into_iter().map(|p| p.join(suffix)));
            }
        }
        let mut unique = Vec::new();
        for p in dirs {
            if p.is_absolute() && !unique.contains(&p) {
                unique.push(p);
            }
        }
        unique
    }
    .await
}
fn cli(dirs: &[PathBuf]) -> Option<PathBuf> {
    for dir in dirs {
        let Ok(path) = fs::canonicalize(dir.join("termdock")) else {
            continue;
        };
        if path.to_string_lossy().contains(".app/Contents/") {
            continue;
        }
        let Some(root) = path
            .parent()
            .and_then(|p| p.parent())
            .and_then(|p| p.parent())
        else {
            continue;
        };
        let Ok(bytes) = fs::read(root.join("package.json")) else {
            continue;
        };
        let Ok(meta) = serde_json::from_slice::<Value>(&bytes) else {
            continue;
        };
        if meta["name"] == "termdock"
            && meta["bin"]["termdock"]
                .as_str()
                .is_some_and(|p| fs::canonicalize(root.join(p)).ok().as_ref() == Some(&path))
        {
            return Some(path);
        }
    }
    None
}
async fn node(dirs: &[PathBuf]) -> Option<(PathBuf, String)> {
    for dir in dirs {
        let Ok(path) = fs::canonicalize(dir.join("node")) else {
            continue;
        };
        if let Ok(Ok(out)) = tokio::time::timeout(
            Duration::from_secs(3),
            Command::new(&path)
                .arg("--version")
                .kill_on_drop(true)
                .output(),
        )
        .await
        {
            let version = String::from_utf8_lossy(&out.stdout).trim().to_owned();
            if version
                .trim_start_matches('v')
                .split('.')
                .next()
                .and_then(|v| v.parse::<u32>().ok())
                .is_some_and(|v| v >= 22)
            {
                return Some((path, version));
            }
        }
    }
    None
}
pub async fn status(pins: &BTreeMap<String, String>) -> Value {
    let state = metadata();
    let probe = if let Some(address) = state.as_ref().and_then(|s| s["localUrl"].as_str()) {
        Some(probe(address, pins).await)
    } else {
        None
    };
    let running = probe.as_ref().is_some_and(|p| p["ok"] == true);
    let dirs = paths().await;
    let runtime = node(&dirs).await;
    let cli = cli(&dirs);
    let phase = if running {
        "ready"
    } else if runtime.is_none() {
        "needs-node"
    } else if cli.is_none() {
        "needs-install"
    } else {
        "ready"
    };
    let message = match phase {
        "needs-node" => "需要先安装 Node.js 22 或更新版本",
        "needs-install" => "运行环境已就绪，点击安装本机服务",
        _ if running => "本机服务已就绪，可以打开工作空间",
        _ => "服务已停止，点击启动本机服务",
    };
    json!({"running":running,"state":state,"probe":probe,"setup":{"phase":phase,"message":message,"nodeVersion":runtime.as_ref().map(|r| &r.1),"cliPath":cli}})
}
async fn occupied(port: u16) -> bool {
    match tokio::time::timeout(
        Duration::from_secs(1),
        TcpStream::connect(("127.0.0.1", port)),
    )
    .await
    {
        Ok(Err(_)) => false,
        _ => true,
    }
}
async fn execute(mut command: Command, seconds: u64) -> Result<(), String> {
    let out = tokio::time::timeout(
        Duration::from_secs(seconds),
        command.kill_on_drop(true).output(),
    )
    .await
    .map_err(|_| "命令执行超时，请检查 ~/.termdock/server.log")?
    .map_err(|e| e.to_string())?;
    if out.status.success() {
        Ok(())
    } else {
        let error = String::from_utf8_lossy(&out.stderr);
        Err(error
            .chars()
            .rev()
            .take(8000)
            .collect::<String>()
            .chars()
            .rev()
            .collect())
    }
}
pub async fn prepare(
    pins: &BTreeMap<String, String>,
    install: bool,
    publish: impl Fn(Value),
) -> Result<Value, String> {
    let current = status(pins).await;
    if current["running"] == true {
        return Ok(current);
    }
    let port = current["state"]["port"].as_u64().unwrap_or(9834) as u16;
    if occupied(port).await {
        return Err(
            "已有本机进程正在运行，但服务尚不可用。请稍后重试；Preview 不会停止或接管它。".into(),
        );
    }
    let dirs = paths().await;
    let Some((node, version)) = node(&dirs).await else {
        return Ok(current);
    };
    let home = home()?;
    let env_path = std::env::join_paths(
        std::iter::once(node.parent().unwrap().to_owned()).chain(dirs.clone()),
    )
    .map_err(|e| e.to_string())?;
    let mut entry = cli(&dirs);
    if entry.is_none() && !install {
        return Ok(current);
    }
    if entry.is_none() {
        let npm = dirs
            .iter()
            .filter_map(|d| fs::canonicalize(d.join("npm")).ok())
            .find(|p| p.file_name().is_some_and(|n| n == "npm-cli.js"))
            .ok_or("未找到 npm，请安装包含 npm 的 Node.js")?;
        let prefix = home.join(".termdock/cli");
        fs::create_dir_all(&prefix).map_err(|e| e.to_string())?;
        publish(
            json!({"phase":"installing","message":"正在下载并安装 Termdock，首次安装可能需要几分钟…","nodeVersion":version}),
        );
        let mut command = Command::new(&node);
        command
            .arg(npm)
            .args(["install", "--global", "--prefix"])
            .arg(&prefix)
            .args(["termdock", "--no-audit", "--no-fund"])
            .current_dir(&home)
            .env("PATH", &env_path)
            .env("NO_COLOR", "1");
        execute(command, 600).await?;
        entry = cli(&[prefix.join("bin")]);
    }
    let entry = entry.ok_or("安装后未找到 Termdock CLI")?;
    // Another client may have started the daemon during npm installation.
    let latest = status(pins).await;
    if latest["running"] == true {
        return Ok(latest);
    }
    if occupied(port).await {
        return Err("本机端口已占用，请稍后重试".into());
    }
    publish(
        json!({"phase":"starting","message":"正在启动本机服务…","nodeVersion":version,"cliPath":entry}),
    );
    let mut command = Command::new(&node);
    command
        .arg(entry)
        .current_dir(home)
        .env("PATH", env_path)
        .env("NO_COLOR", "1");
    let launch = execute(command, 120).await;
    for _ in 0..15 {
        let service = status(pins).await;
        if service["running"] == true {
            return Ok(service);
        }
        tokio::time::sleep(Duration::from_secs(1)).await;
    }
    Err(launch
        .err()
        .unwrap_or_else(|| "尚未确认服务启动成功，请检查 ~/.termdock/server.log".into()))
}
