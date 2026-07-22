//! Input-map management (whitepaper section 8 "Project and session"). Actions
//! live as `input/{action}` project settings whose value is a dictionary of
//! `deadzone` and `events` (an array of InputEvent resources). Events cross
//! the wire as typed JSON objects discriminated by `type`. Settings-file
//! writes, not undo-wrapped; the editor's live InputMap is deliberately not
//! reloaded (it holds editor bindings), so changes apply to subsequently
//! launched games, which read the map at startup.

use godot::classes::{
    InputEvent, InputEventJoypadButton, InputEventJoypadMotion, InputEventKey, InputEventMouseButton,
    ProjectSettings,
};
use godot::global::Error as GdError;
use godot::global::{JoyAxis, JoyButton, Key, MouseButton};
use godot::obj::EngineEnum;
use godot::prelude::*;
use serde_json::{json, Value};

use crate::dispatcher::{FrameContext, HandlerOutcome};
use crate::handlers::args::{optional_f64, optional_u64, require_str};
use crate::handlers::runtime::input::key_from_name;
use crate::protocol::BridgeError;

const PREFIX: &str = "input/";
// The editor's default deadzone for a newly created action.
const DEFAULT_DEADZONE: f64 = 0.5;

pub fn input_map(args: &Value, _ctx: &FrameContext) -> HandlerOutcome {
    HandlerOutcome::Done((|| {
        let op = require_str(args, "op")?;
        match op.as_str() {
            "list" => list(),
            "add_action" => add_action(args),
            "remove_action" => remove_action(args),
            "add_event" => add_event(args),
            "remove_event" => remove_event(args),
            other => Err(BridgeError::InvalidArgs(format!(
                "unknown input_map op '{other}'; expected list, add_action, remove_action, add_event, or remove_event"
            ))),
        }
    })())
}

fn validate_action(action: &str) -> Result<(), BridgeError> {
    if action.is_empty() || action.contains('/') {
        return Err(BridgeError::InvalidArgs(format!("invalid action name '{action}'")));
    }
    Ok(())
}

/// The stored `{deadzone, events}` dictionary of an action, or an error if
/// the action does not exist in the project settings.
fn read_action(action: &str) -> Result<(f64, Array<Gd<InputEvent>>), BridgeError> {
    let settings = ProjectSettings::singleton();
    let key = format!("{PREFIX}{action}");
    if !settings.has_setting(key.as_str()) {
        return Err(BridgeError::InvalidArgs(format!("no input action named '{action}'")));
    }
    let stored = settings.get_setting(key.as_str());
    let dict = stored
        .try_to::<VarDictionary>()
        .map_err(|_| BridgeError::Internal(format!("setting '{key}' is not an action dictionary")))?;
    let deadzone = dict
        .get(&GString::from("deadzone"))
        .and_then(|v| v.try_to::<f64>().ok())
        .unwrap_or(DEFAULT_DEADZONE);
    let mut events = Array::<Gd<InputEvent>>::new();
    if let Some(raw) = dict.get(&GString::from("events")).and_then(|v| v.try_to::<VarArray>().ok()) {
        for item in raw.iter_shared() {
            if let Ok(event) = item.try_to::<Gd<InputEvent>>() {
                events.push(&event);
            }
        }
    }
    Ok((deadzone, events))
}

fn write_action(action: &str, deadzone: f64, events: &Array<Gd<InputEvent>>) -> Result<(), BridgeError> {
    let mut stored_events = VarArray::new();
    for event in events.iter_shared() {
        stored_events.push(&event.to_variant());
    }
    let mut dict = VarDictionary::new();
    dict.set(&GString::from("deadzone"), &deadzone.to_variant());
    dict.set(&GString::from("events"), &stored_events.to_variant());

    let mut settings = ProjectSettings::singleton();
    settings.set_setting(format!("{PREFIX}{action}").as_str(), &dict.to_variant());
    save(&mut settings)
}

fn save(settings: &mut Gd<ProjectSettings>) -> Result<(), BridgeError> {
    let save_err = settings.save();
    if save_err != GdError::OK {
        return Err(BridgeError::ResourceError(format!("failed to save project settings: {save_err:?}")));
    }
    Ok(())
}

