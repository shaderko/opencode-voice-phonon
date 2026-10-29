// Safe Rust wrapper over the vendored Phonon-2.5 C engine.
// See native/vendor/phonon25/csrc/phonon25.h for the underlying API.

use std::ffi::{CStr, CString};
use std::os::raw::c_int;
use std::path::Path;
use std::ptr::NonNull;
use std::sync::Arc;

use anyhow::{anyhow, bail, Context, Result};

/// One decoded window of a long recording, as returned by [`Stream::next_segment`].
///
/// The text is copied out of the C result before the pointer can be invalidated.
#[derive(Debug, Clone, PartialEq)]
pub struct Segment {
    /// This window's transcript.
    pub text: String,
    /// Start of the window in seconds, in the audio given to the stream.
    pub start: f32,
    /// End of the window in seconds, in the audio given to the stream.
    pub end: f32,
}

/// A loaded Phonon-2.5 engine.
pub struct Engine {
    inner: Arc<EngineInner>,
}

/// Reference-counted ownership of the C engine handle.
///
/// The engine is closed exactly once, when the last `Arc<EngineInner>` drops.
struct EngineInner {
    ptr: NonNull<ffi::P25Engine>,
}

// SAFETY: after p25_engine_open the engine's model is immutable. Streams
// opened from one engine have independent state and the C API allows several
// streams on one engine; each `Stream` is used by one thread at a time (its raw
// stream pointer keeps it `!Send`). Moving the handle to another thread and
// sharing it for stream creation therefore cannot race. The C engine is closed
// exactly once, by `EngineInner::drop` when the last `Arc` goes away.
unsafe impl Send for EngineInner {}

// SAFETY: as above. `&EngineInner` is only used to call p25_stream_open, which
// creates independent per-stream state; nothing mutable is shared.
unsafe impl Sync for EngineInner {}

impl Engine {
    /// Load the model from `dir`, which holds `weights.bin`, `weights.json`
    /// and `tokens.txt`.
    pub fn open(dir: &Path) -> Result<Engine> {
        let c_dir = weights_dir_cstring(dir)?;

        // SAFETY: p25_set_verbose only assigns the global verbosity flag; it is
        // called before any engine exists and takes an int by value.
        unsafe { ffi::p25_set_verbose(0) };

        // SAFETY: c_dir is a valid, NUL-terminated UTF-8 path that outlives the call.
        let raw = unsafe { ffi::p25_engine_open(c_dir.as_ptr()) };
        let ptr = NonNull::new(raw)
            .ok_or_else(|| anyhow!("p25_engine_open failed for {}", dir.display()))?;

        Ok(Engine {
            inner: Arc::new(EngineInner { ptr }),
        })
    }

    /// Open a streaming session at `sample_rate` Hz.
    pub fn stream(&self, sample_rate: u32) -> Result<Stream> {
        if sample_rate == 0 {
            bail!("sample rate must be non-zero");
        }
        let rate = c_int::try_from(sample_rate).context("sample rate does not fit in a C int")?;

        // SAFETY: inner.ptr is a live engine; the Arc clone in the Stream keeps
        // it open for as long as the stream exists.
        let raw = unsafe { ffi::p25_stream_open(self.inner.ptr.as_ptr(), rate) };
        let ptr = NonNull::new(raw)
            .ok_or_else(|| anyhow!("p25_stream_open failed for {sample_rate} Hz"))?;

        Ok(Stream {
            ptr,
            _engine: Arc::clone(&self.inner),
        })
    }
}

impl Drop for EngineInner {
    fn drop(&mut self) {
        // SAFETY: ptr came from p25_engine_open and is closed only here.
        unsafe { ffi::p25_engine_close(self.ptr.as_ptr()) };
    }
}

/// A streaming transcription session.
///
/// Used from one thread at a time. It holds a shared handle to its engine, so
/// dropping the [`Engine`] it was created from does not invalidate the stream.
pub struct Stream {
    ptr: NonNull<ffi::P25Stream>,
    _engine: Arc<EngineInner>,
}

impl Stream {
    /// Append mono `f32` samples; returns how many segments this call added.
    pub fn feed(&mut self, samples: &[f32]) -> Result<usize> {
        let n = c_int::try_from(samples.len()).context("too many samples in one feed")?;

        // SAFETY: the slice is valid for `n` floats and the stream is live.
        let added = unsafe { ffi::p25_stream_feed(self.ptr.as_ptr(), samples.as_ptr(), n) };
        if added < 0 {
            bail!("p25_stream_feed failed");
        }
        Ok(added as usize)
    }

