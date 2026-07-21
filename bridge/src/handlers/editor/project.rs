//! Project settings handlers (whitepaper section 8 "Project and session").
//! Direct `ProjectSettings` reads/writes, not undo-wrapped, for the same
//! reason as resource properties: `ProjectSettings::save()` persists
//! `project.godot` synchronously, so wrapping the write in
//! `EditorUndoRedoManager` would let `gd_undo` revert the in-memory setting
//! while the file kept the new value.

use godot::builtin::VariantType;
use godot::classes::ProjectSettings;
use godot::global::Error as GdError;
use godot::prelude::*;
use serde_json::{json, Value};

use crate::dispatcher::{FrameContext, HandlerOutcome};
use crate::handlers::args::require_str;
use crate::protocol::BridgeError;
use crate::variant_json::{json_to_variant, json_to_variant_typed, variant_to_json};

pub fn get_setting(args: &Value, _ctx: &FrameContext) -> HandlerOutcome {
    HandlerOutcome::Done((|| {
        let key = require_str(args, "key")?;
        let settings = ProjectSettings::singleton();
        if !settings.has_setting(key.as_str()) {
            return Err(BridgeError::InvalidProperty(format!("no project setting '{key}'")));
        }
        let value = settings.get_setting(key.as_str());
        Ok(json!({ "key": key, "value": variant_to_json(&value) }))
    })())
}

pub fn set_setting(args: &Value, _ctx: &FrameContext) -> HandlerOutcome {
    HandlerOutcome::Done((|| {
        let key = require_str(args, "key")?;
        let value = args.get("value").ok_or_else(|| BridgeError::InvalidArgs("'value' is required".into()))?;

        let mut settings = ProjectSettings::singleton();
        let previous = settings.get_setting(key.as_str());
        let expected = previous.get_type();
        let variant = if expected == VariantType::NIL {
            json_to_variant(value)?
        } else {
            json_to_variant_typed(value, expected)?
        };
        settings.set_setting(key.as_str(), &variant);

        let save_err = settings.save();
        if save_err != GdError::OK {
            return Err(BridgeError::ResourceError(format!("failed to save project settings: {save_err:?}")));
        }

        Ok(json!({ "key": key, "previous": variant_to_json(&previous) }))
    })())
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
    fn get_setting_requires_key() {
        assert_invalid_args(get_setting(&json!({}), &ctx()));
    }

    #[test]
    fn set_setting_requires_key_and_value() {
        assert_invalid_args(set_setting(&json!({}), &ctx()));
        assert_invalid_args(set_setting(&json!({ "key": "application/config/name" }), &ctx()));
    }
}
