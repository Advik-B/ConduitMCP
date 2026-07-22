//! Animation control behind one op discriminator (section 8 "Animation"):
//! AnimationPlayer transport, property tweens, runtime animation authoring,
//! AnimationTree state machines, and Skeleton3D bone poses.
//!
//! AnimationTree's playback object (`parameters/playback`) is a non-node
//! Object reached through dynamic get and call; IK controllers are plain
//! nodes and stay covered by `gd_node_call` (docs/api-gaps.md).

use godot::builtin::NodePath;
use godot::classes::animation::{LoopMode, TrackType};
use godot::classes::tween::{EaseType, TransitionType};
use godot::classes::{Animation, AnimationLibrary, AnimationPlayer, Skeleton3D};
use godot::prelude::*;
use serde_json::{json, Value};

use crate::dispatcher::{FrameContext, HandlerOutcome};
use crate::handlers::runtime::support::{
    optional_bool, optional_f64, optional_str, property_exists, require_f64, require_str,
    resolve_node,
};
use crate::protocol::BridgeError;
use crate::variant_json::{
    json_to_variant, json_to_variant_typed, to_quaternion, to_vector3, variant_to_json,
};

pub fn animation(args: &Value, _ctx: &FrameContext) -> HandlerOutcome {
    HandlerOutcome::Done((|| {
        let op = require_str(args, "op")?;
        match op.as_str() {
            "play" => play(args),
            "pause" => pause(args),
            "stop" => stop(args),
            "seek" => seek(args),
            "queue" => queue(args),
            "set_speed" => set_speed(args),
            "state" => Ok(player_state(&animation_player(args)?)),
            "list" => list(args),
            "tween" => tween(args),
            "create" => create(args),
            "tree" => tree(args),
            "bone_get" => bone_get(args),
            "bone_set" => bone_set(args),
            other => Err(BridgeError::InvalidArgs(format!(
                "unknown op '{other}'; expected play, pause, stop, seek, queue, set_speed, state, list, tween, create, tree, bone_get, or bone_set"
            ))),
        }
    })())
}

fn animation_player(args: &Value) -> Result<Gd<AnimationPlayer>, BridgeError> {
    let node_path = require_str(args, "node_path")?;
    let node = resolve_node(&node_path)?;
    let class = node.get_class().to_string();
    node.try_cast::<AnimationPlayer>().map_err(|_| {
        BridgeError::InvalidArgs(format!("node at {node_path} is {class}, not an AnimationPlayer"))
    })
}

fn player_state(player: &Gd<AnimationPlayer>) -> Value {
    let current = player.get_current_animation().to_string();
    if current.is_empty() {
        // The position and length getters push engine errors with no current
        // animation, so report them as null instead of calling them.
        return json!({
            "playing": false,
            "current_animation": Value::Null,
            "position": Value::Null,
            "length": Value::Null,
            "speed_scale": player.get_speed_scale(),
        });
    }
    json!({
        "playing": player.is_playing(),
        "current_animation": current,
        "position": player.get_current_animation_position(),
        "length": player.get_current_animation_length(),
        "speed_scale": player.get_speed_scale(),
    })
}

fn play(args: &Value) -> Result<Value, BridgeError> {
    let mut player = animation_player(args)?;
    let name = optional_str(args, "name");
    if let Some(name) = &name
        && !player.has_animation(name.as_str())
    {
        return Err(BridgeError::InvalidArgs(format!("no animation named '{name}'")));
    }
    let custom_speed = optional_f64(args, "custom_speed");
    let from_end = optional_bool(args, "from_end").unwrap_or(false);
    {
        let mut call = player.play_ex();
        if let Some(name) = &name {
            call = call.name(name.as_str());
        }
        if let Some(speed) = custom_speed {
            call = call.custom_speed(speed as f32);
        }
        if from_end {
            call = call.from_end(true);
        }
        call.done();
    }
    Ok(player_state(&player))
}

fn pause(args: &Value) -> Result<Value, BridgeError> {
    let mut player = animation_player(args)?;
    player.pause();
    Ok(player_state(&player))
}

fn stop(args: &Value) -> Result<Value, BridgeError> {
    let mut player = animation_player(args)?;
    let keep_state = optional_bool(args, "keep_state").unwrap_or(false);
    player.stop_ex().keep_state(keep_state).done();
    Ok(player_state(&player))
}

fn seek(args: &Value) -> Result<Value, BridgeError> {
    let mut player = animation_player(args)?;
    let seconds = require_f64(args, "seconds")?;
    let update = optional_bool(args, "update").unwrap_or(true);
    player.seek_ex(seconds).update(update).done();
    Ok(player_state(&player))
}

fn queue(args: &Value) -> Result<Value, BridgeError> {
    let mut player = animation_player(args)?;
    let name = require_str(args, "name")?;
    if !player.has_animation(name.as_str()) {
        return Err(BridgeError::InvalidArgs(format!("no animation named '{name}'")));
    }
    player.queue(name.as_str());
    Ok(json!({ "queued": name }))
}

