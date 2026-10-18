//! Pinned Ghostty engine + AppKit surface; Rust owns bounded transport only.
//! No local PTY, network client, service credentials, second parser or renderer.
pub mod core;
#[cfg(any(target_os = "macos", feature = "check-native-api"))]
pub mod macos;
pub use core::{
    BatchAck, Envelope, Error, Font, HostEvent, Options, Ownership, Palette, Replay, Submission,
};
#[cfg(test)]
mod tests;
