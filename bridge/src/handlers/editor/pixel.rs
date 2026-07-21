//! Tier-3 pixel-fallback tools (whitepaper section 6.8), the last resort for the
//! residual editor gestures with no semantic (tier 1) or control-tree (tier 2)
//! equivalent. Input is synthesised through `Viewport::push_input` on the editor's
//! base-control viewport with editor-window coordinates, which keeps the tools
//! independent of OS cursor position and window focus, rather than warping the
//! real cursor. These handlers are registered unconditionally in the bridge; the
//! broker gates their exposure behind an explicit opt-in flag (section 15), so an
//! agent never sees them unless the operator turns them on.

use godot::classes::{DisplayServer, EditorInterface, InputEventMouseButton, InputEventMouseMotion, Viewport};
use godot::global::{MouseButton, MouseButtonMask};
use godot::prelude::*;
use serde_json::{json, Value};

use crate::dispatcher::{FrameContext, HandlerOutcome, PendingOp};
use crate::handlers::args::{optional_bool, optional_str, optional_u64, require_f64};
use crate::handlers::runtime::observe::is_headless_display;
use crate::protocol::BridgeError;

const DEFAULT_DRAG_STEPS: u64 = 8;
const MAX_DRAG_STEPS: u64 = 256;

/// The editor's base-control viewport, the coordinate space `gd_editor_window_info`
/// reports and the target for synthesised input.
fn editor_viewport() -> Result<Gd<Viewport>, BridgeError> {
    let base = EditorInterface::singleton()
        .get_base_control()
        .ok_or_else(|| BridgeError::Internal("editor has no base control".into()))?;
    base.get_viewport()
        .ok_or_else(|| BridgeError::Internal("editor base control has no viewport".into()))
}

/// Read an `x`/`y` pixel position from the given keys.
fn read_point(args: &Value, x_key: &str, y_key: &str) -> Result<Vector2, BridgeError> {
    let x = require_f64(args, x_key)? as f32;
    let y = require_f64(args, y_key)? as f32;
    Ok(Vector2::new(x, y))
}

/// The mouse button named by `button`, defaulting to the left button. Only the
/// three physical buttons are meaningful for editor gestures.
fn resolve_button(args: &Value) -> Result<(MouseButton, MouseButtonMask), BridgeError> {
    let name = optional_str(args, "button").unwrap_or_else(|| "left".into());
    Ok(match name.to_ascii_lowercase().as_str() {
        "left" => (MouseButton::LEFT, MouseButtonMask::LEFT),
        "right" => (MouseButton::RIGHT, MouseButtonMask::RIGHT),
        "middle" => (MouseButton::MIDDLE, MouseButtonMask::MIDDLE),
        other => {
            return Err(BridgeError::InvalidArgs(format!(
                "unknown mouse button '{other}'; expected left, right, or middle"
            )));
        }
    })
}

fn reject_headless() -> Option<HandlerOutcome> {
    if is_headless_display() {
        return Some(HandlerOutcome::Done(Err(BridgeError::NotAvailableHeadless(
            "pixel input is unavailable under a headless display server".into(),
        ))));
    }
    None
}

fn motion_event(position: Vector2, mask: MouseButtonMask) -> Gd<InputEventMouseMotion> {
    let mut event = InputEventMouseMotion::new_gd();
    event.set_position(position);
    event.set_global_position(position);
    event.set_button_mask(mask);
    event
}

fn button_event(position: Vector2, button: MouseButton, pressed: bool, double: bool) -> Gd<InputEventMouseButton> {
    let mut event = InputEventMouseButton::new_gd();
    event.set_button_index(button);
    event.set_pressed(pressed);
    event.set_double_click(double);
    event.set_position(position);
    event.set_global_position(position);
    event
}

/// Move the synthetic cursor to an editor-window coordinate.
pub fn pixel_move(args: &Value, _ctx: &FrameContext) -> HandlerOutcome {
    if let Some(outcome) = reject_headless() {
        return outcome;
    }
    HandlerOutcome::Done(pixel_move_inner(args))
}

fn pixel_move_inner(args: &Value) -> Result<Value, BridgeError> {
    let position = read_point(args, "x", "y")?;
    let mut viewport = editor_viewport()?;
    viewport.push_input(&motion_event(position, MouseButtonMask::default()));
    Ok(json!({ "moved": true, "x": position.x, "y": position.y }))
}

