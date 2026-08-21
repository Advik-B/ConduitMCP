//! Observation handlers: screenshots, performance counters, and incremental log
//! and error tailing (whitepaper sections 6.6 and 6.7).

use std::sync::atomic::{AtomicU64, Ordering};

use godot::classes::performance::Monitor;
use godot::classes::{DisplayServer, Image, Performance, RenderingServer};
use godot::prelude::*;
use serde_json::{json, Value};

use crate::base64;
use crate::dispatcher::{FrameContext, HandlerOutcome, PendingOp};
use crate::handlers::runtime::support::scene_root;
use crate::log_tail;
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

impl ConduitFrameSink {
    pub(crate) fn drawn(&self) -> bool {
        self.drawn
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
pub(crate) enum ImageFormat {
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

    pub(crate) fn from_arg(value: &str) -> Self {
        match value {
            "jpg" | "jpeg" => ImageFormat::Jpg,
            _ => ImageFormat::Png,
        }
    }
}

/// Whether the display server cannot render (headless), used to reject visual
/// tools with a clear error rather than returning an empty image.
pub(crate) fn is_headless_display() -> bool {
    is_headless()
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
        encode_viewport(&viewport.upcast(), self.max_dimension, self.format)
    }
}

/// Read a viewport's rendered texture and return it as a base64 image result.
/// Shared by the game screenshot (`gd_screenshot`) and the editor screenshot
/// (`gd_editor_screenshot`), which differ only in which viewport they capture.
pub(crate) fn encode_viewport(
    viewport: &Gd<godot::classes::Viewport>,
    max_dimension: Option<i32>,
    format: ImageFormat,
) -> Result<Value, BridgeError> {
    let texture = viewport
        .get_texture()
        .ok_or_else(|| BridgeError::Internal("viewport has no texture".into()))?;
    let mut image = texture
        .get_image()
        .ok_or_else(|| BridgeError::NotAvailableHeadless("no rendered image available".into()))?;
    if image.is_empty() {
        return Err(BridgeError::NotAvailableHeadless("rendered image is empty".into()));
    }
    if let Some(max_dimension) = max_dimension {
        resize_within(&mut image, max_dimension);
    }
    let buffer = match format {
        ImageFormat::Png => image.save_png_to_buffer(),
        ImageFormat::Jpg => image.save_jpg_to_buffer(),
    };
    Ok(json!({
        "encoding": "base64",
        "format": format.name(),
        "width": image.get_width(),
        "height": image.get_height(),
        "image_base64": base64::encode(buffer.as_slice()),
    }))
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

/// Read bytes appended to the engine log since `offset`, advancing it. Returns
/// the new text and whether it was clipped to `max_bytes` (the tail is kept).
///
/// A log that cannot be opened reads as "nothing new" rather than as an error,
/// which is right for a game and wrong for the editor: a game writes its log
/// itself, so absence means the engine has not written yet and a later call
/// answers. The editor pair (`handlers/editor/logs.rs`) reports the same
/// condition as `log_unavailable`, because there it means nobody said where the
/// log is.
fn read_new_log(offset: &AtomicU64, max_bytes: usize) -> (String, bool) {
    let path = log_tail::game_log_path();
    let start = offset.load(Ordering::Relaxed);
    match log_tail::read_log_range(&path, start, max_bytes) {
        Ok(slice) => {
            offset.store(slice.next_offset, Ordering::Relaxed);
            (slice.text, slice.truncated)
        }
        Err(_) => (String::new(), false),
    }
}
