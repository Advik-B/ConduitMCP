//! Window and system control (section 8 "System and window"): root window
//! geometry and mode, display server identity, OS and platform info, and
//! runtime locale. Under the headless DisplayServer the window setters are
//! accepted no-ops, so `set` echoes the state after writing and the agent
//! sees what actually stuck (docs/api-gaps.md).

use godot::builtin::Vector2i;
use godot::classes::window::Mode;
use godot::classes::{DisplayServer, Os, TranslationServer};
use godot::prelude::*;
use serde_json::{json, Value};

use crate::dispatcher::{FrameContext, HandlerOutcome};
use crate::handlers::runtime::support::{optional_str, require_str, scene_root};
use crate::protocol::BridgeError;

pub fn window(args: &Value, _ctx: &FrameContext) -> HandlerOutcome {
    HandlerOutcome::Done((|| {
        let op = require_str(args, "op")?;
        match op.as_str() {
            "get_info" => get_info(),
            "set" => set(args),
            "os_info" => Ok(os_info()),
            "locale_get" => Ok(locale_get()),
            "locale_set" => locale_set(args),
            other => Err(BridgeError::InvalidArgs(format!(
                "unknown op '{other}'; expected get_info, set, os_info, locale_get, or locale_set"
            ))),
        }
    })())
}

fn get_info() -> Result<Value, BridgeError> {
    let window = scene_root()?;
    let display = DisplayServer::singleton();
    let display_name = display.get_name().to_string();
    let size = window.get_size();
    let position = window.get_position();
    Ok(json!({
        "size": { "x": size.x, "y": size.y },
        "position": { "x": position.x, "y": position.y },
        "mode": mode_name(window.get_mode()),
        "title": window.get_title().to_string(),
        "content_scale_factor": window.get_content_scale_factor(),
        "screen_count": display.get_screen_count(),
        "display_server": display_name,
        "headless": display_name == "headless",
    }))
}

fn set(args: &Value) -> Result<Value, BridgeError> {
    let mut window = scene_root()?;
    if let Some(size) = args.get("size") {
        let (x, y) = parse_ivec2(size, "size")?;
        window.set_size(Vector2i::new(x, y));
    }
    if let Some(position) = args.get("position") {
        let (x, y) = parse_ivec2(position, "position")?;
        window.set_position(Vector2i::new(x, y));
    }
    if let Some(title) = optional_str(args, "title") {
        window.set_title(title.as_str());
    }
    if let Some(mode) = optional_str(args, "mode") {
        let mode = mode_from_name(&mode)
            .ok_or_else(|| BridgeError::InvalidArgs(format!("unknown window mode '{mode}'")))?;
        window.set_mode(mode);
    }
    get_info()
}

fn os_info() -> Value {
    let os = Os::singleton();
    json!({
        "os": os.get_name().to_string(),
        "version": os.get_version().to_string(),
        "model": os.get_model_name().to_string(),
        "processor": os.get_processor_name().to_string(),
        "processor_count": os.get_processor_count(),
        "locale": os.get_locale().to_string(),
        "debug_build": Os::singleton().is_debug_build(),
    })
}

fn locale_get() -> Value {
    json!({
        "locale": TranslationServer::singleton().get_locale().to_string(),
        "os_locale": Os::singleton().get_locale().to_string(),
    })
}

fn locale_set(args: &Value) -> Result<Value, BridgeError> {
    let locale = require_str(args, "locale")?;
    TranslationServer::singleton().set_locale(locale.as_str());
    Ok(locale_get())
}

fn mode_name(mode: Mode) -> &'static str {
    match mode {
        Mode::WINDOWED => "windowed",
        Mode::MINIMIZED => "minimized",
        Mode::MAXIMIZED => "maximized",
        Mode::FULLSCREEN => "fullscreen",
        Mode::EXCLUSIVE_FULLSCREEN => "exclusive_fullscreen",
        _ => "unknown",
    }
}

fn mode_from_name(name: &str) -> Option<Mode> {
    Some(match name.trim().to_ascii_lowercase().as_str() {
        "windowed" => Mode::WINDOWED,
        "minimized" => Mode::MINIMIZED,
        "maximized" => Mode::MAXIMIZED,
        "fullscreen" => Mode::FULLSCREEN,
        "exclusive_fullscreen" => Mode::EXCLUSIVE_FULLSCREEN,
        _ => return None,
    })
}

fn parse_ivec2(value: &Value, name: &str) -> Result<(i32, i32), BridgeError> {
    if let Some(items) = value.as_array() {
        if items.len() == 2
            && let (Some(x), Some(y)) = (items[0].as_i64(), items[1].as_i64())
        {
            return Ok((x as i32, y as i32));
        }
    } else if let Some(obj) = value.as_object()
        && let (Some(x), Some(y)) =
            (obj.get("x").and_then(Value::as_i64), obj.get("y").and_then(Value::as_i64))
    {
        return Ok((x as i32, y as i32));
    }
    Err(BridgeError::InvalidArgs(format!("'{name}' must be [x, y] or {{x, y}} integers")))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn mode_names_round_trip() {
        for name in ["windowed", "minimized", "maximized", "fullscreen", "exclusive_fullscreen"] {
            let mode = mode_from_name(name).expect(name);
            assert_eq!(mode_name(mode), name);
        }
        assert_eq!(mode_from_name("cinema"), None);
    }
}
