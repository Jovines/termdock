//! One-time Preview handoff. Copy bookmarks/preferences, never authentication or
//! certificate trust. Source configurations are retained with private backups.
use crate::config::Config;
use std::{fs, io::Write, path::Path};

fn backup(file: &Path) -> Result<(), String> {
    if !file.exists() { return Ok(()); }
    let target = file.with_extension(format!("before-rust-{}.json", uuid::Uuid::new_v4()));
    let mut options = fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)] {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    options.open(target).and_then(|mut output| output.write_all(&fs::read(file)?))
        .map_err(|e| e.to_string())
}
fn version_number(value: &str) -> Result<[u64; 3], String> {
    let parts=value.split('.').map(str::parse::<u64>).collect::<Result<Vec<_>,_>>().map_err(|_|"Invalid installed application version")?;
    parts.try_into().map_err(|_|"Invalid installed application version".into())
}
/// The GUI is closed before invalidating the one-time import marker. Existing
/// stable preferences, removals and certificate trust are still preserved.
pub fn prepare_handoff(file: &Path) -> Result<(), String> {
    if !file.exists() { return Ok(()); }
    let mut config=Config::load(file,&file.with_extension("no-legacy-import"))?;
    backup(file)?;
    config.imported_preview=false;
    config.persist(file)
}

pub fn load_configuration(file: &Path, electron: &Path, preview: &Path) -> Result<Config, String> {
    let existing = file.exists();
    let mut config = Config::load(file, electron)?;
    if config.imported_preview { return Ok(config); }
    // Back up both sources before the destination is persisted by the caller.
    backup(file)?;
    backup(electron)?;
    if preview.exists() {
        if fs::metadata(preview).map_err(|e| e.to_string())?.len() > 4 * 1024 * 1024 {
            return Err("Preview 配置过大；已保留原文件，请从备份恢复".into());
        }
        let previous = Config::load(preview, &preview.with_extension("no-legacy-import"))?;
        backup(preview)?;
        if !existing {
            config.desktop_preferences = previous.desktop_preferences.clone();
        }
        for connection in previous.connections {
            if config.connections.iter().any(|c| c.key() == connection.key()) { continue; }
            let id = connection.id.clone();
            config.save_connection(connection, false);
            if !config.connections.iter().any(|c| c.id == id) { continue; }
            if let Some(at) = previous.last_connected.get(&id) { config.last_connected.insert(id.clone(), *at); }
            if previous.open_connections.contains(&id) && !config.open_connections.contains(&id) {
                config.open_connections.push(id);
            }
        }
        // No ports, device keys, profile IDs, cookies or certificate pins cross
        // application identities. A new WKWebView profile reauthorizes normally.
    }
    config.imported_preview = true;
    Ok(config)
}

/// Rename only on the same filesystem. On failure the original target is restored.
/// The caller has already verified the signed App and copied the old App to Trash.
pub fn replace_bundle(staged: &Path, target: &Path, rollback: &Path) -> Result<(), String> {
    if rollback.exists() || !staged.is_dir() || staged.is_symlink() || target.is_symlink() {
        return Err("Unsafe application replacement paths".into());
    }
    let existed = target.exists();
    if existed { fs::rename(target, rollback).map_err(|e| e.to_string())?; }
    if let Err(error) = fs::rename(staged, target) {
        if existed {
            fs::rename(rollback, target).map_err(|restore| format!("安装失败：{error}；旧应用保留在 {}，恢复失败：{restore}", rollback.display()))?;
        }
        return Err(error.to_string());
    }
    Ok(())
}

