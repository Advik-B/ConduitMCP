//! Input simulation, consolidated behind a `device` discriminator (whitepaper
//! sections 6.6 and 7.1). Raw device events are fed through
//! `Input::parse_input_event` so the game reacts as if the input were real; a
//! press without a matching release models a held key across frames. Action-
//! level simulation drives the project's input map directly and is the robust
//! default when intent, not a specific binding, is what matters.

use godot::classes::{
    Input, InputEventJoypadButton, InputEventJoypadMotion, InputEventKey,
    InputEventMagnifyGesture, InputEventMouseButton, InputEventMouseMotion, InputEventPanGesture,
    InputEventScreenDrag, InputEventScreenTouch,
};
use godot::global::{JoyAxis, JoyButton, Key, MouseButton};
use godot::obj::EngineEnum;
use godot::prelude::*;
use serde_json::{json, Value};

use crate::dispatcher::{FrameContext, HandlerOutcome};
use crate::handlers::runtime::support::{require_f64, require_str};
use crate::protocol::BridgeError;

pub fn input(args: &Value, _ctx: &FrameContext) -> HandlerOutcome {
    HandlerOutcome::Done((|| {
        let device = require_str(args, "device")?;
        match device.as_str() {
            "key" => inject_key(args),
            "action" => inject_action(args),
            "mouse_button" => inject_mouse_button(args),
            "mouse_motion" => inject_mouse_motion(args),
            "joy_button" => inject_joy_button(args),
            "joy_motion" => inject_joy_motion(args),
            "touch" => inject_touch(args),
            "touch_drag" => inject_touch_drag(args),
            "magnify" => inject_magnify(args),
            "pan" => inject_pan(args),
            other => Err(BridgeError::InvalidArgs(format!(
                "unknown input device '{other}'; expected key, action, mouse_button, mouse_motion, joy_button, joy_motion, touch, touch_drag, magnify, or pan"
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

fn inject_joy_button(args: &Value) -> Result<Value, BridgeError> {
    let button = resolve_joy_button(args)?;
    let pressed = pressed_flag(args);
    let mut event = InputEventJoypadButton::new_gd();
    event.set_button_index(button);
    event.set_pressed(pressed);
    event.set_device(device_id(args));
    Input::singleton().parse_input_event(&event);
    Ok(json!({ "injected": true, "device": "joy_button", "button": button.ord(), "pressed": pressed }))
}

// Drives actions bound to the axis; a nonzero value holds the bound action's
// strength until a value of 0.0 releases it. `Input::get_joy_axis` reflects
// only real devices, so verification reads action strength (docs/api-gaps.md).
fn inject_joy_motion(args: &Value) -> Result<Value, BridgeError> {
    let axis = resolve_joy_axis(args)?;
    let value = require_f64(args, "value")?;
    if !(-1.0..=1.0).contains(&value) {
        return Err(BridgeError::InvalidArgs(format!(
            "joy_motion value {value} is out of range; expected -1.0 to 1.0"
        )));
    }
    let mut event = InputEventJoypadMotion::new_gd();
    event.set_axis(axis);
    event.set_axis_value(value as f32);
    event.set_device(device_id(args));
    Input::singleton().parse_input_event(&event);
    Ok(json!({ "injected": true, "device": "joy_motion", "axis": axis.ord(), "value": value }))
}

fn inject_touch(args: &Value) -> Result<Value, BridgeError> {
    let position = require_position(args, "touch")?;
    let pressed = pressed_flag(args);
    let mut event = InputEventScreenTouch::new_gd();
    event.set_index(touch_index(args));
    event.set_position(position);
    event.set_pressed(pressed);
    if let Some(double_tap) = args.get("double_tap").and_then(Value::as_bool) {
        event.set_double_tap(double_tap);
    }
    Input::singleton().parse_input_event(&event);
    Ok(json!({ "injected": true, "device": "touch", "pressed": pressed }))
}

fn inject_touch_drag(args: &Value) -> Result<Value, BridgeError> {
    let position = require_position(args, "touch_drag")?;
    let mut event = InputEventScreenDrag::new_gd();
    event.set_index(touch_index(args));
    event.set_position(position);
    if let Some(relative) = args.get("relative").and_then(parse_vector2) {
        event.set_relative(relative);
    }
    if let Some(velocity) = args.get("velocity").and_then(parse_vector2) {
        event.set_velocity(velocity);
    }
    Input::singleton().parse_input_event(&event);
    Ok(json!({ "injected": true, "device": "touch_drag" }))
}

fn inject_magnify(args: &Value) -> Result<Value, BridgeError> {
    let factor = require_f64(args, "factor")?;
    let mut event = InputEventMagnifyGesture::new_gd();
    event.set_factor(factor as f32);
    if let Some(position) = args.get("position").and_then(parse_vector2) {
        event.set_position(position);
    }
    Input::singleton().parse_input_event(&event);
    Ok(json!({ "injected": true, "device": "magnify", "factor": factor }))
}

fn inject_pan(args: &Value) -> Result<Value, BridgeError> {
    let delta = args
        .get("delta")
        .and_then(parse_vector2)
        .ok_or_else(|| BridgeError::InvalidArgs("pan requires a 'delta'".into()))?;
    let mut event = InputEventPanGesture::new_gd();
    event.set_delta(delta);
    if let Some(position) = args.get("position").and_then(parse_vector2) {
        event.set_position(position);
    }
    Input::singleton().parse_input_event(&event);
    Ok(json!({ "injected": true, "device": "pan" }))
}

fn device_id(args: &Value) -> i32 {
    args.get("device_id").and_then(Value::as_i64).unwrap_or(0) as i32
}

fn touch_index(args: &Value) -> i32 {
    args.get("index").and_then(Value::as_i64).unwrap_or(0) as i32
}

fn require_position(args: &Value, device: &str) -> Result<Vector2, BridgeError> {
    args.get("position")
        .and_then(parse_vector2)
        .ok_or_else(|| BridgeError::InvalidArgs(format!("{device} requires a 'position'")))
}

fn resolve_joy_button(args: &Value) -> Result<JoyButton, BridgeError> {
    if let Some(index) = args.get("button").and_then(Value::as_i64) {
        return JoyButton::try_from_ord(index as i32)
            .ok_or_else(|| BridgeError::InvalidArgs(format!("unknown joypad button {index}")));
    }
    let name = require_str(args, "button")?;
    joy_button_from_name(&name)
        .ok_or_else(|| BridgeError::InvalidArgs(format!("unknown joypad button '{name}'")))
}

fn resolve_joy_axis(args: &Value) -> Result<JoyAxis, BridgeError> {
    if let Some(index) = args.get("axis").and_then(Value::as_i64) {
        return JoyAxis::try_from_ord(index as i32)
            .ok_or_else(|| BridgeError::InvalidArgs(format!("unknown joypad axis {index}")));
    }
    let name = require_str(args, "axis")?;
    joy_axis_from_name(&name)
        .ok_or_else(|| BridgeError::InvalidArgs(format!("unknown joypad axis '{name}'")))
}

/// Xbox-style names for the SDL-layout joypad buttons Godot exposes.
fn joy_button_from_name(name: &str) -> Option<JoyButton> {
    Some(match name.trim().to_ascii_lowercase().as_str() {
        "a" => JoyButton::A,
        "b" => JoyButton::B,
        "x" => JoyButton::X,
        "y" => JoyButton::Y,
        "lb" | "left_shoulder" => JoyButton::LEFT_SHOULDER,
        "rb" | "right_shoulder" => JoyButton::RIGHT_SHOULDER,
        "l3" | "left_stick" => JoyButton::LEFT_STICK,
        "r3" | "right_stick" => JoyButton::RIGHT_STICK,
        "start" => JoyButton::START,
        "back" | "select" => JoyButton::BACK,
        "guide" => JoyButton::GUIDE,
        "dpad_up" => JoyButton::DPAD_UP,
        "dpad_down" => JoyButton::DPAD_DOWN,
        "dpad_left" => JoyButton::DPAD_LEFT,
        "dpad_right" => JoyButton::DPAD_RIGHT,
        _ => return None,
    })
}

fn joy_axis_from_name(name: &str) -> Option<JoyAxis> {
    Some(match name.trim().to_ascii_lowercase().as_str() {
        "left_x" => JoyAxis::LEFT_X,
        "left_y" => JoyAxis::LEFT_Y,
        "right_x" => JoyAxis::RIGHT_X,
        "right_y" => JoyAxis::RIGHT_Y,
        "trigger_left" => JoyAxis::TRIGGER_LEFT,
        "trigger_right" => JoyAxis::TRIGGER_RIGHT,
        _ => return None,
    })
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
/// Shared with the editor's input-map handler so both accept the same names.
pub(crate) fn key_from_name(name: &str) -> Option<Key> {
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

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn joy_button_names_map_to_sdl_layout() {
        assert_eq!(joy_button_from_name("a"), Some(JoyButton::A));
        assert_eq!(joy_button_from_name("LB"), Some(JoyButton::LEFT_SHOULDER));
        assert_eq!(joy_button_from_name("dpad_left"), Some(JoyButton::DPAD_LEFT));
        assert_eq!(joy_button_from_name("select"), Some(JoyButton::BACK));
        assert_eq!(joy_button_from_name("kick"), None);
    }

    #[test]
    fn joy_axis_names_map_to_sticks_and_triggers() {
        assert_eq!(joy_axis_from_name("left_x"), Some(JoyAxis::LEFT_X));
        assert_eq!(joy_axis_from_name("TRIGGER_RIGHT"), Some(JoyAxis::TRIGGER_RIGHT));
        assert_eq!(joy_axis_from_name("middle_x"), None);
    }

    #[test]
    fn joy_resolvers_accept_ordinals_and_reject_unknowns() {
        assert_eq!(resolve_joy_button(&json!({ "button": 0 })).unwrap(), JoyButton::A);
        assert_eq!(resolve_joy_axis(&json!({ "axis": 0 })).unwrap(), JoyAxis::LEFT_X);
        assert_eq!(resolve_joy_button(&json!({ "button": 9999 })).unwrap_err().code(), "invalid_args");
        assert_eq!(resolve_joy_axis(&json!({ "axis": "warp" })).unwrap_err().code(), "invalid_args");
    }
}
