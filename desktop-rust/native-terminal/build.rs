use std::{env, fs, path::PathBuf};
fn main() {
    for file in [
        "native/TDGhostty.m",
        "native/TDGhostty.h",
        "native/TDClipboardTypes.h",
        "native/TDClipboardCopy.h",
        "native/TDHostState.c",
        "native/TDHostState.h",
        "ghostty/ghostty.h",
        "ghostty/lock.json",
    ] {
        println!("cargo:rerun-if-changed={file}");
    }
    println!("cargo:rerun-if-env-changed=TERMDOCK_GHOSTTY_PREFIX");
    if env::var("CARGO_CFG_TARGET_OS").as_deref() != Ok("macos") {
        compile_host_state();
        return;
    }
    let prefix = PathBuf::from(
        env::var_os("TERMDOCK_GHOSTTY_PREFIX")
            .expect("macOS requires the locked Ghostty td-lib: run ghostty/build.py first"),
    );
    for file in [
        "termdock-build.json",
        "include/ghostty.h",
        "lib/libghostty.a",
        "lib/libghostty.a.sha256",
    ] {
        println!("cargo:rerun-if-changed={}", prefix.join(file).display());
    }
    let stamp = fs::read_to_string(prefix.join("termdock-build.json"))
        .expect("missing Ghostty build provenance; do not link an arbitrary library");
    let lock = fs::read_to_string("ghostty/lock.json").expect("missing Ghostty lock");
    assert_eq!(
        stamp.trim(),
        lock.trim(),
        "Ghostty provenance differs from module lock"
    );
    assert!(
        prefix.join("lib/libghostty.a").is_file(),
        "missing full Ghostty library"
    );
    let expected_hash = fs::read_to_string(prefix.join("lib/libghostty.a.sha256"))
        .expect("missing exact artifact digest");
    let hash_output = std::process::Command::new("/usr/bin/shasum")
        .args(["-a", "256"])
        .arg(prefix.join("lib/libghostty.a"))
        .output()
        .expect("cannot verify static library digest");
    assert!(hash_output.status.success(), "static library digest failed");
    assert_eq!(
        String::from_utf8(hash_output.stdout)
            .unwrap()
            .split_whitespace()
            .next()
            .unwrap(),
        expected_hash.trim(),
        "library changed since locked build"
    );
    let header = fs::read(prefix.join("include/ghostty.h")).expect("missing installed header");
    assert_eq!(
        header,
        fs::read("ghostty/ghostty.h").unwrap(),
        "Ghostty header/ABI mismatch"
    );
    cc::Build::new()
        .file("native/TDGhostty.m")
        .include("ghostty")
        .flag("-fobjc-arc")
        .flag("-fmodules")
        .flag("-std=c11")
        .flag("-Wall")
        .flag("-Wextra")
        .flag("-Werror=implicit-function-declaration")
        .compile("td_ghostty_host");
    compile_host_state();
    println!(
        "cargo:rustc-link-search=native={}",
        prefix.join("lib").display()
    );
    println!("cargo:rustc-link-lib=static=ghostty");
    println!("cargo:rustc-link-lib=c++");
    for framework in [
        "AppKit",
        "QuartzCore",
        "Metal",
        "CoreText",
        "CoreGraphics",
        "CoreFoundation",
        "Foundation",
        "IOSurface",
        "Carbon",
        "CoreVideo",
        "ImageIO",
        "UniformTypeIdentifiers",
    ] {
        println!("cargo:rustc-link-lib=framework={framework}");
    }
}

fn compile_host_state() {
    cc::Build::new()
        .file("native/TDHostState.c")
        .flag("-std=c11")
        .warnings(true)
        .compile("td_host_state");
}