#[cfg(all(feature = "desktop", target_os = "macos"))]
pub async fn install_stable<R: tauri::Runtime>(app: &tauri::AppHandle<R>, bytes: Vec<u8>, version: String) -> Result<(), String> {
    use tauri::Manager;
    crate::update_artifact::validate_stable(&bytes, &version)?;
    let current = app.path().resource_dir().map_err(|e| e.to_string())?
        .parent().and_then(|p| p.parent()).ok_or("Missing application bundle")?.to_owned();
    if current.extension().and_then(|s| s.to_str()) != Some("app") { return Err("请从已安装的 Preview 应用执行迁移".into()); }
    let parent = current.parent().ok_or("Missing application directory")?;
    let temporary = tempfile::Builder::new().prefix(".termdock-migration-").tempdir_in(parent).map_err(|e| format!("应用目录不可写；请将正式版安装到此目录后重试：{e}"))?;
    let mut archive = tar::Archive::new(flate2::read::GzDecoder::new(std::io::Cursor::new(bytes)));
    archive.unpack(temporary.path()).map_err(|e| e.to_string())?;
    let staged = temporary.path().join("Termdock.app");
    fn command(tool: &str, args: &[&std::ffi::OsStr]) -> Result<String, String> {
        let out = std::process::Command::new(tool).args(args).output().map_err(|e| e.to_string())?;
        if !out.status.success() { return Err(format!("{tool}: {}", String::from_utf8_lossy(&out.stderr))); }
        Ok(format!("{}{}", String::from_utf8_lossy(&out.stdout), String::from_utf8_lossy(&out.stderr)))
    }
    command("/usr/bin/codesign", &["--verify".as_ref(), "--deep".as_ref(), "--strict".as_ref(), staged.as_os_str()])?;
    let identity = command("/usr/bin/codesign", &["-dv".as_ref(), "--verbose=4".as_ref(), staged.as_os_str()])?;
    let own = command("/usr/bin/codesign", &["-dv".as_ref(), "--verbose=4".as_ref(), current.as_os_str()])?;
    let team = |text: &str| text.lines().find_map(|l| l.strip_prefix("TeamIdentifier=")).filter(|s| *s != "not set").map(str::to_owned);
    if team(&identity).is_none() || team(&identity) != team(&own) || !identity.contains("Authority=Developer ID Application:") {
        return Err("正式版与 Preview 的 Developer ID 团队不匹配".into());
    }
    command("/usr/bin/xcrun", &["stapler".as_ref(), "validate".as_ref(), staged.as_os_str()])?;
    command("/usr/sbin/spctl", &["-a".as_ref(), "-t".as_ref(), "exec".as_ref(), staged.as_os_str()])?;
    let target = parent.join("Termdock.app");
    if target.is_symlink() { return Err("请将正式版安装到真实应用目录后重试迁移".into()); }
    let reuse=if target.exists() {
        let info=plist::Value::from_file(target.join("Contents/Info.plist")).map_err(|e|e.to_string())?;
        let info=info.as_dictionary().ok_or("Invalid installed App plist")?;
        if info.get("CFBundleIdentifier").and_then(|v|v.as_string())!=Some("com.jovines.termdock") { return Err("目标位置已有其他应用；已保留原应用".into()); }
        version_number(info.get("CFBundleShortVersionString").and_then(|v|v.as_string()).ok_or("Missing installed App version")?)? >= version_number(&version)?
    } else { false };
    if reuse {
        command("/usr/bin/codesign", &["--verify".as_ref(),"--deep".as_ref(),"--strict".as_ref(),target.as_os_str()])?;
        let existing=command("/usr/bin/codesign", &["-dv".as_ref(),"--verbose=4".as_ref(),target.as_os_str()])?;
        if team(&existing)!=team(&own) { return Err("已安装正式版的签名团队不匹配".into()); }
        command("/usr/sbin/spctl", &["-a".as_ref(),"-t".as_ref(),"exec".as_ref(),target.as_os_str()])?;
    }
    // Ask only the other GUI to quit. Detached services and PTYs are untouched.
    crate::native_desktop::close_stable(app).await?;
    let own_config=app.path().app_config_dir().map_err(|e|e.to_string())?;
    prepare_handoff(&own_config.parent().ok_or("Missing application support directory")?.join("com.jovines.termdock/connections.json"))?;
    let trash = std::path::PathBuf::from(std::env::var_os("HOME").ok_or("Missing home directory")?).join(".Trash");
    fs::create_dir_all(&trash).map_err(|e| e.to_string())?;
    let saved = trash.join(format!("Termdock-before-rust-{}.app", uuid::Uuid::new_v4()));
    if !reuse && target.exists() {
        command("/usr/bin/ditto", &[target.as_os_str(), saved.as_os_str()])?;
        eprintln!("Termdock migration backup: {}", saved.display());
    }
    let rollback = temporary.path().join("previous.app");
    if !reuse {
        if let Err(error)=replace_bundle(&staged, &target, &rollback) {
            if rollback.exists() && !target.exists() {
                let preserved=temporary.keep();
                return Err(format!("{error}；恢复目录已保留：{}",preserved.display()));
            }
            return Err(error);
        }
    }
    let launched=match command("/usr/bin/open", &["-n".as_ref(), target.as_os_str()]) {
        Ok(_) => crate::native_desktop::wait_stable(app).await,
        Err(error) => Err(error),
    };
    if let Err(error) = launched {
        if reuse { return Err(error); }
        // Never strand the user after a launch failure.
        crate::native_desktop::close_stable(app).await?;
        let failed = temporary.path().join("failed.app");
        fs::rename(&target, failed).map_err(|e| e.to_string())?;
        if rollback.exists() { fs::rename(&rollback, &target).map_err(|e| e.to_string())?; }
        return Err(error);
    }
    let previous_preview = trash.join(format!("Termdock-Preview-before-stable-{}.app", uuid::Uuid::new_v4()));
    // Keep the previous signed Preview recoverable, while its old app path no
    // longer offers a second client after the explicit migration succeeds.
    match fs::rename(&current, &previous_preview) {
        Ok(()) => eprintln!("Termdock Preview backup: {}", previous_preview.display()),
        Err(error) => eprintln!("Termdock installed; Preview cleanup deferred: {error}"),
    }
    app.exit(0);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn merges_once_preserving_stable_choices_and_both_sources_without_transferring_trust() {
        let dir = tempfile::tempdir().unwrap();
        let target=dir.path().join("stable/connections.json");
        let electron=dir.path().join("desktop.json");
        let preview=dir.path().join("preview.json");
        let old = r#"{"connections":[{"id":"old","url":"https://one.test","label":"Electron","routes":[]}]}"#;
        let prior = r#"{"connections":[{"id":"p","url":"https://two.test","label":"Preview","routes":[]}],"certificatePins":{"https://two.test":"secret"},"ports":{"p":1234},"desktopPreferences":{"menuBarStatusEnabled":false}}"#;
        fs::write(&electron,old).unwrap();fs::write(&preview,prior).unwrap();
        let config=load_configuration(&target,&electron,&preview).unwrap();
        assert_eq!(config.connections.len(),2);assert!(config.certificate_pins.is_empty());assert!(config.ports.is_empty());assert!(!config.desktop_preferences.menu_bar_status_enabled);
        config.persist(&target).unwrap();
        fs::write(&preview,"invalid").unwrap();
        assert_eq!(load_configuration(&target,&electron,&preview).unwrap().connections.len(),2);
        assert_eq!(fs::read_to_string(&electron).unwrap(),old);
        assert!(fs::read_dir(dir.path()).unwrap().filter_map(Result::ok).any(|e|e.file_name().to_string_lossy().contains("before-rust")));
    }
    #[test]
    fn failed_replacement_restores_original_and_first_install_requires_no_old_app() {
        let dir=tempfile::tempdir().unwrap();let target=dir.path().join("Termdock.app");let staged=dir.path().join("new.app");let rollback=dir.path().join("old.app");
        fs::create_dir(&staged).unwrap();fs::write(staged.join("identity"),"rust").unwrap();
        replace_bundle(&staged,&target,&rollback).unwrap();assert_eq!(fs::read_to_string(target.join("identity")).unwrap(),"rust");
        assert!(replace_bundle(&staged,&target,&rollback).is_err());assert!(target.exists());
        let nested=target.join("nested.app");fs::create_dir(&nested).unwrap();
        assert!(replace_bundle(&nested,&target,&rollback).is_err());
        assert_eq!(fs::read_to_string(target.join("identity")).unwrap(),"rust");assert!(!rollback.exists());
    }
    #[test]
    fn explicit_handoff_reimports_new_preview_connections_without_overriding_stable_choices() {
        let dir=tempfile::tempdir().unwrap();let file=dir.path().join("stable/connections.json");let preview=dir.path().join("preview.json");let electron=dir.path().join("legacy.json");
        let mut config=Config::default();config.imported_preview=true;config.desktop_preferences.menu_bar_status_enabled=true;config.persist(&file).unwrap();
        fs::write(&preview,r#"{"connections":[{"id":"new","url":"https://new.test","label":"New","routes":[]}],"desktopPreferences":{"menuBarStatusEnabled":false}}"#).unwrap();
        prepare_handoff(&file).unwrap();let merged=load_configuration(&file,&electron,&preview).unwrap();
        assert_eq!(merged.connections.len(),1);assert!(merged.desktop_preferences.menu_bar_status_enabled);
        assert!(version_number("1.4.359").unwrap()>version_number("1.4.358").unwrap());assert!(version_number("invalid").is_err());
    }
}
