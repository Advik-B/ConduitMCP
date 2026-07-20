//! Observation handlers: screenshots, performance counters, and incremental log
//! and error tailing (whitepaper sections 6.6 and 6.7).

use std::fs::File;
use std::io::{Read, Seek, SeekFrom};
use std::sync::atomic::{AtomicU64, Ordering};

use godot::classes::performance::Monitor;
use godot::classes::{DisplayServer, Image, Performance, ProjectSettings, RenderingServer};
use godot::prelude::*;
use serde_json::{json, Value};

use crate::dispatcher::{FrameContext, HandlerOutcome, PendingOp};
use crate::handlers::runtime::support::scene_root;
use crate::protocol::BridgeError;

const SCREENSHOT_DEADLINE_FRAMES: u64 = 600;
const DEFAULT_LOG_MAX_BYTES: usize = 64 * 1024;

/// Separate read offsets into the shared engine log for the log and error tails,
/// so each advances independently (whitepaper section 6.7). Handlers are
/// stateless function pointers, so the cursor lives here; both are touched only
/// on the main thread.
static LOG_OFFSET: AtomicU64 = AtomicU64::new(0);
static ERROR_OFFSET: AtomicU64 = AtomicU64::new(0);

/// Native receiver for `RenderingServer::frame_post_draw`, so the viewport is
/// read only after the frame is fully drawn (whitepaper section 6.6).
#[derive(GodotClass)]
#[class(base = RefCounted, init)]
pub struct ConduitFrameSink {
    base: Base<RefCounted>,
    drawn: bool,
}

#[godot_api]
impl ConduitFrameSink {
    #[func]
    fn on_frame(&mut self) {
        self.drawn = true;
    }
}

pub fn screenshot(args: &Value, ctx: &FrameContext) -> HandlerOutcome {
    if is_headless() {
        return HandlerOutcome::Done(Err(BridgeError::NotAvailableHeadless(
            "screenshots are unavailable under a headless display server".into(),
        )));
    }

    let max_dimension = args.get("max_dimension").and_then(Value::as_u64).map(|value| value as i32);
    let format = match args.get("format").and_then(Value::as_str).unwrap_or("png") {
        "jpg" | "jpeg" => ImageFormat::Jpg,
        _ => ImageFormat::Png,
    };

    let sink = ConduitFrameSink::new_gd();
    let callable = Callable::from_object_method(&sink, "on_frame");
    RenderingServer::singleton().connect("frame_post_draw", &callable);

    HandlerOutcome::Pending(Box::new(ScreenshotPending {
        sink,
        callable,
        max_dimension,
        format,
        deadline_frame: ctx.frame_index.saturating_add(SCREENSHOT_DEADLINE_FRAMES),
    }))
}

#[derive(Clone, Copy)]
enum ImageFormat {
    Png,
    Jpg,
}

impl ImageFormat {
    fn name(self) -> &'static str {
        match self {
            ImageFormat::Png => "png",
            ImageFormat::Jpg => "jpg",
        }
    }
}

struct ScreenshotPending {
    sink: Gd<ConduitFrameSink>,
    callable: Callable,
    max_dimension: Option<i32>,
    format: ImageFormat,
    deadline_frame: u64,
}

impl ScreenshotPending {
    fn disconnect(&mut self) {
        let mut server = RenderingServer::singleton();
        if server.is_connected("frame_post_draw", &self.callable) {
            server.disconnect("frame_post_draw", &self.callable);
        }
    }

    fn capture(&self) -> Result<Value, BridgeError> {
        let viewport = scene_root()?;
        let texture = viewport
            .get_texture()
            .ok_or_else(|| BridgeError::Internal("viewport has no texture".into()))?;
        let mut image = texture
            .get_image()
            .ok_or_else(|| BridgeError::NotAvailableHeadless("no rendered image available".into()))?;
        if image.is_empty() {
            return Err(BridgeError::NotAvailableHeadless("rendered image is empty".into()));
        }
        if let Some(max_dimension) = self.max_dimension {
            resize_within(&mut image, max_dimension);
        }
        let buffer = match self.format {
            ImageFormat::Png => image.save_png_to_buffer(),
            ImageFormat::Jpg => image.save_jpg_to_buffer(),
        };
        Ok(json!({
            "encoding": "base64",
            "format": self.format.name(),
            "width": image.get_width(),
            "height": image.get_height(),
            "image_base64": base64_encode(buffer.as_slice()),
        }))
    }
}

impl PendingOp for ScreenshotPending {
    fn poll(&mut self, ctx: &FrameContext) -> Option<Result<Value, BridgeError>> {
        if self.sink.bind().drawn {
            self.disconnect();
            return Some(self.capture());
        }
        if ctx.frame_index >= self.deadline_frame {
            self.disconnect();
            return Some(Err(BridgeError::Internal(
                "no frame was drawn before the screenshot deadline".into(),
            )));
        }
        None
    }
}

pub fn perf(_args: &Value, _ctx: &FrameContext) -> HandlerOutcome {
    let performance = Performance::singleton();
    let monitor = |monitor: Monitor| performance.get_monitor(monitor);
    HandlerOutcome::Done(Ok(json!({
        "fps": monitor(Monitor::TIME_FPS),
        "process_ms": monitor(Monitor::TIME_PROCESS) * 1000.0,
        "physics_process_ms": monitor(Monitor::TIME_PHYSICS_PROCESS) * 1000.0,
        "static_memory_bytes": monitor(Monitor::MEMORY_STATIC),
        "object_count": monitor(Monitor::OBJECT_COUNT),
        "node_count": monitor(Monitor::OBJECT_NODE_COUNT),
        "resource_count": monitor(Monitor::OBJECT_RESOURCE_COUNT),
        "draw_calls": monitor(Monitor::RENDER_TOTAL_DRAW_CALLS_IN_FRAME),
        "primitives": monitor(Monitor::RENDER_TOTAL_PRIMITIVES_IN_FRAME),
    })))
}