/// Press and release a mouse button at an editor-window coordinate.
pub fn pixel_click(args: &Value, _ctx: &FrameContext) -> HandlerOutcome {
    if let Some(outcome) = reject_headless() {
        return outcome;
    }
    HandlerOutcome::Done(pixel_click_inner(args))
}

fn pixel_click_inner(args: &Value) -> Result<Value, BridgeError> {
    let position = read_point(args, "x", "y")?;
    let (button, _) = resolve_button(args)?;
    let double = optional_bool(args, "double").unwrap_or(false);
    let button_name = optional_str(args, "button").unwrap_or_else(|| "left".into());

    let mut viewport = editor_viewport()?;
    viewport.push_input(&button_event(position, button, true, double));
    viewport.push_input(&button_event(position, button, false, false));
    Ok(json!({
        "clicked": true,
        "x": position.x,
        "y": position.y,
        "button": button_name,
        "double": double,
    }))
}

/// Drag from one editor-window coordinate to another with a button held. The press,
/// interpolated motion, and release are emitted one per frame through a pending op,
/// because the editor's drag detection reacts to motion across frames rather than a
/// single-frame burst.
pub fn pixel_drag(args: &Value, _ctx: &FrameContext) -> HandlerOutcome {
    if let Some(outcome) = reject_headless() {
        return outcome;
    }
    let from = match read_point(args, "from_x", "from_y") {
        Ok(point) => point,
        Err(error) => return HandlerOutcome::Done(Err(error)),
    };
    let to = match read_point(args, "to_x", "to_y") {
        Ok(point) => point,
        Err(error) => return HandlerOutcome::Done(Err(error)),
    };
    let (button, mask) = match resolve_button(args) {
        Ok(pair) => pair,
        Err(error) => return HandlerOutcome::Done(Err(error)),
    };
    let steps = optional_u64(args, "steps").unwrap_or(DEFAULT_DRAG_STEPS).clamp(1, MAX_DRAG_STEPS);
    let button_name = optional_str(args, "button").unwrap_or_else(|| "left".into());

    let mut queue: Vec<DragStep> = Vec::with_capacity(steps as usize + 2);
    queue.push(DragStep::Press(from));
    for index in 1..=steps {
        let fraction = index as f32 / steps as f32;
        queue.push(DragStep::Motion(from.lerp(to, fraction)));
    }
    queue.push(DragStep::Release(to));
    queue.reverse();

    HandlerOutcome::Pending(Box::new(DragPending {
        queue,
        button,
        mask,
        result: json!({
            "dragged": true,
            "from": { "x": from.x, "y": from.y },
            "to": { "x": to.x, "y": to.y },
            "button": button_name,
            "steps": steps,
        }),
    }))
}

enum DragStep {
    Press(Vector2),
    Motion(Vector2),
    Release(Vector2),
}

struct DragPending {
    queue: Vec<DragStep>,
    button: MouseButton,
    mask: MouseButtonMask,
    result: Value,
}

impl PendingOp for DragPending {
    fn poll(&mut self, _ctx: &FrameContext) -> Option<Result<Value, BridgeError>> {
        let step = match self.queue.pop() {
            Some(step) => step,
            None => return Some(Ok(self.result.clone())),
        };
        let mut viewport = match editor_viewport() {
            Ok(viewport) => viewport,
            Err(error) => return Some(Err(error)),
        };
        match step {
            DragStep::Press(position) => viewport.push_input(&button_event(position, self.button, true, false)),
            DragStep::Motion(position) => viewport.push_input(&motion_event(position, self.mask)),
            DragStep::Release(position) => {
                viewport.push_input(&button_event(position, self.button, false, false));
                return Some(Ok(self.result.clone()));
            }
        }
        None
    }
}

/// Report the editor window's geometry and scale so pixel coordinates are computed
/// rather than guessed. Read-only.
pub fn window_info(_args: &Value, _ctx: &FrameContext) -> HandlerOutcome {
    HandlerOutcome::Done(window_info_inner())
}

fn window_info_inner() -> Result<Value, BridgeError> {
    let display = DisplayServer::singleton();
    let size = display.window_get_size();
    let position = display.window_get_position();
    let editor_scale = EditorInterface::singleton().get_editor_scale();
    Ok(json!({
        "size": { "width": size.x, "height": size.y },
        "position": { "x": position.x, "y": position.y },
        "editor_scale": editor_scale,
        "screen_scale": display.screen_get_scale(),
        "screen_dpi": display.screen_get_dpi(),
        "headless": is_headless_display(),
    }))
}
