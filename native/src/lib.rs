//! voice-core: local, streaming Phonon-2.5 voice prompts for OpenCode.
//!
//! The binary in `main.rs` is a thin CLI and JSONL protocol server. The
//! modules here are independently testable so the sidecar can be exercised
//! without a microphone.

pub mod audio;
pub mod engine;
pub mod model;
pub mod protocol;

pub const VERSION: &str = env!("CARGO_PKG_VERSION");
pub const MODEL_ID: &str = "phonon-2.5";
