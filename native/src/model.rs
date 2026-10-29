// Model download, checksum verification, unpacking and cache paths.
//
// The Phonon-2.5 C engine wants a directory containing `weights.bin`,
// `weights.json` and `tokens.txt`. This module knows where that directory
// lives on each platform, how to fetch and verify the release archive, and how
// to install it atomically so a half-extracted tree is never handed to the
// engine.

use std::collections::VecDeque;
use std::env;
use std::fs::{self, File};
use std::io::{BufReader, BufWriter, Read, Write};
use std::path::{Component, Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use anyhow::{anyhow, Context};
use flate2::read::GzDecoder;
use sha2::{Digest, Sha256};

pub const MODEL_ID: &str = "phonon-2.5";
pub const MODEL_DIR_NAME: &str = "phonon-2.5-c-weights-v1";
pub const MODEL_URL: &str =
    "https://huggingface.co/eschmidbauer/phonon-2.5-c/resolve/main/phonon-2.5-c-weights-v1.tar.gz";
pub const MODEL_BYTES: u64 = 183_463_606;
pub const MODEL_SHA256: &str = "ed622ca97bc4ec044c7ba5fb69c10985b1b3897e600dbf611840d9a0692b4cfe";

/// Exact directory containing the three model files.
const ENV_MODEL_DIR: &str = "OPENCODE_VOICE_MODEL_DIR";

const WEIGHTS_BIN: &str = "weights.bin";
const WEIGHTS_JSON: &str = "weights.json";
const TOKENS_TXT: &str = "tokens.txt";

const USER_AGENT: &str = "opencode-voice-phonon/0.1.0";
const DOWNLOAD_CHUNK: usize = 1024 * 1024;
/// `EXDEV` on Unix, `ERROR_NOT_SAME_DEVICE` on Windows.
const NOT_SAME_DEVICE: i32 = 17;

/// Progress events emitted while the model is being made available.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ModelProgress {
    Downloading { received: u64, total: Option<u64> },
    Extracting,
    Loading,
    Ready,
}

/// Platform directory that holds cached model trees.
pub fn cache_root() -> anyhow::Result<PathBuf> {
    Ok(cache_root_base()?
        .join("opencode-voice-phonon")
        .join("models"))
}

/// Directory the engine is pointed at: the env override, else the cache tree.
pub fn model_dir() -> anyhow::Result<PathBuf> {
    if let Some(dir) = env::var_os(ENV_MODEL_DIR) {
        if !dir.is_empty() {
            return Ok(PathBuf::from(dir));
        }
    }
    Ok(cache_root()?.join(MODEL_DIR_NAME))
}

/// True when `dir` holds all three model files and a non-empty `weights.bin`.
///
/// Never panics: unreadable or missing paths simply report `false`.
pub fn is_installed(dir: &Path) -> bool {
    has_required_files(dir)
}

/// Return an installed model directory, downloading it first when missing.
pub fn ensure_model(progress: &mut dyn FnMut(ModelProgress)) -> anyhow::Result<PathBuf> {
    let dir = model_dir()?;
    if is_installed(&dir) {
        progress(ModelProgress::Ready);
        return Ok(dir);
    }

    let dir = install(progress)?;

    // Files are in place; the caller still has to open the engine.
    progress(ModelProgress::Loading);
    progress(ModelProgress::Ready);
    Ok(dir)
}

/// Download, verify, unpack and atomically install the model. Idempotent.
pub fn install(progress: &mut dyn FnMut(ModelProgress)) -> anyhow::Result<PathBuf> {
    let target = model_dir()?;
    if is_installed(&target) {
        return Ok(target);
    }

    let root = cache_root()?;
    fs::create_dir_all(&root).with_context(|| {
        format!(
            "failed to create the model cache directory {}",
            root.display()
        )
    })?;

    let stamp = unique_stamp();
    let archive = Cleanup::new(root.join(format!(".phonon-2.5-{stamp}.tar.gz.part")));
    let staging = Cleanup::new(root.join(format!(".phonon-2.5-{stamp}.extract")));

    download(progress, archive.path())?;

    progress(ModelProgress::Extracting);
    extract_archive(archive.path(), staging.path())?;

    let weights = locate_weights_dir(staging.path()).ok_or_else(|| {
        anyhow!(
            "the downloaded model archive did not contain {WEIGHTS_BIN}, {WEIGHTS_JSON} and \
             {TOKENS_TXT}; try again, and delete {} if the problem persists",
            root.display()
        )
    })?;

    if let Some(parent) = target.parent() {
        if !parent.as_os_str().is_empty() {
            fs::create_dir_all(parent).with_context(|| {
                format!("failed to create the model directory {}", parent.display())
            })?;
        }
    }

    if target.exists() {
        if is_installed(&target) {
            return Ok(target);
        }
        // An incomplete tree is useless; clear it so the rename can land.
        fs::remove_dir_all(&target).with_context(|| {
            format!(
                "found an incomplete model directory at {} and could not remove it; \
                 delete it manually and retry",
                target.display()
            )
        })?;
    }

    if let Err(err) = move_dir(&weights, &target) {
        let _ = fs::remove_dir_all(&target);
        return Err(err).with_context(|| {
            format!(
                "failed to move the verified model into {}; make sure the location is writable",
                target.display()
            )
        });
    }

    Ok(target)
}

