// JSONL protocol types shared by the sidecar and the TUI. Mirrors src/protocol.ts.
//!
//! Each command and event is one compact JSON object per line and always
//! carries `"v": 1`. `Command` and `Event` are plain enums, so callers build
//! `Event::Done { text }` directly; their `Serialize` impls add the version
//! field, and their `Deserialize` impls accept a missing `v` (defaulting to
//! [`PROTOCOL_VERSION`]) while rejecting any other version.
//!
//! Constructors: use the enum variants, or [`error`] for an `error` event.
//! [`read_command`] parses one stdin line and [`write_event`] writes one
//! stdout line.

use anyhow::Context;
use serde::ser::SerializeMap;
use serde::{Deserialize, Deserializer, Serialize, Serializer};
use serde_json::Value;

/// The only protocol version this build speaks.
pub const PROTOCOL_VERSION: u32 = 1;

fn protocol_version() -> u32 {
    PROTOCOL_VERSION
}

/// Reads the `v` field of an object. Missing values default to the current
/// version; anything other than [`PROTOCOL_VERSION`] is an error.
fn version_of(value: &Value) -> Result<u32, String> {
    match value.get("v") {
        None => Ok(protocol_version()),
        Some(Value::Number(number)) => {
            let version = number.as_u64().ok_or_else(|| {
                format!("protocol version must be a positive integer, got {number}")
            })?;
            if version == u64::from(PROTOCOL_VERSION) {
                Ok(PROTOCOL_VERSION)
            } else {
                Err(format!(
                    "unsupported protocol version {version}; this build speaks {PROTOCOL_VERSION}"
                ))
            }
        }
        Some(other) => Err(format!("protocol version must be an integer, got {other}")),
    }
}

/// Recording state reported by the sidecar.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CoreState {
    Idle,
    Preparing,
    Listening,
    Transcribing,
}

/// Model lifecycle state reported by the sidecar.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ModelState {
    Downloading,
    Extracting,
    Loading,
    Ready,
}

/// One command written to the sidecar's stdin.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Command {
    Start,
    Stop,
    Cancel,
    Shutdown,
    Ping { id: u64 },
}

impl Serialize for Command {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        let mut map = serializer.serialize_map(None)?;
        map.serialize_entry("v", &PROTOCOL_VERSION)?;
        match self {
            Command::Start => map.serialize_entry("type", "start")?,
            Command::Stop => map.serialize_entry("type", "stop")?,
            Command::Cancel => map.serialize_entry("type", "cancel")?,
            Command::Shutdown => map.serialize_entry("type", "shutdown")?,
            Command::Ping { id } => {
                map.serialize_entry("type", "ping")?;
                map.serialize_entry("id", id)?;
            }
        }
        map.end()
    }
}

#[derive(Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
enum RawCommand {
    Start,
    Stop,
    Cancel,
    Shutdown,
    Ping { id: u64 },
}

impl<'de> Deserialize<'de> for Command {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let value = Value::deserialize(deserializer)?;
        version_of(&value).map_err(serde::de::Error::custom)?;
        let raw = serde_json::from_value::<RawCommand>(value).map_err(serde::de::Error::custom)?;
        Ok(match raw {
            RawCommand::Start => Command::Start,
            RawCommand::Stop => Command::Stop,
            RawCommand::Cancel => Command::Cancel,
            RawCommand::Shutdown => Command::Shutdown,
            RawCommand::Ping { id } => Command::Ping { id },
        })
    }
}

/// One event written to the sidecar's stdout.
#[derive(Clone, Debug, PartialEq)]
pub enum Event {
    Hello {
        version: String,
        model: String,
        platform: String,
    },
    State {
        state: CoreState,
    },
    Model {
        state: ModelState,
        received: Option<u64>,
        total: Option<u64>,
    },
    Partial {
        text: String,
    },
    Final {
        text: String,
        start: f32,
        end: f32,
    },
    Done {
        text: String,
    },
    Error {
        message: String,
        code: String,
    },
    Pong {
        id: u64,
    },
}