/// Encode an InputEvent as the wire form, discriminated by `type`.
fn encode_event(event: &Gd<InputEvent>) -> Value {
    if let Ok(key) = event.clone().try_cast::<InputEventKey>() {
        let mut entry = json!({ "type": "key", "text": event.as_text().to_string() });
        if key.get_keycode() != Key::NONE {
            entry["keycode"] = json!(key.get_keycode().ord());
        }
        if key.get_physical_keycode() != Key::NONE {
            entry["physical_keycode"] = json!(key.get_physical_keycode().ord());
        }
        for (name, active) in [
            ("shift", key.is_shift_pressed()),
            ("ctrl", key.is_ctrl_pressed()),
            ("alt", key.is_alt_pressed()),
            ("meta", key.is_meta_pressed()),
        ] {
            if active {
                entry[name] = json!(true);
            }
        }
        return entry;
    }
    if let Ok(button) = event.clone().try_cast::<InputEventJoypadButton>() {
        return json!({ "type": "joy_button", "button_index": button.get_button_index().ord(), "text": event.as_text().to_string() });
    }
    if let Ok(motion) = event.clone().try_cast::<InputEventJoypadMotion>() {
        return json!({ "type": "joy_motion", "axis": motion.get_axis().ord(), "axis_value": motion.get_axis_value(), "text": event.as_text().to_string() });
    }
    if let Ok(mouse) = event.clone().try_cast::<InputEventMouseButton>() {
        return json!({ "type": "mouse_button", "button_index": mouse.get_button_index().ord(), "text": event.as_text().to_string() });
    }
    json!({ "type": "other", "class": event.get_class().to_string(), "text": event.as_text().to_string() })
}

/// Decode the wire form into an InputEvent. Field validation happens before
/// any engine object is constructed so bad input fails fast.
fn decode_event(value: &Value) -> Result<Gd<InputEvent>, BridgeError> {
    let kind = value
        .get("type")
        .and_then(Value::as_str)
        .ok_or_else(|| BridgeError::InvalidArgs("'event.type' is required".into()))?;
    match kind {
        "key" => {
            let key = decode_key(value)?;
            let physical = value.get("physical").and_then(Value::as_bool).unwrap_or(false);
            let mut event = InputEventKey::new_gd();
            if physical {
                event.set_physical_keycode(key);
            } else {
                event.set_keycode(key);
            }
            event.set_shift_pressed(value.get("shift").and_then(Value::as_bool).unwrap_or(false));
            event.set_ctrl_pressed(value.get("ctrl").and_then(Value::as_bool).unwrap_or(false));
            event.set_alt_pressed(value.get("alt").and_then(Value::as_bool).unwrap_or(false));
            event.set_meta_pressed(value.get("meta").and_then(Value::as_bool).unwrap_or(false));
            Ok(event.upcast())
        }
        "joy_button" => {
            let index = value
                .get("button_index")
                .and_then(Value::as_i64)
                .ok_or_else(|| BridgeError::InvalidArgs("'event.button_index' is required for joy_button".into()))?;
            let button = JoyButton::try_from_ord(index as i32)
                .ok_or_else(|| BridgeError::InvalidArgs(format!("unknown joypad button {index}")))?;
            let mut event = InputEventJoypadButton::new_gd();
            event.set_button_index(button);
            Ok(event.upcast())
        }
        "joy_motion" => {
            let axis_ord = value
                .get("axis")
                .and_then(Value::as_i64)
                .ok_or_else(|| BridgeError::InvalidArgs("'event.axis' is required for joy_motion".into()))?;
            let axis = JoyAxis::try_from_ord(axis_ord as i32)
                .ok_or_else(|| BridgeError::InvalidArgs(format!("unknown joypad axis {axis_ord}")))?;
            let axis_value = value.get("axis_value").and_then(Value::as_f64).unwrap_or(1.0);
            let mut event = InputEventJoypadMotion::new_gd();
            event.set_axis(axis);
            event.set_axis_value(axis_value as f32);
            Ok(event.upcast())
        }
        "mouse_button" => {
            let index = value
                .get("button_index")
                .and_then(Value::as_i64)
                .ok_or_else(|| BridgeError::InvalidArgs("'event.button_index' is required for mouse_button".into()))?;
            let button = MouseButton::try_from_ord(index as i32)
                .ok_or_else(|| BridgeError::InvalidArgs(format!("unknown mouse button {index}")))?;
            let mut event = InputEventMouseButton::new_gd();
            event.set_button_index(button);
            Ok(event.upcast())
        }
        other => Err(BridgeError::InvalidArgs(format!(
            "unknown event type '{other}'; expected key, joy_button, joy_motion, or mouse_button"
        ))),
    }
}

/// The key of a `key` event: a `key` name (same names as gd_input) or a raw
/// `keycode` ordinal.
fn decode_key(value: &Value) -> Result<Key, BridgeError> {
    if let Some(code) = value.get("keycode").and_then(Value::as_i64) {
        return Key::try_from_ord(code as i32)
            .ok_or_else(|| BridgeError::InvalidArgs(format!("unknown keycode {code}")));
    }
    let name = value
        .get("key")
        .and_then(Value::as_str)
        .ok_or_else(|| BridgeError::InvalidArgs("a key event needs 'key' (a name) or 'keycode'".into()))?;
    key_from_name(name).ok_or_else(|| BridgeError::InvalidArgs(format!("unknown key '{name}'")))
}

