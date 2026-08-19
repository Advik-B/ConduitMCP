//! Asset ingestion and import settings (whitepaper section 8 "Assets and
//! import"): writing agent-supplied bytes into the project, reading and writing
//! an asset's `.import` options, and reimporting afterwards. All three use
//! `trigger_rescan` rather than the blocking `EditorFileSystem::reimport_files`
//! (`docs/api-gaps.md`).

use godot::builtin::VariantType;
use godot::classes::{ConfigFile, FileAccess, ProjectSettings, ResourceLoader};
use godot::global::Error as GdError;
use godot::prelude::*;
use serde_json::{json, Map, Value};

use crate::base64;
use crate::dispatcher::{FrameContext, HandlerOutcome};
use crate::handlers::args::{optional_bool, optional_str, require_str};
use crate::handlers::editor::resource::resource_uid_text;
use crate::handlers::editor::support::{trigger_rescan, validate_project_path};
use crate::protocol::BridgeError;
use crate::variant_json::{json_to_variant, json_to_variant_typed, variant_to_json};

const PARAMS_SECTION: &str = "params";
const REMAP_SECTION: &str = "remap";
const DEPS_SECTION: &str = "deps";

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

/// Read and write an asset's import options (whitepaper section 8, "read and
/// set import settings").
///
/// The options live in the `res://<asset>.import` sidecar, which is a
/// `ConfigFile`: `[remap]` names the importer and the artifact it produced,
/// `[deps]` the source file, and `[params]` holds every option the importer
/// wrote. Going through `ConfigFile` is Godot's own serialisation of its own
/// file rather than hand parsing, the same argument `import_export.rs` makes
/// for `export_presets.cfg`.
///
/// This reads and writes the options an asset *has*. Enumerating the options an
/// importer *supports* means calling `ResourceImporter::get_import_options`,
/// and a `ResourceImporter` is neither a node, a singleton, nor a resource, so
/// nothing can name one (`docs/api-gaps.md`). In practice the importer writes
/// its full default set into `[params]` on first import, so `op: get` answers
/// the same question.
///
/// Not undo-wrapped, and the response says so. An `.import` write is a file
/// write, not edited-scene state; putting it on the scene's history would let
/// `gd_undo` claim to revert something the history never owned. This is the
/// argument `editor/resource.rs` already makes for resources.
pub fn import_settings(args: &Value, ctx: &FrameContext) -> HandlerOutcome {
    let prepared = match parse_import_args(args) {
        Ok(v) => v,
        Err(e) => return HandlerOutcome::Done(Err(e)),
    };

    match prepared {
        ImportOp::Get { path } => HandlerOutcome::Done(read_import_settings(&path)),
        ImportOp::Set { path, params, reimport } => match write_import_settings(&path, &params) {
            Err(e) => HandlerOutcome::Done(Err(e)),
            Ok(written) => {
                if !reimport {
                    return HandlerOutcome::Done(Ok(written.into_json(false)));
                }
                trigger_rescan(true, ctx, move || Ok(written.into_json(true)))
            }
        },
    }
}

enum ImportOp {
    Get { path: String },
    Set { path: String, params: Map<String, Value>, reimport: bool },
}

fn parse_import_args(args: &Value) -> Result<ImportOp, BridgeError> {
    let path = require_str(args, "path")?;
    // The sidecar path is this one plus a `.import` suffix. A suffix on an
    // already-validated path cannot escape the project, so validating here
    // covers both.
    validate_project_path(&path)?;

    // Listing is not a separate op the way it is on gd_resource_get_property:
    // `get` returns the whole `[params]` table, because an import option is
    // only meaningful next to the others (a compression mode next to its
    // quality setting), and the table is small enough to return whole.
    let op = optional_str(args, "op").unwrap_or_else(|| "get".to_string());
    match op.as_str() {
        "get" => Ok(ImportOp::Get { path }),
        "set" => {
            let params = match args.get("params") {
                Some(Value::Object(map)) if !map.is_empty() => map.clone(),
                Some(Value::Object(_)) => {
                    return Err(BridgeError::InvalidArgs("'params' must name at least one import option".into()))
                }
                _ => {
                    return Err(BridgeError::InvalidArgs(
                        "'params' is required for op set and must be an object mapping import option names to values"
                            .into(),
                    ))
                }
            };
            let reimport = optional_bool(args, "reimport").unwrap_or(true);
            Ok(ImportOp::Set { path, params, reimport })
        }
        other => Err(BridgeError::InvalidArgs(format!("unknown op '{other}'; expected get or set"))),
    }
}

fn import_path_of(path: &str) -> String {
    format!("{path}.import")
}

fn load_import_config(path: &str) -> Result<(Gd<ConfigFile>, String), BridgeError> {
    let import_path = import_path_of(path);
    let mut config = ConfigFile::new_gd();
    let err = config.load(import_path.as_str());
    if err != GdError::OK {
        if !FileAccess::file_exists(path) {
            return Err(BridgeError::ResourceError(format!("no file at '{path}'")));
        }
        return Err(BridgeError::ResourceError(format!(
            "could not read import settings at '{import_path}' ({err:?}); only assets the import pipeline brings in (textures, audio, fonts, models) have a sidecar, unlike scenes, scripts, and .tres resources"
        )));
    }
    Ok((config, import_path))
}

fn section_value(config: &Gd<ConfigFile>, section: &str, key: &str) -> Value {
    if config.has_section_key(section, key) {
        variant_to_json(&config.get_value(section, key))
    } else {
        Value::Null
    }
}

fn section_keys(config: &Gd<ConfigFile>, section: &str) -> Vec<String> {
    if !config.has_section(section) {
        return Vec::new();
    }
    config.get_section_keys(section).as_slice().iter().map(|key| key.to_string()).collect()
}

