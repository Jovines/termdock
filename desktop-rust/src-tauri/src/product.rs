//! Product identity is selected by the release build, never by a service page.
pub fn is_preview() -> bool {
    option_env!("TERMDOCK_DESKTOP_CHANNEL") == Some("preview")
}
pub fn name() -> &'static str {
    if is_preview() { "Termdock Preview" } else { "Termdock" }
}
pub fn identifier() -> &'static str {
    if is_preview() { "com.jovines.termdock.preview" } else { "com.jovines.termdock" }
}