fn list() -> Result<Value, BridgeError> {
    let settings = ProjectSettings::singleton();
    let mut actions = Vec::new();
    for entry in settings.get_property_list().iter_shared() {
        let key = entry.get(&GString::from("name")).map(|v| v.to_string()).unwrap_or_default();
        let Some(action) = key.strip_prefix(PREFIX) else { continue };
        let Ok((deadzone, events)) = read_action(action) else { continue };
        let events_json: Vec<Value> = events
            .iter_shared()
            .enumerate()
            .map(|(index, event)| {
                let mut encoded = encode_event(&event);
                encoded["index"] = json!(index);
                encoded
            })
            .collect();
        actions.push(json!({ "action": action, "deadzone": deadzone, "events": events_json }));
    }
    Ok(json!({ "actions": actions }))
}

fn add_action(args: &Value) -> Result<Value, BridgeError> {
    let action = require_str(args, "action")?;
    validate_action(&action)?;
    let deadzone = optional_f64(args, "deadzone").unwrap_or(DEFAULT_DEADZONE);

    let settings = ProjectSettings::singleton();
    if settings.has_setting(format!("{PREFIX}{action}").as_str()) {
        return Err(BridgeError::AlreadyExists(format!("input action '{action}' already exists")));
    }
    write_action(&action, deadzone, &Array::new())?;
    Ok(json!({ "action": action, "deadzone": deadzone }))
}

fn remove_action(args: &Value) -> Result<Value, BridgeError> {
    let action = require_str(args, "action")?;
    validate_action(&action)?;
    read_action(&action)?;

    let mut settings = ProjectSettings::singleton();
    settings.set_setting(format!("{PREFIX}{action}").as_str(), &Variant::nil());
    save(&mut settings)?;
    Ok(json!({ "action": action, "removed": true }))
}

fn add_event(args: &Value) -> Result<Value, BridgeError> {
    let action = require_str(args, "action")?;
    validate_action(&action)?;
    let event_json = args
        .get("event")
        .ok_or_else(|| BridgeError::InvalidArgs("'event' is required for add_event".into()))?;

    let (deadzone, mut events) = read_action(&action)?;
    let event = decode_event(event_json)?;
    events.push(&event);
    write_action(&action, deadzone, &events)?;
    Ok(json!({ "action": action, "event": encode_event(&event), "index": events.len() - 1 }))
}

fn remove_event(args: &Value) -> Result<Value, BridgeError> {
    let action = require_str(args, "action")?;
    validate_action(&action)?;
    let index = optional_u64(args, "event_index")
        .ok_or_else(|| BridgeError::InvalidArgs("'event_index' is required for remove_event (see the list op)".into()))?;

    let (deadzone, mut events) = read_action(&action)?;
    if index >= events.len() as u64 {
        return Err(BridgeError::InvalidArgs(format!(
            "event_index {index} is out of range; action '{action}' has {} events",
            events.len()
        )));
    }
    let removed = events.at(index as usize);
    events.remove(index as usize);
    write_action(&action, deadzone, &events)?;
    Ok(json!({ "action": action, "removed": encode_event(&removed) }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn ctx() -> FrameContext {
        FrameContext { frame_index: 1, last_delta_ms: 16.0 }
    }

    fn assert_invalid_args(outcome: HandlerOutcome) {
        match outcome {
            HandlerOutcome::Done(Err(err)) => assert_eq!(err.code(), "invalid_args"),
            _ => panic!("expected an invalid_args error before any engine call"),
        }
    }

    #[test]
    fn input_map_requires_op_and_arguments() {
        assert_invalid_args(input_map(&json!({}), &ctx()));
        assert_invalid_args(input_map(&json!({ "op": "rename" }), &ctx()));
        assert_invalid_args(input_map(&json!({ "op": "add_action" }), &ctx()));
        assert_invalid_args(input_map(&json!({ "op": "add_action", "action": "ui/bad" }), &ctx()));
        assert_invalid_args(input_map(&json!({ "op": "add_event", "action": "jump" }), &ctx()));
    }

    #[test]
    fn decode_event_rejects_bad_shapes_before_engine_work() {
        assert_eq!(decode_event(&json!({})).unwrap_err().code(), "invalid_args");
        assert_eq!(decode_event(&json!({ "type": "pedal" })).unwrap_err().code(), "invalid_args");
        assert_eq!(decode_event(&json!({ "type": "joy_button" })).unwrap_err().code(), "invalid_args");
        assert_eq!(decode_event(&json!({ "type": "joy_motion" })).unwrap_err().code(), "invalid_args");
        assert_eq!(decode_event(&json!({ "type": "mouse_button" })).unwrap_err().code(), "invalid_args");
    }

    // Key::try_from_ord accepts arbitrary ordinals (keycodes compose with
    // modifier masks), so only name-based lookups can fail here.
    #[test]
    fn decode_key_reports_unknown_names() {
        assert_eq!(decode_key(&json!({})).unwrap_err().code(), "invalid_args");
        assert_eq!(decode_key(&json!({ "key": "hyperdrive" })).unwrap_err().code(), "invalid_args");
    }
}