pub fn get_logs(args: &Value, _ctx: &FrameContext) -> HandlerOutcome {
    let max_bytes = log_max_bytes(args);
    let (text, truncated) = read_new_log(&LOG_OFFSET, max_bytes);
    HandlerOutcome::Done(Ok(json!({ "logs": text, "truncated": truncated })))
}

pub fn get_errors(args: &Value, _ctx: &FrameContext) -> HandlerOutcome {
    let max_bytes = log_max_bytes(args);
    let (text, truncated) = read_new_log(&ERROR_OFFSET, max_bytes);
    let errors: Vec<&str> = text
        .lines()
        .filter(|line| line.contains("ERROR") || line.contains("WARNING"))
        .collect();
    HandlerOutcome::Done(Ok(json!({ "errors": errors, "truncated": truncated })))
}

fn log_max_bytes(args: &Value) -> usize {
    args.get("max_bytes").and_then(Value::as_u64).map(|value| value as usize).unwrap_or(DEFAULT_LOG_MAX_BYTES)
}

fn is_headless() -> bool {
    DisplayServer::singleton().get_name().to_string().eq_ignore_ascii_case("headless")
}

fn resize_within(image: &mut Gd<Image>, max_dimension: i32) {
    if max_dimension <= 0 {
        return;
    }
    let (width, height) = (image.get_width(), image.get_height());
    let longest = width.max(height);
    if longest <= max_dimension {
        return;
    }
    let scale = max_dimension as f32 / longest as f32;
    let new_width = ((width as f32 * scale).round() as i32).max(1);
    let new_height = ((height as f32 * scale).round() as i32).max(1);
    image.resize(new_width, new_height);
}

fn log_file_path() -> Option<String> {
    let settings = ProjectSettings::singleton();
    let configured = settings.get_setting("debug/file_logging/log_path");
    let path = if configured.is_nil() {
        "user://logs/godot.log".to_string()
    } else {
        configured.to_string()
    };
    Some(settings.globalize_path(&path).to_string())
}

/// Read bytes appended to the engine log since `offset`, advancing it. Returns
/// the new text and whether it was clipped to `max_bytes` (the tail is kept).
fn read_new_log(offset: &AtomicU64, max_bytes: usize) -> (String, bool) {
    let Some(path) = log_file_path() else {
        return (String::new(), false);
    };
    let Ok(mut file) = File::open(&path) else {
        return (String::new(), false);
    };
    let len = file.metadata().map(|meta| meta.len()).unwrap_or(0);
    let mut start = offset.load(Ordering::Relaxed);
    if start > len {
        // The log was rotated or truncated; restart from the beginning.
        start = 0;
    }
    if start >= len {
        offset.store(len, Ordering::Relaxed);
        return (String::new(), false);
    }
    if file.seek(SeekFrom::Start(start)).is_err() {
        return (String::new(), false);
    }
    let mut buffer = Vec::with_capacity((len - start) as usize);
    if file.read_to_end(&mut buffer).is_err() {
        return (String::new(), false);
    }
    offset.store(len, Ordering::Relaxed);

    let truncated = buffer.len() > max_bytes;
    if truncated {
        let tail_start = buffer.len() - max_bytes;
        buffer.drain(0..tail_start);
    }
    (String::from_utf8_lossy(&buffer).into_owned(), truncated)
}

/// Standard base64 (RFC 4648) encoding. Implemented inline to keep the bridge's
/// dependency set minimal; only screenshot bytes flow through it.
fn base64_encode(bytes: &[u8]) -> String {
    const ALPHABET: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for chunk in bytes.chunks(3) {
        let b0 = chunk[0] as u32;
        let b1 = *chunk.get(1).unwrap_or(&0) as u32;
        let b2 = *chunk.get(2).unwrap_or(&0) as u32;
        let triple = (b0 << 16) | (b1 << 8) | b2;
        out.push(ALPHABET[(triple >> 18) as usize & 0x3f] as char);
        out.push(ALPHABET[(triple >> 12) as usize & 0x3f] as char);
        out.push(if chunk.len() > 1 { ALPHABET[(triple >> 6) as usize & 0x3f] as char } else { '=' });
        out.push(if chunk.len() > 2 { ALPHABET[triple as usize & 0x3f] as char } else { '=' });
    }
    out
}

#[cfg(test)]
mod tests {
    use super::base64_encode;

    #[test]
    fn base64_matches_known_vectors() {
        assert_eq!(base64_encode(b""), "");
        assert_eq!(base64_encode(b"f"), "Zg==");
        assert_eq!(base64_encode(b"fo"), "Zm8=");
        assert_eq!(base64_encode(b"foo"), "Zm9v");
        assert_eq!(base64_encode(b"foob"), "Zm9vYg==");
        assert_eq!(base64_encode(b"fooba"), "Zm9vYmE=");
        assert_eq!(base64_encode(b"foobar"), "Zm9vYmFy");
    }
}