    /// Take the next segment not yet returned, if any.
    ///
    /// The text is copied immediately: the C pointer is invalidated by the
    /// next [`feed`](Self::feed) or [`finish`](Self::finish).
    pub fn next_segment(&mut self) -> Option<Segment> {
        // SAFETY: the stream is live; the returned pointer is either null or
        // points into the stream's result.
        let raw = unsafe { ffi::p25_stream_next(self.ptr.as_ptr()) };
        if raw.is_null() {
            return None;
        }

        // SAFETY: non-null, and valid until the next feed/finish; `seg.text` is
        // an owned C string for the same interval, so it is copied right here.
        let seg = unsafe { &*raw };
        let text = if seg.text.is_null() {
            String::new()
        } else {
            // SAFETY: non-null NUL-terminated string owned by the segment.
            unsafe { CStr::from_ptr(seg.text) }
                .to_string_lossy()
                .into_owned()
        };

        Some(Segment {
            text,
            start: seg.start,
            end: seg.end,
        })
    }

    /// Provisional transcript of the audio pending since the last cut.
    ///
    /// Returns `Ok(None)` when nothing is pending (the engine reports an empty
    /// string, or null on failure).
    pub fn partial(&mut self) -> Result<Option<String>> {
        // SAFETY: the stream is live; on success the result is an owned
        // NUL-terminated string the caller must free.
        let raw = unsafe { ffi::p25_stream_partial(self.ptr.as_ptr()) };
        if raw.is_null() {
            return Ok(None);
        }

        // SAFETY: non-null NUL-terminated string owned by us after this call.
        let text = unsafe { CStr::from_ptr(raw) }
            .to_string_lossy()
            .into_owned();
        // SAFETY: raw came from p25_stream_partial and is freed exactly once here.
        unsafe { ffi::p25_free(raw.cast()) };

        if text.is_empty() {
            Ok(None)
        } else {
            Ok(Some(text))
        }
    }

    /// Seconds of audio buffered since the last finalized window.
    pub fn pending_seconds(&self) -> f64 {
        // SAFETY: the stream is live; the C function only reads its pending
        // sample count.
        unsafe { ffi::p25_stream_pending_seconds(self.ptr.as_ptr()) }
    }

    /// Decode the remaining audio as the last window; returns how many
    /// segments that added. Drain them with [`next_segment`](Self::next_segment).
    pub fn finish(&mut self) -> Result<usize> {
        // SAFETY: the stream is live and not yet finished; this consumes it.
        let added = unsafe { ffi::p25_stream_finish(self.ptr.as_ptr()) };
        if added < 0 {
            bail!("p25_stream_finish failed");
        }
        Ok(added as usize)
    }

    /// Close the stream now. Dropping it has the same effect.
    pub fn close(self) {
        // Dropping `self` runs `Drop`, which frees the stream exactly once.
        drop(self);
    }
}

impl Drop for Stream {
    fn drop(&mut self) {
        // SAFETY: ptr came from p25_stream_open and is closed only here.
        unsafe { ffi::p25_stream_close(self.ptr.as_ptr()) };
    }
}

fn weights_dir_cstring(dir: &Path) -> Result<CString> {
    let dir_str = dir
        .to_str()
        .ok_or_else(|| anyhow!("weights directory is not valid UTF-8: {}", dir.display()))?;
    CString::new(dir_str)
        .map_err(|_| anyhow!("weights directory contains a NUL byte: {}", dir.display()))
}

mod ffi {
    use std::os::raw::{c_char, c_float, c_int, c_void};

    #[repr(C)]
    pub struct P25Engine {
        _private: [u8; 0],
    }

    #[repr(C)]
    pub struct P25Stream {
        _private: [u8; 0],
    }

    #[repr(C)]
    pub struct P25Segment {
        pub start: c_float,
        pub end: c_float,
        pub text: *mut c_char,
        pub _first_word: c_int,
        pub _n_words: c_int,
        pub _first_token: c_int,
        pub _n_tokens: c_int,
    }

    extern "C" {
        pub fn p25_engine_open(weights_dir: *const c_char) -> *mut P25Engine;
        pub fn p25_engine_close(e: *mut P25Engine);

        pub fn p25_stream_open(e: *const P25Engine, sample_rate: c_int) -> *mut P25Stream;
        pub fn p25_stream_feed(s: *mut P25Stream, audio: *const c_float, n_samples: c_int)
            -> c_int;
        pub fn p25_stream_next(s: *mut P25Stream) -> *const P25Segment;
        pub fn p25_stream_partial(s: *mut P25Stream) -> *mut c_char;
        pub fn p25_stream_pending_seconds(s: *const P25Stream) -> f64;
        pub fn p25_stream_finish(s: *mut P25Stream) -> c_int;
        pub fn p25_stream_close(s: *mut P25Stream);

        pub fn p25_free(p: *mut c_void);
        pub fn p25_set_verbose(v: c_int);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn segment_exposes_text_and_times() {
        let seg = Segment {
            text: "hello".to_string(),
            start: 1.5,
            end: 2.25,
        };
        assert_eq!(seg.text, "hello");
        assert_eq!(seg.start, 1.5);
        assert_eq!(seg.end, 2.25);
    }

    #[test]
    fn weights_dir_rejects_embedded_nul() {
        assert!(weights_dir_cstring(Path::new("weights\0dir")).is_err());
    }

    #[test]
    fn engine_is_send() {
        fn assert_send<T: Send>() {}
        assert_send::<Engine>();
    }
}
