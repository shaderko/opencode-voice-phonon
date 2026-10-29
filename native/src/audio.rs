// Microphone capture with cpal: default device, downmix to mono, f32 chunks.

use std::sync::mpsc::SyncSender;

use anyhow::{anyhow, Context, Result};
use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use cpal::{SampleFormat, SizedSample, Stream, StreamConfig};

/// A block of mono f32 samples tagged with the device sample rate.
pub struct AudioChunk {
    pub samples: Vec<f32>,
    pub sample_rate: u32,
}

/// Owns the cpal input stream; dropping it stops capture.
pub struct Recorder {
    // Held only to keep the stream alive.
    _stream: Stream,
    sample_rate: u32,
}

impl Recorder {
    pub fn sample_rate(&self) -> u32 {
        self.sample_rate
    }
}

/// Open the default input device and stream downmixed mono chunks to `sender`.
pub fn start_input(sender: SyncSender<AudioChunk>) -> Result<Recorder> {
    let host = cpal::default_host();
    let device = host
        .default_input_device()
        .ok_or_else(|| anyhow!("no default input device"))?;
    let supported = device
        .default_input_config()
        .context("query default input config")?;

    let sample_rate = supported.sample_rate().0;
    let channels = supported.channels() as usize;
    let sample_format = supported.sample_format();
    let config: StreamConfig = supported.into();

    let stream = match sample_format {
        SampleFormat::F32 => {
            build_input::<f32, _>(&device, &config, channels, sample_rate, sender, |s| s)
        }
        SampleFormat::I16 => {
            build_input::<i16, _>(&device, &config, channels, sample_rate, sender, |s| {
                s as f32 / 32768.0
            })
        }
        SampleFormat::U16 => {
            build_input::<u16, _>(&device, &config, channels, sample_rate, sender, |s| {
                (s as f32 - 32768.0) / 32768.0
            })
        }
        SampleFormat::I32 => {
            build_input::<i32, _>(&device, &config, channels, sample_rate, sender, |s| {
                s as f32 / 2_147_483_648.0
            })
        }
        SampleFormat::F64 => {
            build_input::<f64, _>(&device, &config, channels, sample_rate, sender, |s| {
                s as f32
            })
        }
        other => return Err(anyhow!("unsupported input sample format: {:?}", other)),
    }
    .context("build input stream")?;

    stream.play().context("start input stream")?;

    Ok(Recorder {
        _stream: stream,
        sample_rate,
    })
}

fn build_input<T, C>(
    device: &cpal::Device,
    config: &StreamConfig,
    channels: usize,
    sample_rate: u32,
    sender: SyncSender<AudioChunk>,
    convert: C,
) -> Result<Stream>
where
    T: SizedSample + Copy,
    C: Fn(T) -> f32 + Send + 'static,
{
    let err_fn = |err| eprintln!("audio input stream error: {err}");
    let stream = device.build_input_stream(
        config,
        move |data: &[T], _| {
            if data.is_empty() || channels == 0 {
                return;
            }
            let converted: Vec<f32> = data.iter().map(|s| convert(*s)).collect();
            let samples = downmix_f32(&converted, channels);
            if samples.is_empty() {
                return;
            }
            // Never block the audio thread: drop the chunk if the consumer is behind.
            let _ = sender.try_send(AudioChunk {
                samples,
                sample_rate,
            });
        },
        err_fn,
        None,
    )?;
    Ok(stream)
}

/// Average interleaved channels down to mono, ignoring any partial trailing frame.
pub fn downmix_f32(interleaved: &[f32], channels: usize) -> Vec<f32> {
    if channels == 0 || interleaved.is_empty() {
        return Vec::new();
    }
    let mut out = Vec::with_capacity(interleaved.len() / channels);
    for frame in interleaved.chunks_exact(channels) {
        let sum: f32 = frame.iter().sum();
        out.push(sum / channels as f32);
    }
    out
}

/// Names of available input devices, skipping unnamed ones.
pub fn list_input_devices() -> Result<Vec<String>> {
    let host = cpal::default_host();
    let devices = host.input_devices().context("enumerate input devices")?;
    let mut names = Vec::new();
    for device in devices {
        if let Ok(name) = device.name() {
            if !name.trim().is_empty() {
                names.push(name);
            }
        }
    }
    Ok(names)
}

#[cfg(test)]
mod tests {
    use super::downmix_f32;

    #[test]
    fn averages_stereo_frames() {
        assert_eq!(downmix_f32(&[0.5, -0.5, 1.0, 0.0], 2), vec![0.0, 0.5]);
    }

    #[test]
    fn mono_passes_through() {
        assert_eq!(downmix_f32(&[0.1, -0.2, 0.3], 1), vec![0.1, -0.2, 0.3]);
    }

    #[test]
    fn ignores_trailing_partial_frame() {
        assert_eq!(downmix_f32(&[1.0], 2), Vec::<f32>::new());
        let out = downmix_f32(&[0.2, 0.4, 0.9], 2);
        assert_eq!(out.len(), 1);
        assert!((out[0] - 0.3).abs() < f32::EPSILON);
    }

    #[test]
    fn empty_input_is_empty() {
        assert!(downmix_f32(&[], 2).is_empty());
        assert!(downmix_f32(&[1.0, 2.0], 0).is_empty());
    }
}