// ---------------------------------------------------------------------------
// Platform cache roots
// ---------------------------------------------------------------------------

#[cfg(target_os = "windows")]
fn cache_root_base() -> anyhow::Result<PathBuf> {
    match env::var_os("LOCALAPPDATA") {
        Some(base) if !base.is_empty() => Ok(PathBuf::from(base)),
        _ => Err(anyhow!(
            "LOCALAPPDATA is not set, so the model cache location is unknown; \
             set OPENCODE_VOICE_MODEL_DIR to choose a model directory"
        )),
    }
}

#[cfg(target_os = "macos")]
fn cache_root_base() -> anyhow::Result<PathBuf> {
    match env::var_os("HOME") {
        Some(home) if !home.is_empty() => Ok(PathBuf::from(home).join("Library").join("Caches")),
        _ => Err(anyhow!(
            "HOME is not set, so the model cache location is unknown; \
             set OPENCODE_VOICE_MODEL_DIR to choose a model directory"
        )),
    }
}

#[cfg(all(unix, not(target_os = "macos")))]
fn cache_root_base() -> anyhow::Result<PathBuf> {
    if let Some(cache) = env::var_os("XDG_CACHE_HOME") {
        if !cache.is_empty() {
            return Ok(PathBuf::from(cache));
        }
    }
    match env::var_os("HOME") {
        Some(home) if !home.is_empty() => Ok(PathBuf::from(home).join(".cache")),
        _ => Err(anyhow!(
            "neither XDG_CACHE_HOME nor HOME is set, so the model cache location is unknown; \
             set OPENCODE_VOICE_MODEL_DIR to choose a model directory"
        )),
    }
}

#[cfg(not(any(unix, target_os = "windows")))]
fn cache_root_base() -> anyhow::Result<PathBuf> {
    Err(anyhow!(
        "this platform has no default model cache location; \
         set OPENCODE_VOICE_MODEL_DIR to choose a model directory"
    ))
}

// ---------------------------------------------------------------------------
// Download
// ---------------------------------------------------------------------------

fn download(progress: &mut dyn FnMut(ModelProgress), destination: &Path) -> anyhow::Result<()> {
    let response = ureq::get(MODEL_URL)
        .set("User-Agent", USER_AGENT)
        .call()
        .with_context(|| format!("failed to download the Phonon-2.5 model from {MODEL_URL}"))?;

    if response.status() != 200 {
        return Err(anyhow!(
            "model download from {MODEL_URL} returned HTTP {}",
            response.status()
        ));
    }

    let total = response
        .header("Content-Length")
        .and_then(|value| value.trim().parse::<u64>().ok())
        .or(Some(MODEL_BYTES));

    let mut reader = response.into_reader();
    let file = File::create(destination).with_context(|| {
        format!(
            "failed to create the temporary download file {}",
            destination.display()
        )
    })?;
    let mut sink = BufWriter::new(file);
    let mut hasher = Sha256::new();
    let mut buffer = vec![0u8; DOWNLOAD_CHUNK];
    let mut received: u64 = 0;

    progress(ModelProgress::Downloading { received, total });

    loop {
        let read = reader
            .read(&mut buffer)
            .with_context(|| format!("the model download from {MODEL_URL} was interrupted"))?;
        if read == 0 {
            break;
        }
        sink.write_all(&buffer[..read])
            .with_context(|| format!("failed to write the model to {}", destination.display()))?;
        hasher.update(&buffer[..read]);
        received += read as u64;
        progress(ModelProgress::Downloading { received, total });
    }

    sink.flush()
        .with_context(|| format!("failed to write the model to {}", destination.display()))?;
    // Close the file before the caller reads it back for extraction.
    drop(sink);

    let digest = hex_lower(&hasher.finalize());
    if digest != MODEL_SHA256 {
        return Err(anyhow!(
            "model download checksum mismatch: expected {MODEL_SHA256}, got {digest}; \
             the download was corrupted or interrupted, please retry"
        ));
    }
    if received != MODEL_BYTES {
        return Err(anyhow!(
            "model download checksum mismatch: expected {MODEL_BYTES} bytes, got {received}; \
             the download was incomplete, please retry"
        ));
    }

    Ok(())
}

