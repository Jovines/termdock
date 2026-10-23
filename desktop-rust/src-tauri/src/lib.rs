pub mod clipboard_collector;
pub mod config;
pub mod product;
pub mod migration;
pub mod collaboration_focus;
#[cfg(feature = "desktop")]
mod desktop_ui;
pub mod local_files;
pub mod download_save;
#[cfg(feature = "desktop")]
mod local_service;
#[cfg(feature = "desktop")]
mod native_desktop;
pub mod proxy;
#[cfg(feature = "desktop")]
mod shell;
#[cfg(feature = "desktop")]
mod window_diagnostics;
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
