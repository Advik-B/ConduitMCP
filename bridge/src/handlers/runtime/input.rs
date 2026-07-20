//! Input simulation, consolidated behind a `device` discriminator (whitepaper
//! sections 6.6 and 7.1). Raw device events are fed through
//! `Input::parse_input_event` so the game reacts as if the input were real; a
//! press without a matching release models a held key across frames. Action-
//! level simulation drives the project's input map directly and is the robust
//! default when intent, not a specific binding, is what matters.

use godot::classes::{Input, InputEventKey, InputEventMouseButton, InputEventMouseMotion};
use godot::global::{Key, MouseButton};
use godot::obj::EngineEnum;
use godot::prelude::*;
use serde_json::{json, Value};

use crate::dispatcher::{FrameContext, HandlerOutcome};
use crate::handlers::runtime::support::require_str;
use crate::protocol::BridgeError;

pub fn input(args: &Value, _ctx: &FrameContext) -> HandlerOutcome {
    HandlerOutcome::Done((|| {
        let device = require_str(args, "device")?;
        match device.as_str() {
            "key" => inject_key(args),
            "action" => inject_action(args),
            "mouse_button" => inject_mouse_button(args),
            "mouse_motion" => inject_mouse_motion(args),
            other => Err(BridgeError::InvalidArgs(format!(
                "unknown input device '{other}'; expected key, action, mouse_button, or mouse_motion"
            ))),
        }
    })())
}

fn pressed_flag(args: &Value) -> bool {
    args.get("pressed").and_then(Value::as_bool).unwrap_or(true)
}

fn inject_key(args: &Value) -> Result<Value, BridgeError> {
    let key = resolve_key(args)?;
    let pressed = pressed_flag(args);
    let physical = args.get("physical").and_then(Value::as_bool).unwrap_or(false);

    let mut event = InputEventKey::new_gd();
    if physical {
        event.set_physical_keycode(key);
    } else {
        event.set_keycode(key);
    }
    event.set_pressed(pressed);
    Input::singleton().parse_input_event(&event);
    Ok(json!({ "injected": true, "device": "key", "pressed": pressed }))
}

fn inject_action(args: &Value) -> Result<Value, BridgeError> {
    let action = require_str(args, "action")?;
    let pressed = pressed_flag(args);
    let mut input = Input::singleton();
    if pressed {
        match args.get("strength").and_then(Value::as_f64) {
            Some(strength) => {
                input.action_press_ex(action.as_str()).strength(strength as f32).done();
            }
            None => input.action_press(action.as_str()),
        }
    } else {
        input.action_release(action.as_str());
    }
    Ok(json!({ "injected": true, "device": "action", "action": action, "pressed": pressed }))
}

fn inject_mouse_button(args: &Value) -> Result<Value, BridgeError> {
    let button = resolve_button(args)?;
    let pressed = pressed_flag(args);
    let mut event = InputEventMouseButton::new_gd();
    event.set_button_index(button);
    event.set_pressed(pressed);
    if let Some(position) = args.get("position").and_then(parse_vector2) {
        event.set_position(position);
        event.set_global_position(position);
    }
    Input::singleton().parse_input_event(&event);
    Ok(json!({ "injected": true, "device": "mouse_button", "pressed": pressed }))
}

fn inject_mouse_motion(args: &Value) -> Result<Value, BridgeError> {
    let position = args
        .get("position")
        .and_then(parse_vector2)
        .ok_or_else(|| BridgeError::InvalidArgs("mouse_motion requires a 'position'".into()))?;
    let mut event = InputEventMouseMotion::new_gd();
    event.set_position(position);
    event.set_global_position(position);
    if let Some(relative) = args.get("relative").and_then(parse_vector2) {
        event.set_relative(relative);
    }
    Input::singleton().parse_input_event(&event);
    Ok(json!({ "injected": true, "device": "mouse_motion" }))
}

fn resolve_key(args: &Value) -> Result<Key, BridgeError> {
    if let Some(code) = args.get("keycode").and_then(Value::as_i64) {
        return Key::try_from_ord(code as i32)
            .ok_or_else(|| BridgeError::InvalidArgs(format!("unknown keycode {code}")));
    }
    let name = require_str(args, "key")?;
    key_from_name(&name).ok_or_else(|| BridgeError::InvalidArgs(format!("unknown key '{name}'")))
}

/// Letters and digits map to their ASCII code, which equals the Godot keycode
/// (KEY_A == 65). Named keys cover the common movement and editing set.
fn key_from_name(name: &str) -> Option<Key> {
    let trimmed = name.trim();
    if let Some(single) = single_alnum(trimmed) {
        return Key::try_from_ord(single.to_ascii_uppercase() as i32);
    }
    Some(match trimmed.to_ascii_lowercase().as_str() {
        "space" => Key::SPACE,
        "enter" | "return" => Key::ENTER,
        "escape" | "esc" => Key::ESCAPE,
        "tab" => Key::TAB,
        "backspace" => Key::BACKSPACE,
        "delete" | "del" => Key::DELETE,
        "left" => Key::LEFT,
        "right" => Key::RIGHT,
        "up" => Key::UP,
        "down" => Key::DOWN,
        "shift" => Key::SHIFT,
        "ctrl" | "control" => Key::CTRL,
        "alt" => Key::ALT,
        _ => return None,
    })
}

/// The single alphanumeric character of `s`, or `None` if `s` is not exactly one.
fn single_alnum(s: &str) -> Option<char> {
    let mut chars = s.chars();
    match (chars.next(), chars.next()) {
        (Some(single), None) if single.is_ascii_alphanumeric() => Some(single),
        _ => None,
    }
}

fn resolve_button(args: &Value) -> Result<MouseButton, BridgeError> {
    if let Some(index) = args.get("button").and_then(Value::as_i64) {
        return MouseButton::try_from_ord(index as i32)
            .ok_or_else(|| BridgeError::InvalidArgs(format!("unknown mouse button {index}")));
    }
    let name = require_str(args, "button")?;
    Ok(match name.to_ascii_lowercase().as_str() {
        "left" => MouseButton::LEFT,
        "right" => MouseButton::RIGHT,
        "middle" => MouseButton::MIDDLE,
        "wheel_up" => MouseButton::WHEEL_UP,
        "wheel_down" => MouseButton::WHEEL_DOWN,
        other => {
            return Err(BridgeError::InvalidArgs(format!("unknown mouse button '{other}'")));
        }
    })
}

fn parse_vector2(value: &Value) -> Option<Vector2> {
    if let Some(items) = value.as_array() {
        if items.len() == 2 {
            return Some(Vector2::new(items[0].as_f64()? as f32, items[1].as_f64()? as f32));
        }
        return None;
    }
    let object = value.as_object()?;
    Some(Vector2::new(object.get("x")?.as_f64()? as f32, object.get("y")?.as_f64()? as f32))
}