// ---------------------------------------------------------------------------
// Extraction
// ---------------------------------------------------------------------------

fn extract_archive(archive: &Path, destination: &Path) -> anyhow::Result<()> {
    fs::create_dir_all(destination).with_context(|| {
        format!(
            "failed to create the extraction directory {}",
            destination.display()
        )
    })?;

    let file = File::open(archive).with_context(|| {
        format!(
            "failed to read the downloaded model archive {}",
            archive.display()
        )
    })?;
    let decoder = GzDecoder::new(BufReader::new(file));
    let mut bundle = tar::Archive::new(decoder);

    let entries = bundle
        .entries()
        .context("the downloaded model archive is not a valid tar.gz file")?;

    for entry in entries {
        let mut entry = entry.context("the downloaded model archive is corrupted")?;

        let path = entry
            .path()
            .context("the downloaded model archive contains an invalid entry path")?
            .into_owned();

        if !is_safe_entry_path(&path) {
            return Err(anyhow!(
                "the model archive contains an unsafe path ({}) and was not installed",
                path.display()
            ));
        }

        let entry_type = entry.header().entry_type();
        if entry_type.is_file() || entry_type.is_dir() {
            let unpacked = entry.unpack_in(destination).with_context(|| {
                format!(
                    "failed to extract {} into {}",
                    path.display(),
                    destination.display()
                )
            })?;
            if !unpacked {
                return Err(anyhow!(
                    "the model archive entry {} escaped the extraction directory",
                    path.display()
                ));
            }
        }
        // Anything else (symlinks, hard links, devices) is dropped: the model
        // is just three regular files and we never follow links.
    }

    Ok(())
}

/// Reject absolute paths, Windows drive/UNC prefixes and any `..` component.
fn is_safe_entry_path(path: &Path) -> bool {
    let text = path.to_string_lossy();
    if text.is_empty() || text.contains('\0') {
        return false;
    }

    let bytes = text.as_bytes();
    if bytes[0] == b'/' || bytes[0] == b'\\' {
        return false;
    }
    if bytes.len() >= 2 && bytes[0].is_ascii_alphabetic() && bytes[1] == b':' {
        return false;
    }

    // Catch Windows-style separators even when checking on Unix.
    if text.split(['/', '\\']).any(|segment| segment == "..") {
        return false;
    }

    !path.components().any(|component| {
        matches!(
            component,
            Component::ParentDir | Component::RootDir | Component::Prefix(_)
        )
    })
}

/// Find the directory holding the three model files inside an extracted tree.
fn locate_weights_dir(root: &Path) -> Option<PathBuf> {
    let direct = root.join("c_weights");
    if has_required_files(&direct) {
        return Some(direct);
    }
    if has_required_files(root) {
        return Some(root.to_path_buf());
    }

    // Archive layout may change; search a few levels deep for the real files.
    let mut queue: VecDeque<(PathBuf, usize)> = VecDeque::new();
    queue.push_back((root.to_path_buf(), 0));

    while let Some((dir, depth)) = queue.pop_front() {
        if depth >= 4 {
            continue;
        }
        let entries = match fs::read_dir(&dir) {
            Ok(entries) => entries,
            Err(_) => continue,
        };
        for entry in entries.flatten() {
            let file_type = match entry.file_type() {
                Ok(file_type) => file_type,
                Err(_) => continue,
            };
            if !file_type.is_dir() {
                continue;
            }
            let path = entry.path();
            if has_required_files(&path) {
                return Some(path);
            }
            queue.push_back((path, depth + 1));
        }
    }

    None
}

fn has_required_files(dir: &Path) -> bool {
    is_regular_file(&dir.join(WEIGHTS_JSON))
        && is_regular_file(&dir.join(TOKENS_TXT))
        && fs::metadata(dir.join(WEIGHTS_BIN))
            .map(|meta| meta.is_file() && meta.len() > 0)
            .unwrap_or(false)
}

fn is_regular_file(path: &Path) -> bool {
    fs::metadata(path)
        .map(|meta| meta.is_file())
        .unwrap_or(false)
}

// ---------------------------------------------------------------------------
// Filesystem helpers
// ---------------------------------------------------------------------------

fn move_dir(source: &Path, destination: &Path) -> std::io::Result<()> {
    match fs::rename(source, destination) {
        Ok(()) => Ok(()),
        Err(err) if err.raw_os_error() == Some(NOT_SAME_DEVICE) => {
            // Different volume (custom model dir): fall back to a copy.
            copy_dir(source, destination)?;
            fs::remove_dir_all(source)
        }
        Err(err) => Err(err),
    }
}