fn set_speed(args: &Value) -> Result<Value, BridgeError> {
    let mut player = animation_player(args)?;
    let speed = require_f64(args, "speed")?;
    player.set_speed_scale(speed as f32);
    Ok(player_state(&player))
}

fn list(args: &Value) -> Result<Value, BridgeError> {
    let player = animation_player(args)?;
    let names: Vec<String> =
        player.get_animation_list().to_vec().into_iter().map(|s| s.to_string()).collect();
    Ok(json!({ "count": names.len(), "animations": names }))
}

fn tween(args: &Value) -> Result<Value, BridgeError> {
    let node_path = require_str(args, "node_path")?;
    let property = require_str(args, "property")?;
    let duration = require_f64(args, "duration")?;
    let to = args.get("to").ok_or_else(|| BridgeError::InvalidArgs("'to' is required".into()))?;

    let mut node = resolve_node(&node_path)?;
    let previous = node.get(property.as_str());
    if previous.is_nil() && !property_exists(&node, &property) {
        return Err(BridgeError::InvalidProperty(format!(
            "node {node_path} has no property '{property}'"
        )));
    }
    let target = json_to_variant_typed(to, previous.get_type())?;

    let mut tween = node.create_tween();
    let object = node.clone().upcast::<Object>();
    let mut tweener =
        tween.tween_property(&object, &NodePath::from(property.as_str()), &target, duration);
    if let Some(trans) = optional_str(args, "trans") {
        let trans = transition_from_name(&trans).ok_or_else(|| {
            BridgeError::InvalidArgs(format!("unknown transition '{trans}'"))
        })?;
        tweener.set_trans(trans);
    }
    if let Some(ease) = optional_str(args, "ease") {
        let ease = ease_from_name(&ease)
            .ok_or_else(|| BridgeError::InvalidArgs(format!("unknown ease '{ease}'")))?;
        tweener.set_ease(ease);
    }
    Ok(json!({ "tweening": true, "node_path": node_path, "property": property, "duration": duration }))
}

fn create(args: &Value) -> Result<Value, BridgeError> {
    let mut player = animation_player(args)?;
    let name = require_str(args, "name")?;
    let length = require_f64(args, "length")?;
    if player.has_animation(name.as_str()) {
        return Err(BridgeError::AlreadyExists(format!("animation '{name}' already exists")));
    }
    let tracks = args
        .get("tracks")
        .and_then(Value::as_array)
        .ok_or_else(|| BridgeError::InvalidArgs("'tracks' must be an array".into()))?;

    let mut animation = Animation::new_gd();
    animation.set_length(length as f32);
    if optional_bool(args, "loop").unwrap_or(false) {
        animation.set_loop_mode(LoopMode::LINEAR);
    }
    for track in tracks {
        let path = track
            .get("path")
            .and_then(Value::as_str)
            .ok_or_else(|| BridgeError::InvalidArgs("each track needs a 'path'".into()))?;
        let keys = track
            .get("keys")
            .and_then(Value::as_array)
            .ok_or_else(|| BridgeError::InvalidArgs("each track needs a 'keys' array".into()))?;
        let index = animation.add_track(TrackType::VALUE);
        animation.track_set_path(index, &NodePath::from(path));
        for key in keys {
            let time = key
                .get("time")
                .and_then(Value::as_f64)
                .ok_or_else(|| BridgeError::InvalidArgs("each key needs a numeric 'time'".into()))?;
            let value = key
                .get("value")
                .ok_or_else(|| BridgeError::InvalidArgs("each key needs a 'value'".into()))?;
            animation.track_insert_key(index, time, &json_to_variant(value)?);
        }
    }

    let mut library = match player.get_animation_library("") {
        Some(library) => library,
        None => {
            let library = AnimationLibrary::new_gd();
            let error = player.add_animation_library("", &library);
            if error != godot::global::Error::OK {
                return Err(BridgeError::CallFailed(format!(
                    "add_animation_library failed: {error:?}"
                )));
            }
            library
        }
    };
    let error = library.add_animation(name.as_str(), &animation);
    if error != godot::global::Error::OK {
        return Err(BridgeError::CallFailed(format!("add_animation failed: {error:?}")));
    }
    Ok(json!({ "created": name, "tracks": tracks.len(), "length": length }))
}