impl Serialize for Event {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        let mut map = serializer.serialize_map(None)?;
        map.serialize_entry("v", &PROTOCOL_VERSION)?;
        match self {
            Event::Hello {
                version,
                model,
                platform,
            } => {
                map.serialize_entry("type", "hello")?;
                map.serialize_entry("version", version)?;
                map.serialize_entry("model", model)?;
                map.serialize_entry("platform", platform)?;
            }
            Event::State { state } => {
                map.serialize_entry("type", "state")?;
                map.serialize_entry("state", state)?;
            }
            Event::Model {
                state,
                received,
                total,
            } => {
                map.serialize_entry("type", "model")?;
                map.serialize_entry("state", state)?;
                if let Some(received) = received {
                    map.serialize_entry("received", received)?;
                }
                if let Some(total) = total {
                    map.serialize_entry("total", total)?;
                }
            }
            Event::Partial { text } => {
                map.serialize_entry("type", "partial")?;
                map.serialize_entry("text", text)?;
            }
            Event::Final { text, start, end } => {
                map.serialize_entry("type", "final")?;
                map.serialize_entry("text", text)?;
                map.serialize_entry("start", start)?;
                map.serialize_entry("end", end)?;
            }
            Event::Done { text } => {
                map.serialize_entry("type", "done")?;
                map.serialize_entry("text", text)?;
            }
            Event::Error { message, code } => {
                map.serialize_entry("type", "error")?;
                map.serialize_entry("message", message)?;
                map.serialize_entry("code", code)?;
            }
            Event::Pong { id } => {
                map.serialize_entry("type", "pong")?;
                map.serialize_entry("id", id)?;
            }
        }
        map.end()
    }
}

#[derive(Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
enum RawEvent {
    Hello {
        version: String,
        model: String,
        platform: String,
    },
    State {
        state: CoreState,
    },
    Model {
        state: ModelState,
        #[serde(default)]
        received: Option<u64>,
        #[serde(default)]
        total: Option<u64>,
    },
    Partial {
        text: String,
    },
    Final {
        text: String,
        start: f32,
        end: f32,
    },
    Done {
        text: String,
    },
    Error {
        message: String,
        code: String,
    },
    Pong {
        id: u64,
    },
}

impl<'de> Deserialize<'de> for Event {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let value = Value::deserialize(deserializer)?;
        version_of(&value).map_err(serde::de::Error::custom)?;
        let raw = serde_json::from_value::<RawEvent>(value).map_err(serde::de::Error::custom)?;
        Ok(match raw {
            RawEvent::Hello {
                version,
                model,
                platform,
            } => Event::Hello {
                version,
                model,
                platform,
            },
            RawEvent::State { state } => Event::State { state },
            RawEvent::Model {
                state,
                received,
                total,
            } => Event::Model {
                state,
                received,
                total,
            },
            RawEvent::Partial { text } => Event::Partial { text },
            RawEvent::Final { text, start, end } => Event::Final { text, start, end },
            RawEvent::Done { text } => Event::Done { text },
            RawEvent::Error { message, code } => Event::Error { message, code },
            RawEvent::Pong { id } => Event::Pong { id },
        })
    }
}

/// Builds an `error` event.
pub fn error(message: impl Into<String>, code: impl Into<String>) -> Event {
    Event::Error {
        message: message.into(),
        code: code.into(),
    }
}

