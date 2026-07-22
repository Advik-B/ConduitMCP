//! Audio control through the AudioServer singleton (section 8 "Audio"):
//! bus listing and adjustment, bus lifecycle, bus effects, and stream player
//! transport. Spatial audio configuration is plain node properties on the
//! positional players, covered by the generic property tools.
//!
//! Headless the dummy audio driver keeps all bus state readable and writable;
//! only audible output and playback-position advance are absent
//! (docs/api-gaps.md).

use godot::classes::{AudioEffect, AudioServer, ClassDb};
use godot::prelude::*;
use serde_json::{json, Value};

use crate::dispatcher::{FrameContext, HandlerOutcome};
use crate::handlers::runtime::support::{
    optional_bool, optional_f64, optional_str, optional_u64, require_str, resolve_node,
};
use crate::protocol::BridgeError;
use crate::variant_json::variant_to_json;

pub fn audio(args: &Value, _ctx: &FrameContext) -> HandlerOutcome {
    HandlerOutcome::Done((|| {
        let op = require_str(args, "op")?;
        match op.as_str() {
            "bus_list" => Ok(bus_list()),
            "bus_set" => bus_set(args),
            "bus_add" => bus_add(args),
            "bus_remove" => bus_remove(args),
            "bus_effect" => bus_effect(args),
            "player" => player(args),
            other => Err(BridgeError::InvalidArgs(format!(
                "unknown op '{other}'; expected bus_list, bus_set, bus_add, bus_remove, bus_effect, or player"
            ))),
        }
    })())
}

fn bus_entry(index: i32) -> Value {
    let server = AudioServer::singleton();
    let effects: Vec<Value> = (0..server.get_bus_effect_count(index))
        .map(|effect_index| {
            let class = server
                .get_bus_effect(index, effect_index)
                .map(|effect| effect.get_class().to_string())
                .unwrap_or_default();
            json!({
                "index": effect_index,
                "class": class,
                "enabled": server.is_bus_effect_enabled(index, effect_index),
            })
        })
        .collect();
    json!({
        "index": index,
        "name": server.get_bus_name(index).to_string(),
        "volume_db": server.get_bus_volume_db(index),
        "mute": server.is_bus_mute(index),
        "solo": server.is_bus_solo(index),
        "bypass_effects": server.is_bus_bypassing_effects(index),
        "send": server.get_bus_send(index).to_string(),
        "effects": effects,
    })
}

fn bus_list() -> Value {
    let count = AudioServer::singleton().get_bus_count();
    let buses: Vec<Value> = (0..count).map(bus_entry).collect();
    json!({ "count": count, "buses": buses })
}

/// Resolve the `bus` argument, a name or an index, to a bus index. Unknown
/// names report the buses that do exist.
fn resolve_bus(args: &Value) -> Result<i32, BridgeError> {
    let server = AudioServer::singleton();
    match args.get("bus") {
        Some(Value::Number(n)) => {
            let index = n.as_i64().unwrap_or(-1) as i32;
            if index < 0 || index >= server.get_bus_count() {
                return Err(BridgeError::InvalidArgs(format!(
                    "bus index {index} out of range; there are {} buses",
                    server.get_bus_count()
                )));
            }
            Ok(index)
        }
        Some(Value::String(name)) => {
            let index = server.get_bus_index(name.as_str());
            if index < 0 {
                let names: Vec<String> = (0..server.get_bus_count())
                    .map(|i| server.get_bus_name(i).to_string())
                    .collect();
                return Err(BridgeError::InvalidArgs(format!(
                    "no bus named '{name}'; existing buses: {}",
                    names.join(", ")
                )));
            }
            Ok(index)
        }
        _ => Err(BridgeError::InvalidArgs("'bus' must be a name or index".into())),
    }
}

fn bus_set(args: &Value) -> Result<Value, BridgeError> {
    let index = resolve_bus(args)?;
    let mut server = AudioServer::singleton();
    if let Some(volume_db) = optional_f64(args, "volume_db") {
        server.set_bus_volume_db(index, volume_db as f32);
    }
    if let Some(mute) = optional_bool(args, "mute") {
        server.set_bus_mute(index, mute);
    }
    if let Some(solo) = optional_bool(args, "solo") {
        server.set_bus_solo(index, solo);
    }
    if let Some(bypass) = optional_bool(args, "bypass") {
        server.set_bus_bypass_effects(index, bypass);
    }
    if let Some(send) = optional_str(args, "send") {
        if server.get_bus_index(send.as_str()) < 0 {
            return Err(BridgeError::InvalidArgs(format!("send target bus '{send}' does not exist")));
        }
        server.set_bus_send(index, send.as_str());
    }
    Ok(bus_entry(index))
}

