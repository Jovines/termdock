//! Signed updater content must still be the independent Preview application.
use std::io::{Cursor, Read};
pub fn validate(bytes: &[u8], version: &str) -> Result<(), String> {
    let decoder = flate2::read::GzDecoder::new(Cursor::new(bytes));
    let mut archive = tar::Archive::new(decoder);
    let mut valid = false;
    let mut budget = 0u64;
    let mut paths = Vec::<std::path::PathBuf>::new();
    let mut links = Vec::<std::path::PathBuf>::new();
    for entry in archive.entries().map_err(|e| e.to_string())? {
        let mut entry = entry.map_err(|e| e.to_string())?;
        let path = entry.path().map_err(|e| e.to_string())?.into_owned();
        if paths.contains(&path) {
            return Err("Duplicate update archive entry".into());
        }
        if path.is_absolute()
            || path
                .components()
                .any(|p| matches!(p, std::path::Component::ParentDir))
        {
            return Err("Unsafe Preview update archive path".into());
        }
        let name = path.to_string_lossy();
        let name = name.trim_start_matches("./");
        if name != "Termdock Preview.app" && !name.starts_with("Termdock Preview.app/") {
            return Err("Preview 更新包不能包含其他应用".into());
        }
        budget = budget
            .checked_add(entry.size())
            .ok_or("Update size overflow")?;
        if budget > 1024 * 1024 * 1024 {
            return Err("Preview 更新包展开后超过1 GiB".into());
        }
        if let Some(target) = entry.link_name().map_err(|e| e.to_string())? {
            let joined = if entry.header().entry_type().is_hard_link() {
                target.into_owned()
            } else {
                path.parent()
                    .unwrap_or(std::path::Path::new(""))
                    .join(target)
            };
            let mut resolved = std::path::PathBuf::new();
            for component in joined.components() {
                match component {
                    std::path::Component::Normal(v) => resolved.push(v),
                    std::path::Component::CurDir => {}
                    std::path::Component::ParentDir => {
                        if !resolved.pop() {
                            return Err("Unsafe Preview update link".into());
                        }
                    }
                    _ => return Err("Unsafe Preview update link".into()),
                }
            }
            if !resolved.starts_with("Termdock Preview.app")
                || paths.iter().any(|p| p != &path && p.starts_with(&path))
            {
                return Err("Unsafe Preview update link".into());
            }
            links.push(path.clone());
        }
        if links.iter().any(|p| p != &path && path.starts_with(p)) {
            return Err("Update archive writes through a link".into());
        }
        paths.push(path.clone());
        let kind = entry.header().entry_type();
        if !kind.is_file() && !kind.is_dir() && !kind.is_symlink() && !kind.is_hard_link() {
            return Err("Unsupported update archive entry".into());
        }
        if name == "Termdock Preview.app/Contents/Info.plist" {
            if !kind.is_file() || entry.size() > 1024 * 1024 || valid {
                return Err("Invalid Preview update plist".into());
            }
            let mut data = Vec::new();
            entry.read_to_end(&mut data).map_err(|e| e.to_string())?;
            let plist = plist::Value::from_reader(Cursor::new(data)).map_err(|e| e.to_string())?;
            let dict = plist.as_dictionary().ok_or("Invalid application plist")?;
            if dict.get("CFBundleIdentifier").and_then(|v| v.as_string())
                != Some("com.jovines.termdock.preview")
                || dict
                    .get("CFBundleShortVersionString")
                    .and_then(|v| v.as_string())
                    != Some(version)
            {
                return Err("Preview 更新身份或签名版本不匹配".into());
            }
            valid = true;
        }
    }
    if valid {
        Ok(())
    } else {
        Err("Preview 更新包缺少应用身份".into())
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    fn artifact(bundle: &str, root: &str, version: &str) -> Vec<u8> {
        let xml = format!(
            r#"<?xml version="1.0"?><plist version="1.0"><dict><key>CFBundleIdentifier</key><string>{bundle}</string><key>CFBundleShortVersionString</key><string>{version}</string></dict></plist>"#
        );
        let mut tar = tar::Builder::new(Vec::new());
        let mut header = tar::Header::new_gnu();
        header.set_size(xml.len() as u64);
        header.set_mode(0o644);
        header.set_cksum();
        tar.append_data(
            &mut header,
            format!("{root}/Contents/Info.plist"),
            xml.as_bytes(),
        )
        .unwrap();
        let mut gz = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::default());
        std::io::Write::write_all(&mut gz, &tar.into_inner().unwrap()).unwrap();
        gz.finish().unwrap()
    }
    #[test]
    fn actual_archive_identity_prevents_stable_or_wrong_version_installation() {
        assert!(validate(
            &artifact(
                "com.jovines.termdock.preview",
                "Termdock Preview.app",
                "0.2.0"
            ),
            "0.2.0"
        )
        .is_ok());
        for (bundle, root, version) in [
            ("com.jovines.termdock", "Termdock Preview.app", "0.2.0"),
            ("com.jovines.termdock.preview", "Termdock.app", "0.2.0"),
            (
                "com.jovines.termdock.preview",
                "Termdock Preview.app",
                "0.1.0",
            ),
        ] {
            assert!(validate(&artifact(bundle, root, version), "0.2.0").is_err());
        }
        assert!(validate(b"bad archive", "0.2.0").is_err());
    }
    #[test]
    fn actual_tar_links_cannot_escape_or_receive_nested_writes() {
        let valid = artifact(
            "com.jovines.termdock.preview",
            "Termdock Preview.app",
            "0.2.0",
        );
        let mut base = Vec::new();
        flate2::read::GzDecoder::new(Cursor::new(valid))
            .read_to_end(&mut base)
            .unwrap();
        for (target, nested, accepted) in [
            ("Versions/A", false, true),
            ("../../../other.app", false, false),
            ("Versions/A", true, false),
        ] {
            let mut tar = tar::Builder::new(Vec::new());
            for entry in tar::Archive::new(Cursor::new(&base)).entries().unwrap() {
                let mut entry = entry.unwrap();
                let path = entry.path().unwrap().into_owned();
                let header = entry.header().clone();
                tar.append_data(&mut header.clone(), path, &mut entry)
                    .unwrap();
            }
            let mut header = tar::Header::new_gnu();
            header.set_entry_type(tar::EntryType::Symlink);
            header.set_size(0);
            header.set_mode(0o755);
            header.set_link_name(target).unwrap();
            header.set_cksum();
            tar.append_data(
                &mut header,
                "Termdock Preview.app/Contents/Frameworks/Foo",
                std::io::empty(),
            )
            .unwrap();
            if nested {
                let mut header = tar::Header::new_gnu();
                header.set_size(1);
                header.set_mode(0o644);
                header.set_cksum();
                tar.append_data(
                    &mut header,
                    "Termdock Preview.app/Contents/Frameworks/Foo/file",
                    &b"x"[..],
                )
                .unwrap();
            }
            let mut gz = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::default());
            std::io::Write::write_all(&mut gz, &tar.into_inner().unwrap()).unwrap();
            assert_eq!(
                validate(&gz.finish().unwrap(), "0.2.0").is_ok(),
                accepted,
                "target={target}, nested={nested}"
            );
        }
    }
}