/// Parses one command line from stdin.
///
/// Blank lines are an error, as are unknown types, a malformed body, and a
/// protocol version other than [`PROTOCOL_VERSION`]. A missing `v` is treated
/// as the current version.
pub fn read_command(line: &str) -> anyhow::Result<Command> {
    let text = line.trim();
    if text.is_empty() {
        anyhow::bail!("empty command line");
    }

    let value: Value = serde_json::from_str(text).context("command is not valid JSON")?;
    version_of(&value).map_err(|message| anyhow::anyhow!("{message}"))?;

    let command_type = match value.get("type") {
        Some(Value::String(command_type)) => command_type.clone(),
        _ => anyhow::bail!("command is missing a string \"type\" field"),
    };
    if !matches!(
        command_type.as_str(),
        "start" | "stop" | "cancel" | "shutdown" | "ping"
    ) {
        anyhow::bail!("unknown command type {command_type:?}");
    }

    serde_json::from_value(value).context("malformed command")
}

/// Writes one compact JSON event followed by exactly one newline, then flushes.
pub fn write_event<W: std::io::Write>(writer: &mut W, event: &Event) -> anyhow::Result<()> {
    let mut line = serde_json::to_vec(event).context("serialize event")?;
    line.push(b'\n');
    writer.write_all(&line).context("write event")?;
    writer.flush().context("flush event")?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn events() -> Vec<(Event, Value)> {
        vec![
            (
                Event::Hello {
                    version: "0.1.0".into(),
                    model: "phonon-2.5".into(),
                    platform: "win32-x64".into(),
                },
                json!({
                    "v": 1,
                    "type": "hello",
                    "version": "0.1.0",
                    "model": "phonon-2.5",
                    "platform": "win32-x64"
                }),
            ),
            (
                Event::State {
                    state: CoreState::Idle,
                },
                json!({"v": 1, "type": "state", "state": "idle"}),
            ),
            (
                Event::Model {
                    state: ModelState::Downloading,
                    received: Some(123),
                    total: Some(456),
                },
                json!({
                    "v": 1,
                    "type": "model",
                    "state": "downloading",
                    "received": 123,
                    "total": 456
                }),
            ),
            (
                Event::Model {
                    state: ModelState::Extracting,
                    received: None,
                    total: None,
                },
                json!({"v": 1, "type": "model", "state": "extracting"}),
            ),
            (
                Event::Model {
                    state: ModelState::Loading,
                    received: None,
                    total: None,
                },
                json!({"v": 1, "type": "model", "state": "loading"}),
            ),
            (
                Event::Model {
                    state: ModelState::Ready,
                    received: None,
                    total: None,
                },
                json!({"v": 1, "type": "model", "state": "ready"}),
            ),
            (
                Event::Partial {
                    text: "hello wor".into(),
                },
                json!({"v": 1, "type": "partial", "text": "hello wor"}),
            ),
            (
                Event::Final {
                    text: "Hello world.".into(),
                    start: 0.0,
                    end: 1.5,
                },
                json!({
                    "v": 1,
                    "type": "final",
                    "text": "Hello world.",
                    "start": 0.0,
                    "end": 1.5
                }),
            ),
            (
                Event::Done {
                    text: "Hello world.".into(),
                },
                json!({"v": 1, "type": "done", "text": "Hello world."}),
            ),
            (
                Event::Error {
                    message: "boom".into(),
                    code: "engine".into(),
                },
                json!({
                    "v": 1,
                    "type": "error",
                    "message": "boom",
                    "code": "engine"
                }),
            ),
            (
                Event::Pong { id: 7 },
                json!({"v": 1, "type": "pong", "id": 7}),
            ),
        ]
    }

    #[test]
    fn serializes_every_event_with_version() {
        for (event, expected) in events() {
            assert_eq!(serde_json::to_value(&event).unwrap(), expected);
        }
    }

    #[test]
    fn round_trips_events() {
        for (event, expected) in events() {
            let encoded = serde_json::to_string(&event).unwrap();
            assert_eq!(
                serde_json::from_str::<Event>(&encoded).unwrap(),
                event,
                "{expected}"
            );
        }
    }

    #[test]
    fn serializes_every_command_with_version() {
        let cases = [
            (Command::Start, json!({"v": 1, "type": "start"})),
            (Command::Stop, json!({"v": 1, "type": "stop"})),
            (Command::Cancel, json!({"v": 1, "type": "cancel"})),
            (Command::Shutdown, json!({"v": 1, "type": "shutdown"})),
            (
                Command::Ping { id: 7 },
                json!({"v": 1, "type": "ping", "id": 7}),
            ),
        ];
        for (command, expected) in cases {
            assert_eq!(serde_json::to_value(&command).unwrap(), expected);
        }
    }

    #[test]
    fn reads_every_command() {
        let cases = [
            (r#"{"v":1,"type":"start"}"#, Command::Start),
            (r#"{"v":1,"type":"stop"}"#, Command::Stop),
            (r#"{"v":1,"type":"cancel"}"#, Command::Cancel),
            (r#"{"v":1,"type":"shutdown"}"#, Command::Shutdown),
            (r#"{"v":1,"type":"ping","id":7}"#, Command::Ping { id: 7 }),
        ];
        for (line, expected) in cases {
            assert_eq!(read_command(line).unwrap(), expected);
            assert_eq!(serde_json::from_str::<Command>(line).unwrap(), expected);
        }
    }

    #[test]
    fn rejects_blank_and_unknown_commands() {
        assert!(read_command("").is_err());
        assert!(read_command("   ").is_err());

        let err = read_command(r#"{"v":1,"type":"dance"}"#).unwrap_err();
        assert!(err.to_string().contains("dance"), "unexpected error: {err}");
    }

    #[test]
    fn defaults_missing_version() {
        assert_eq!(
            read_command(r#"{"type":"ping","id":7}"#).unwrap(),
            Command::Ping { id: 7 }
        );
        assert_eq!(
            serde_json::from_str::<Command>(r#"{"type":"start"}"#).unwrap(),
            Command::Start
        );
        assert_eq!(
            serde_json::from_str::<Event>(r#"{"type":"done","text":"hi"}"#).unwrap(),
            Event::Done { text: "hi".into() }
        );
    }

    #[test]
    fn rejects_wrong_version() {
        let err = read_command(r#"{"v":2,"type":"start"}"#).unwrap_err();
        assert!(
            err.to_string().contains("version"),
            "unexpected error: {err}"
        );
        assert!(serde_json::from_str::<Command>(r#"{"v":2,"type":"start"}"#).is_err());
        assert!(serde_json::from_str::<Event>(r#"{"v":2,"type":"done","text":"hi"}"#).is_err());
    }

    #[test]
    fn model_progress_fields_are_optional() {
        let value = serde_json::to_value(Event::Model {
            state: ModelState::Ready,
            received: None,
            total: None,
        })
        .unwrap();
        let object = value.as_object().unwrap();
        assert!(!object.contains_key("received"));
        assert!(!object.contains_key("total"));

        let value = serde_json::to_value(Event::Model {
            state: ModelState::Downloading,
            received: Some(123),
            total: None,
        })
        .unwrap();
        assert_eq!(
            value,
            json!({
                "v": 1,
                "type": "model",
                "state": "downloading",
                "received": 123
            })
        );
    }

    #[test]
    fn error_helper_builds_error_event() {
        assert_eq!(
            error("boom", "engine"),
            Event::Error {
                message: "boom".into(),
                code: "engine".into()
            }
        );
    }

    #[test]
    fn write_event_emits_one_compact_line() {
        let mut out = Vec::new();
        write_event(&mut out, &Event::Done { text: "hi".into() }).unwrap();
        let text = String::from_utf8(out).unwrap();
        assert_eq!(text, "{\"v\":1,\"type\":\"done\",\"text\":\"hi\"}\n");
        assert_eq!(text.matches('\n').count(), 1);
        assert!(text.ends_with('\n'));
        assert!(!text.ends_with("\n\n"));
        assert_eq!(
            serde_json::from_str::<Event>(text.trim_end()).unwrap(),
            Event::Done { text: "hi".into() }
        );
    }
}