fn bus_add(args: &Value) -> Result<Value, BridgeError> {
    let name = require_str(args, "name")?;
    let mut server = AudioServer::singleton();
    if server.get_bus_index(name.as_str()) >= 0 {
        return Err(BridgeError::AlreadyExists(format!("bus '{name}' already exists")));
    }
    server.add_bus();
    let index = server.get_bus_count() - 1;
    server.set_bus_name(index, name.as_str());
    Ok(bus_entry(index))
}

fn bus_remove(args: &Value) -> Result<Value, BridgeError> {
    let index = resolve_bus(args)?;
    if index == 0 {
        return Err(BridgeError::InvalidArgs("the Master bus cannot be removed".into()));
    }
    let name = AudioServer::singleton().get_bus_name(index).to_string();
    AudioServer::singleton().remove_bus(index);
    Ok(json!({ "removed": name, "count": AudioServer::singleton().get_bus_count() }))
}

fn bus_effect(args: &Value) -> Result<Value, BridgeError> {
    let action = require_str(args, "action")?;
    let index = resolve_bus(args)?;
    let mut server = AudioServer::singleton();
    match action.as_str() {
        "add" => {
            let class = require_str(args, "effect_class")?;
            let db = ClassDb::singleton();
            if !db.class_exists(class.as_str()) || !db.is_parent_class(class.as_str(), "AudioEffect")
            {
                return Err(BridgeError::ResourceError(format!(
                    "'{class}' is not an AudioEffect class"
                )));
            }
            let effect = db.instantiate(class.as_str()).try_to::<Gd<AudioEffect>>().map_err(
                |_| BridgeError::ResourceError(format!("failed to instantiate '{class}'")),
            )?;
            server.add_bus_effect(index, &effect);
            Ok(bus_entry(index))
        }
        "remove" => {
            let effect_index = effect_index(args, index)?;
            server.remove_bus_effect(index, effect_index);
            Ok(bus_entry(index))
        }
        "set_enabled" => {
            let effect_index = effect_index(args, index)?;
            let enabled = optional_bool(args, "enabled").unwrap_or(true);
            server.set_bus_effect_enabled(index, effect_index, enabled);
            Ok(bus_entry(index))
        }
        other => Err(BridgeError::InvalidArgs(format!(
            "unknown action '{other}'; expected add, remove, or set_enabled"
        ))),
    }
}

fn effect_index(args: &Value, bus: i32) -> Result<i32, BridgeError> {
    let index = optional_u64(args, "effect_index")
        .ok_or_else(|| BridgeError::InvalidArgs("'effect_index' is required".into()))?
        as i32;
    let count = AudioServer::singleton().get_bus_effect_count(bus);
    if index >= count {
        return Err(BridgeError::InvalidArgs(format!(
            "effect index {index} out of range; bus has {count} effects"
        )));
    }
    Ok(index)
}

// One dynamic-call arm serves AudioStreamPlayer, AudioStreamPlayer2D, and
// AudioStreamPlayer3D; anything with the player method set qualifies.
fn player(args: &Value) -> Result<Value, BridgeError> {
    let node_path = require_str(args, "node_path")?;
    let action = require_str(args, "action")?;
    let mut node = resolve_node(&node_path)?;
    if !node.has_method("play") || !node.has_method("get_playback_position") {
        return Err(BridgeError::InvalidArgs(format!(
            "node at {node_path} ({}) is not an audio stream player",
            node.get_class()
        )));
    }
    match action.as_str() {
        "play" => {
            let position = optional_f64(args, "position").unwrap_or(0.0);
            node.call("play", &[position.to_variant()]);
        }
        "stop" => {
            node.call("stop", &[]);
        }
        "pause" => {
            node.call("set_stream_paused", &[true.to_variant()]);
        }
        "resume" => {
            node.call("set_stream_paused", &[false.to_variant()]);
        }
        "state" => {}
        other => {
            return Err(BridgeError::InvalidArgs(format!(
                "unknown action '{other}'; expected play, stop, pause, resume, or state"
            )));
        }
    }
    Ok(json!({
        "node_path": node_path,
        "playing": variant_to_json(&node.call("is_playing", &[])),
        "position": variant_to_json(&node.call("get_playback_position", &[])),
        "paused": variant_to_json(&node.get("stream_paused")),
    }))
}
