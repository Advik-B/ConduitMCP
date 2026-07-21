//! Asset ingestion handlers (whitepaper section 8 "Assets and import"):
//! writing agent-supplied bytes into the project and reimporting after
//! import-setting changes. Both use `trigger_rescan` rather than the
//! blocking `EditorFileSystem::reimport_files` (`docs/api-gaps.md`).

use godot::classes::{ProjectSettings, ResourceLoader};
use godot::prelude::*;
use serde_json::{json, Value};

use crate::base64;
use crate::dispatcher::{FrameContext, HandlerOutcome};
use crate::handlers::args::require_str;
use crate::handlers::editor::resource::resource_uid_text;
use crate::handlers::editor::support::{trigger_rescan, validate_project_path};
use crate::protocol::BridgeError;

pub fn add(args: &Value, ctx: &FrameContext) -> HandlerOutcome {
    let prepared: Result<(String, Vec<u8>), BridgeError> = (|| {
        let path = require_str(args, "path")?;
        validate_project_path(&path)?;
        let data_base64 = require_str(args, "data_base64")?;
        let bytes = base64::decode(&data_base64)?;
        Ok((path, bytes))
    })();
    let (path, bytes) = match prepared {
        Ok(v) => v,
        Err(e) => return HandlerOutcome::Done(Err(e)),
    };

    let write_result: Result<(), BridgeError> = {
        let global_path = ProjectSettings::singleton().globalize_path(path.as_str()).to_string();
        std::fs::write(&global_path, &bytes)
            .map_err(|e| BridgeError::ResourceError(format!("failed to write '{path}': {e}")))
    };
    if let Err(e) = write_result {
        return HandlerOutcome::Done(Err(e));
    }

    let bytes_written = bytes.len();
    trigger_rescan(false, ctx, move || {
        let resource_type = ResourceLoader::singleton().load(path.as_str()).map(|r| r.get_class().to_string());
        let uid = resource_uid_text(&path);
        Ok(json!({ "path": path, "bytes_written": bytes_written, "type": resource_type, "uid": uid }))
    })
}

pub fn reimport(args: &Value, ctx: &FrameContext) -> HandlerOutcome {
    let path = match require_str(args, "path") {
        Ok(v) => v,
        Err(e) => return HandlerOutcome::Done(Err(e)),
    };
    if let Err(e) = validate_project_path(&path) {
        return HandlerOutcome::Done(Err(e));
    }

    trigger_rescan(true, ctx, move || Ok(json!({ "path": path, "reimported": true })))
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
    fn add_requires_path_and_data() {
        assert_invalid_args(add(&json!({}), &ctx()));
        assert_invalid_args(add(&json!({ "path": "res://x.png" }), &ctx()));
    }

    #[test]
    fn add_rejects_a_path_outside_the_project() {
        assert_invalid_args(add(&json!({ "path": "/tmp/evil.png", "data_base64": "" }), &ctx()));
    }

    #[test]
    fn add_rejects_invalid_base64() {
        assert_invalid_args(add(&json!({ "path": "res://x.png", "data_base64": "not base64!" }), &ctx()));
    }

    #[test]
    fn reimport_requires_path() {
        assert_invalid_args(reimport(&json!({}), &ctx()));
    }
}
