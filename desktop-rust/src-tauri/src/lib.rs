pub mod clipboard_collector;
pub mod config;
#[cfg(feature = "desktop")]
mod desktop_ui;
pub mod local_files;
pub mod download_save;
#[cfg(feature = "desktop")]
mod local_service;
pub mod native_contract;
pub mod native_lifetime;
#[cfg(feature = "desktop")]
mod native_desktop;
#[cfg(all(feature = "desktop", target_os = "macos"))]
mod native_terminal;
pub mod proxy;
#[cfg(feature = "desktop")]
mod shell;
#[cfg(feature = "desktop")]
mod native_gate;
#[cfg(feature = "desktop")]
mod window_chrome;
pub mod tls;
#[cfg(feature = "desktop")]
mod tray_image;
pub mod update_artifact;
#[cfg(feature = "desktop")]
mod updater;
#[cfg(all(feature = "desktop", not(test)))]
pub use shell::run;
#[cfg(feature = "desktop")]
pub fn clipboard_helper_entry() -> bool {
    native_desktop::helper_entry()
}