/// Every artifact `[remap]` names. A texture imported to a VRAM-compressed
/// format has no single `path`: it gets one `path.<format>` per platform
/// variant, so a caller that only ever read `path` would see nothing for
/// exactly the assets whose import options matter most.
fn imported_paths(config: &Gd<ConfigFile>) -> Vec<Value> {
    section_keys(config, REMAP_SECTION)
        .iter()
        .filter(|key| key.as_str() == "path" || key.starts_with("path."))
        .map(|key| section_value(config, REMAP_SECTION, key))
        .collect()
}

fn read_import_settings(path: &str) -> Result<Value, BridgeError> {
    let (config, import_path) = load_import_config(path)?;

    let mut params = Map::new();
    for key in section_keys(&config, PARAMS_SECTION) {
        let value = section_value(&config, PARAMS_SECTION, &key);
        params.insert(key, value);
    }

    let artifacts = imported_paths(&config);
    Ok(json!({
        "path": path,
        "import_path": import_path,
        "importer": section_value(&config, REMAP_SECTION, "importer"),
        "type": section_value(&config, REMAP_SECTION, "type"),
        "uid": section_value(&config, REMAP_SECTION, "uid"),
        "source_file": section_value(&config, DEPS_SECTION, "source_file"),
        "imported_path": artifacts.first().cloned().unwrap_or(Value::Null),
        "imported_paths": artifacts,
        "params": params,
    }))
}

struct WrittenSettings {
    path: String,
    import_path: String,
    params: Map<String, Value>,
    previous: Map<String, Value>,
}

impl WrittenSettings {
    fn into_json(self, reimported: bool) -> Value {
        json!({
            "path": self.path,
            "import_path": self.import_path,
            "params": self.params,
            "previous": self.previous,
            "reimported": reimported,
            "undoable": false,
        })
    }
}

fn write_import_settings(path: &str, requested: &Map<String, Value>) -> Result<WrittenSettings, BridgeError> {
    let (mut config, import_path) = load_import_config(path)?;

    // Every key is resolved and converted before any is applied, so a typo or a
    // type mismatch in the third option cannot leave the first two written.
    let mut pending: Vec<(String, Variant)> = Vec::new();
    let mut previous = Map::new();
    let mut applied = Map::new();
    for (key, value) in requested {
        if !config.has_section_key(PARAMS_SECTION, key.as_str()) {
            // A silent insert is the failure this tool exists to prevent: a
            // misspelled option would write cleanly and change nothing.
            return Err(BridgeError::InvalidProperty(format!(
                "'{import_path}' has no import option '{key}'; call gd_import_settings with op get to see the options this asset has"
            )));
        }
        let existing = config.get_value(PARAMS_SECTION, key.as_str());
        let expected = existing.get_type();
        let variant = if expected == VariantType::NIL {
            json_to_variant(value)?
        } else {
            json_to_variant_typed(value, expected)?
        };
        previous.insert(key.clone(), variant_to_json(&existing));
        applied.insert(key.clone(), variant_to_json(&variant));
        pending.push((key.clone(), variant));
    }

    for (key, variant) in &pending {
        config.set_value(PARAMS_SECTION, key.as_str(), variant);
    }

    let save_err = config.save(import_path.as_str());
    if save_err != GdError::OK {
        return Err(BridgeError::ResourceError(format!(
            "failed to write import settings to '{import_path}': {save_err:?}"
        )));
    }

    Ok(WrittenSettings { path: path.to_string(), import_path, params: applied, previous })
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

    #[test]
    fn import_settings_validates_before_touching_the_engine() {
        assert_invalid_args(import_settings(&json!({}), &ctx()));
        assert_invalid_args(import_settings(&json!({ "path": "/tmp/evil.png" }), &ctx()));
        assert_invalid_args(import_settings(&json!({ "path": "res://../outside.png" }), &ctx()));
        assert_invalid_args(import_settings(&json!({ "path": "res://x.png", "op": "nope" }), &ctx()));
    }

    #[test]
    fn import_settings_set_requires_a_non_empty_params_object() {
        assert_invalid_args(import_settings(&json!({ "path": "res://x.png", "op": "set" }), &ctx()));
        assert_invalid_args(import_settings(&json!({ "path": "res://x.png", "op": "set", "params": {} }), &ctx()));
        assert_invalid_args(import_settings(
            &json!({ "path": "res://x.png", "op": "set", "params": ["compress/mode"] }),
            &ctx(),
        ));
    }

    #[test]
    fn parse_import_args_defaults_to_get_and_to_reimporting() {
        match parse_import_args(&json!({ "path": "res://x.png" })).unwrap() {
            ImportOp::Get { path } => assert_eq!(path, "res://x.png"),
            ImportOp::Set { .. } => panic!("expected the default op to be get"),
        }
        let set = json!({ "path": "res://x.png", "op": "set", "params": { "compress/mode": 1 } });
        match parse_import_args(&set).unwrap() {
            ImportOp::Set { reimport, params, .. } => {
                assert!(reimport, "a set must reimport unless told otherwise");
                assert_eq!(params.len(), 1);
            }
            ImportOp::Get { .. } => panic!("expected op set to parse as a set"),
        }
        let no_reimport =
            json!({ "path": "res://x.png", "op": "set", "params": { "compress/mode": 1 }, "reimport": false });
        match parse_import_args(&no_reimport).unwrap() {
            ImportOp::Set { reimport, .. } => assert!(!reimport),
            ImportOp::Get { .. } => panic!("expected op set to parse as a set"),
        }
    }

    #[test]
    fn import_path_is_the_asset_path_plus_a_suffix() {
        assert_eq!(import_path_of("res://textures/icon.png"), "res://textures/icon.png.import");
    }
}