fn copy_dir(source: &Path, destination: &Path) -> std::io::Result<()> {
    fs::create_dir_all(destination)?;
    for entry in fs::read_dir(source)? {
        let entry = entry?;
        let from = entry.path();
        let to = destination.join(entry.file_name());
        let file_type = entry.file_type()?;
        if file_type.is_dir() {
            copy_dir(&from, &to)?;
        } else if file_type.is_file() {
            fs::copy(&from, &to)?;
        }
        // Links and special files are skipped, never followed.
    }
    Ok(())
}

/// Unique-ish temp name: `<pid>-<nanos>`.
fn unique_stamp() -> String {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_nanos())
        .unwrap_or(0);
    format!("{}-{}", std::process::id(), nanos)
}

fn hex_lower(bytes: &[u8]) -> String {
    const DIGITS: &[u8; 16] = b"0123456789abcdef";
    let mut out = String::with_capacity(bytes.len() * 2);
    for &byte in bytes {
        out.push(DIGITS[(byte >> 4) as usize] as char);
        out.push(DIGITS[(byte & 0x0f) as usize] as char);
    }
    out
}

/// Removes a file or directory on drop.
struct Cleanup {
    path: PathBuf,
}

impl Cleanup {
    fn new(path: PathBuf) -> Self {
        Self { path }
    }

    fn path(&self) -> &Path {
        &self.path
    }
}

impl Drop for Cleanup {
    fn drop(&mut self) {
        let result = match fs::symlink_metadata(&self.path) {
            Ok(meta) if meta.is_dir() => fs::remove_dir_all(&self.path),
            Ok(_) => fs::remove_file(&self.path),
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => return,
            Err(err) => Err(err),
        };
        if let Err(err) = result {
            eprintln!(
                "voice-core: failed to clean up temporary path {}: {err}",
                self.path.display()
            );
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::env;
    use std::fs;

    fn unique_dir(tag: &str) -> PathBuf {
        let stamp = unique_stamp();
        env::temp_dir().join(format!("voice-core-model-{tag}-{stamp}"))
    }

    #[test]
    fn is_installed_needs_all_three_files() {
        let dir = unique_dir("installed");

        assert!(
            !is_installed(&dir),
            "missing directory must not be installed"
        );

        fs::create_dir_all(&dir).unwrap();
        assert!(!is_installed(&dir), "empty directory must not be installed");

        fs::write(dir.join(WEIGHTS_BIN), b"\x01\x02\x03").unwrap();
        assert!(!is_installed(&dir), "missing weights.json and tokens.txt");

        fs::write(dir.join(WEIGHTS_JSON), b"{}").unwrap();
        assert!(!is_installed(&dir), "missing tokens.txt");

        fs::write(dir.join(TOKENS_TXT), b"a\nb\n").unwrap();
        assert!(is_installed(&dir), "three files present");

        fs::write(dir.join(WEIGHTS_BIN), b"").unwrap();
        assert!(!is_installed(&dir), "empty weights.bin must not count");

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn entry_paths_must_stay_inside_the_target() {
        assert!(!is_safe_entry_path(Path::new("../evil")));
        assert!(!is_safe_entry_path(Path::new("c_weights/../../evil")));
        assert!(!is_safe_entry_path(Path::new("/abs")));
        assert!(!is_safe_entry_path(Path::new("\\abs")));
        assert!(!is_safe_entry_path(Path::new("C:\\abs")));
        assert!(!is_safe_entry_path(Path::new("c_weights\\..\\evil")));
        assert!(!is_safe_entry_path(Path::new("")));

        assert!(is_safe_entry_path(Path::new("c_weights")));
        assert!(is_safe_entry_path(Path::new("c_weights/weights.bin")));
        assert!(is_safe_entry_path(Path::new("./c_weights/tokens.txt")));
    }

    #[test]
    fn cache_root_ignores_the_model_dir_override() {
        let previous = env::var_os(ENV_MODEL_DIR);
        let override_dir = unique_dir("override");

        env::set_var(ENV_MODEL_DIR, &override_dir);
        let resolved = model_dir();
        let root = cache_root();
        match previous {
            Some(value) => env::set_var(ENV_MODEL_DIR, value),
            None => env::remove_var(ENV_MODEL_DIR),
        }

        assert_eq!(resolved.unwrap(), override_dir);
        if let Ok(root) = root {
            assert_eq!(
                root.file_name().and_then(|name| name.to_str()),
                Some("models")
            );
            assert_ne!(root, override_dir, "cache_root must not use the override");
        }
    }
}