fn tree(args: &Value) -> Result<Value, BridgeError> {
    let node_path = require_str(args, "node_path")?;
    let action = require_str(args, "action")?;
    let node = resolve_node(&node_path)?;

    let playback_variant = node.get("parameters/playback");
    if playback_variant.is_nil() {
        return Err(BridgeError::InvalidArgs(format!(
            "node at {node_path} has no 'parameters/playback'; expected an AnimationTree whose root is a state machine"
        )));
    }
    let mut playback = playback_variant.try_to::<Gd<Object>>().map_err(|_| {
        BridgeError::InvalidArgs(format!("'parameters/playback' on {node_path} is not an object"))
    })?;

    match action.as_str() {
        "travel" | "start" => {
            let to = require_str(args, "to")?;
            playback.call(action.as_str(), &[to.to_variant()]);
        }
        "stop" => {
            playback.call("stop", &[]);
        }
        "state" => {}
        other => {
            return Err(BridgeError::InvalidArgs(format!(
                "unknown action '{other}'; expected travel, start, stop, or state"
            )));
        }
    }
    Ok(json!({
        "action": action,
        "current_node": playback.call("get_current_node", &[]).to_string(),
        "playing": playback.call("is_playing", &[]).try_to::<bool>().unwrap_or(false),
        "active": node.get("active").try_to::<bool>().unwrap_or(false),
    }))
}

fn skeleton(args: &Value) -> Result<(Gd<Skeleton3D>, i32), BridgeError> {
    let node_path = require_str(args, "node_path")?;
    let node = resolve_node(&node_path)?;
    let class = node.get_class().to_string();
    let skeleton = node.try_cast::<Skeleton3D>().map_err(|_| {
        BridgeError::InvalidArgs(format!("node at {node_path} is {class}, not a Skeleton3D"))
    })?;
    let bone = match args.get("bone") {
        Some(Value::Number(n)) => {
            let index = n.as_i64().unwrap_or(-1) as i32;
            if index < 0 || index >= skeleton.get_bone_count() {
                return Err(BridgeError::InvalidArgs(format!(
                    "bone index {index} out of range; skeleton has {} bones",
                    skeleton.get_bone_count()
                )));
            }
            index
        }
        Some(Value::String(name)) => {
            let index = skeleton.find_bone(name.as_str());
            if index < 0 {
                return Err(BridgeError::InvalidArgs(format!("no bone named '{name}'")));
            }
            index
        }
        _ => return Err(BridgeError::InvalidArgs("'bone' must be a name or index".into())),
    };
    Ok((skeleton, bone))
}

fn bone_state(skeleton: &Gd<Skeleton3D>, bone: i32) -> Value {
    json!({
        "bone": bone,
        "name": skeleton.get_bone_name(bone).to_string(),
        "position": variant_to_json(&skeleton.get_bone_pose_position(bone).to_variant()),
        "rotation": variant_to_json(&skeleton.get_bone_pose_rotation(bone).to_variant()),
        "scale": variant_to_json(&skeleton.get_bone_pose_scale(bone).to_variant()),
    })
}

fn bone_get(args: &Value) -> Result<Value, BridgeError> {
    let (skeleton, bone) = skeleton(args)?;
    Ok(bone_state(&skeleton, bone))
}

fn bone_set(args: &Value) -> Result<Value, BridgeError> {
    let (mut skeleton, bone) = skeleton(args)?;
    if let Some(position) = args.get("position") {
        skeleton.set_bone_pose_position(bone, to_vector3(position)?);
    }
    if let Some(rotation) = args.get("rotation") {
        skeleton.set_bone_pose_rotation(bone, to_quaternion(rotation)?);
    }
    if let Some(scale) = args.get("scale") {
        skeleton.set_bone_pose_scale(bone, to_vector3(scale)?);
    }
    Ok(bone_state(&skeleton, bone))
}

fn transition_from_name(name: &str) -> Option<TransitionType> {
    Some(match name.trim().to_ascii_lowercase().as_str() {
        "linear" => TransitionType::LINEAR,
        "sine" => TransitionType::SINE,
        "quad" => TransitionType::QUAD,
        "cubic" => TransitionType::CUBIC,
        "quart" => TransitionType::QUART,
        "quint" => TransitionType::QUINT,
        "expo" => TransitionType::EXPO,
        "elastic" => TransitionType::ELASTIC,
        "circ" => TransitionType::CIRC,
        "bounce" => TransitionType::BOUNCE,
        "back" => TransitionType::BACK,
        "spring" => TransitionType::SPRING,
        _ => return None,
    })
}

fn ease_from_name(name: &str) -> Option<EaseType> {
    Some(match name.trim().to_ascii_lowercase().as_str() {
        "in" => EaseType::IN,
        "out" => EaseType::OUT,
        "in_out" => EaseType::IN_OUT,
        "out_in" => EaseType::OUT_IN,
        _ => return None,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn transition_names_map_to_tween_enums() {
        assert_eq!(transition_from_name("sine"), Some(TransitionType::SINE));
        assert_eq!(transition_from_name("BOUNCE"), Some(TransitionType::BOUNCE));
        assert_eq!(transition_from_name("wobble"), None);
    }

    #[test]
    fn ease_names_map_to_tween_enums() {
        assert_eq!(ease_from_name("in"), Some(EaseType::IN));
        assert_eq!(ease_from_name("out_in"), Some(EaseType::OUT_IN));
        assert_eq!(ease_from_name("sideways"), None);
    }
}
