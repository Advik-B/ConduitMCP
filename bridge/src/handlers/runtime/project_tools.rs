//! Project-defined tools (whitepaper section 8, phase 9): nodes in the
//! `conduit_tools` group expose their script methods as agent tools.
//!
//! The bridge side is two handlers plus a watcher. `gd_project_tools_list`
//! returns every exposed method with its typed signature; `gd_project_call`
//! invokes one with named arguments reordered against the live signature, so
//! broker staleness can never mis-position a value. The watcher fingerprints
//! the exposed set every few frames and emits a `project_tools_changed` event
//! frame when it drifts, which is what drives the broker's dynamic
//! registration and MCP listChanged notifications.
//!
//! Exposure rules: script methods only (engine methods never surface), names
//! starting with `_` are skipped, and a node may declare an explicit subset in
//! a `conduit_tool_methods` property (an array of method names). A coroutine
//! (awaiting) method returns its function-state object, not the awaited value;
//! projects that need an awaited result should wrap it in `gd_game_eval`.

use std::collections::hash_map::DefaultHasher;
use std::hash::{Hash, Hasher};

use godot::builtin::{VarArray, VariantType};
use godot::classes::Node;
use godot::prelude::*;
use serde_json::{json, Map, Value};

use crate::dispatcher::{FrameContext, HandlerOutcome};
use crate::handlers::classdb::{dict_i64, dict_str, type_label};
use crate::handlers::runtime::support::{optional_str, property_exists, require_str, scene_tree};
use crate::protocol::{BridgeError, EventSender};
use crate::variant_json::{json_to_variant, json_to_variant_typed, variant_to_json};

pub const GROUP_NAME: &str = "conduit_tools";
const DECLARED_SUBSET_PROPERTY: &str = "conduit_tool_methods";
const WATCH_INTERVAL_FRAMES: u32 = 10;

/// One argument of an exposed method. The type ord stays bridge-side for
/// call-time coercion; the broker sees only the readable label.
struct SigArg {
    name: String,
    label: String,
    type_ord: i32,
}

/// The live signature of one exposed method on one group node.
struct MethodSig {
    method: String,
    node_path: String,
    args: Vec<SigArg>,
    defaults: Vec<Variant>,
    return_type: String,
}

impl MethodSig {
    fn required_count(&self) -> usize {
        self.args.len().saturating_sub(self.defaults.len())
    }

    fn to_json(&self) -> Value {
        let required_from = self.required_count();
        json!({
            "method": self.method,
            "node_path": self.node_path,
            "args": self.args.iter().enumerate().map(|(index, arg)| json!({
                "name": arg.name,
                "type": arg.label,
                "required": index < required_from,
            })).collect::<Vec<Value>>(),
            "return_type": self.return_type,
        })
    }

    /// A stable identity string for change detection: path, name, argument
    /// names and types, optionality boundary, and return type.
    fn key(&self) -> String {
        let args: Vec<String> = self.args.iter().map(|a| format!("{}:{}:{}", a.name, a.label, a.type_ord)).collect();
        format!("{}:{}({})+{}->{}", self.node_path, self.method, args.join(","), self.defaults.len(), self.return_type)
    }
}

pub fn tools_list(_args: &Value, _ctx: &FrameContext) -> HandlerOutcome {
    HandlerOutcome::Done((|| {
        let sigs = collect_signatures()?;
        Ok(json!({ "tools": sigs.iter().map(MethodSig::to_json).collect::<Vec<Value>>() }))
    })())
}

pub fn project_call(args: &Value, _ctx: &FrameContext) -> HandlerOutcome {
    HandlerOutcome::Done((|| {
        let method = require_str(args, "method")?;
        let node_path = optional_str(args, "node_path");
        let empty = Map::new();
        let provided = match args.get("args") {
            None | Some(Value::Null) => &empty,
            Some(Value::Object(map)) => map,
            Some(_) => return Err(BridgeError::InvalidArgs("'args' must be an object map of named arguments".into())),
        };

        let sigs = collect_signatures()?;
        let sig = sigs
            .iter()
            .find(|sig| sig.method == method && node_path.as_deref().is_none_or(|p| sig.node_path == p))
            .ok_or_else(|| {
                BridgeError::CallFailed(format!(
                    "no conduit_tools method '{method}'{}; the group set may have changed",
                    node_path.as_deref().map(|p| format!(" on node {p}")).unwrap_or_default()
                ))
            })?;

        let arg_names: Vec<String> = sig.args.iter().map(|a| a.name.clone()).collect();
        let plan = plan_call_args(&arg_names, sig.defaults.len(), provided)?;
        let mut call_args = Vec::with_capacity(plan.len());
        for (index, source) in plan.iter().enumerate() {
            match source {
                ArgSource::Provided => {
                    let value = &provided[&sig.args[index].name];
                    let ord = sig.args[index].type_ord;
                    let variant = if ord == VariantType::NIL.ord {
                        json_to_variant(value)?
                    } else {
                        json_to_variant_typed(value, VariantType { ord })?
                    };
                    call_args.push(variant);
                }
                ArgSource::Default(default_index) => call_args.push(sig.defaults[*default_index].clone()),
            }
        }

        let mut node = crate::handlers::runtime::support::resolve_node(&sig.node_path)?;
        let result = node.call(sig.method.as_str(), &call_args);
        Ok(json!({
            "method": sig.method,
            "node_path": sig.node_path,
            "result": variant_to_json(&result),
        }))
    })())
}

/// Where each positional argument of a call comes from.
#[derive(Debug, PartialEq)]
enum ArgSource {
    /// The named map supplies it.
    Provided,
    /// Omitted trailing optional: use the declared default at this index.
    Default(usize),
}

/// Map a named-argument object onto the declared positional signature.
/// Engine-free so the reorder/defaults/unknown/missing logic is unit-testable.
fn plan_call_args(
    arg_names: &[String],
    defaults_len: usize,
    provided: &Map<String, Value>,
) -> Result<Vec<ArgSource>, BridgeError> {
    for key in provided.keys() {
        if !arg_names.iter().any(|name| name == key) {
            return Err(BridgeError::InvalidArgs(format!(
                "unknown argument '{key}'; the method takes ({})",
                arg_names.join(", ")
            )));
        }
    }
    let required_from = arg_names.len().saturating_sub(defaults_len);
    let mut plan = Vec::with_capacity(arg_names.len());
    for (index, name) in arg_names.iter().enumerate() {
        if provided.contains_key(name) {
            plan.push(ArgSource::Provided);
        } else if index >= required_from {
            plan.push(ArgSource::Default(index - required_from));
        } else {
            return Err(BridgeError::InvalidArgs(format!("missing required argument '{name}'")));
        }
    }
    Ok(plan)
}

/// The method names a node exposes: the declared subset when present,
/// otherwise every script method not starting with `_`. Engine-free.
fn exposed_method_names(script_methods: &[String], declared: Option<&[String]>) -> Vec<String> {
    match declared {
        Some(subset) => subset.iter().filter(|name| script_methods.contains(name)).cloned().collect(),
        None => script_methods.iter().filter(|name| !name.starts_with('_')).cloned().collect(),
    }
}

/// Order-insensitive fingerprint of the exposed signature set.
fn fingerprint(keys: &[String]) -> u64 {
    let mut sorted: Vec<&String> = keys.iter().collect();
    sorted.sort_unstable();
    let mut hasher = DefaultHasher::new();
    sorted.hash(&mut hasher);
    hasher.finish()
}

fn collect_signatures() -> Result<Vec<MethodSig>, BridgeError> {
    let tree = scene_tree()?;
    let mut sigs = Vec::new();
    for node in tree.get_nodes_in_group(GROUP_NAME).iter_shared() {
        let node_path = node.get_path().to_string();
        let Some(script) = node.get_script() else {
            continue;
        };
        let methods: Vec<VarDictionary> = script.get_script_method_list().iter_shared().collect();
        let names: Vec<String> = methods.iter().map(|dict| dict_str(dict, "name")).collect();
        let declared = declared_subset(&node);
        let exposed = exposed_method_names(&names, declared.as_deref());
        for dict in &methods {
            let name = dict_str(dict, "name");
            if exposed.contains(&name) {
                sigs.push(parse_method_sig(dict, &node_path));
            }
        }
    }
    Ok(sigs)
}

/// The node's `conduit_tool_methods` array, if declared. Accepts any array
/// whose elements stringify (typed Array[String], untyped Array, packed).
fn declared_subset(node: &Gd<Node>) -> Option<Vec<String>> {
    if !property_exists(node, DECLARED_SUBSET_PROPERTY) {
        return None;
    }
    let value = node.get(DECLARED_SUBSET_PROPERTY);
    if let Ok(packed) = value.try_to::<PackedStringArray>() {
        return Some(packed.as_slice().iter().map(|s| s.to_string()).collect());
    }
    value
        .try_to::<VarArray>()
        .ok()
        .map(|arr| arr.iter_shared().map(|item| item.to_string()).collect())
}

// The `args` entry may be a typed `Array[Dictionary]` or an untyped array, and
// gdext's conversions are strict about which; accept both, as classdb's
// `args_json` already must (a single wrong guess silently reports every method
// as argument-free).
fn arg_dicts(value: &Variant) -> Vec<VarDictionary> {
    if let Ok(typed) = value.try_to::<Array<VarDictionary>>() {
        return typed.iter_shared().collect();
    }
    value
        .try_to::<VarArray>()
        .map(|arr| arr.iter_shared().filter_map(|item| item.try_to::<VarDictionary>().ok()).collect())
        .unwrap_or_default()
}

fn parse_method_sig(dict: &VarDictionary, node_path: &str) -> MethodSig {
    let args = dict
        .get(&GString::from("args"))
        .map(|value| {
            arg_dicts(&value)
                .iter()
                .map(|arg| SigArg {
                    name: dict_str(arg, "name"),
                    label: type_label(arg),
                    type_ord: dict_i64(arg, "type") as i32,
                })
                .collect()
        })
        .unwrap_or_default();
    let defaults = dict
        .get(&GString::from("default_args"))
        .and_then(|value| value.try_to::<VarArray>().ok())
        .map(|arr| arr.iter_shared().collect())
        .unwrap_or_default();
    let return_type = dict
        .get(&GString::from("return"))
        .and_then(|value| value.try_to::<VarDictionary>().ok())
        .map(|ret| {
            if dict_i64(&ret, "type") == 0 && dict_str(&ret, "class_name").is_empty() {
                "void".to_string()
            } else {
                type_label(&ret)
            }
        })
        .unwrap_or_else(|| "void".to_string());
    MethodSig { method: dict_str(dict, "name"), node_path: node_path.to_string(), args, defaults, return_type }
}

/// Watches the exposed tool set from the game bridge's `_process` and emits a
/// `project_tools_changed` event when it drifts. The first observation is the
/// baseline (the broker pulls the list itself when it connects), so only real
/// joins, leaves, and signature edits emit.
pub struct ProjectToolsWatcher {
    sender: EventSender,
    countdown: u32,
    last_fingerprint: Option<u64>,
}

impl ProjectToolsWatcher {
    pub fn new(sender: EventSender) -> Self {
        ProjectToolsWatcher { sender, countdown: 0, last_fingerprint: None }
    }

    pub fn service(&mut self) {
        if self.countdown > 0 {
            self.countdown -= 1;
            return;
        }
        self.countdown = WATCH_INTERVAL_FRAMES;
        let Ok(sigs) = collect_signatures() else {
            return;
        };
        let keys: Vec<String> = sigs.iter().map(MethodSig::key).collect();
        let current = fingerprint(&keys);
        match self.last_fingerprint {
            None => self.last_fingerprint = Some(current),
            Some(previous) if previous != current => {
                self.last_fingerprint = Some(current);
                let tools: Vec<Value> = sigs.iter().map(MethodSig::to_json).collect();
                self.sender.send("project_tools_changed", json!({ "tools": tools }));
            }
            Some(_) => {}
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn names(list: &[&str]) -> Vec<String> {
        list.iter().map(|s| s.to_string()).collect()
    }

    fn provided(keys: &[&str]) -> Map<String, Value> {
        keys.iter().map(|k| (k.to_string(), json!(1))).collect()
    }

    #[test]
    fn plan_orders_and_fills_trailing_defaults() {
        let args = names(&["name", "count", "speed"]);
        let plan = plan_call_args(&args, 2, &provided(&["name", "speed"])).unwrap();
        assert_eq!(plan, vec![ArgSource::Provided, ArgSource::Default(0), ArgSource::Provided]);
    }

    #[test]
    fn plan_rejects_unknown_and_missing() {
        let args = names(&["name", "count"]);
        let unknown = plan_call_args(&args, 1, &provided(&["nam"])).unwrap_err();
        assert_eq!(unknown.code(), "invalid_args");
        let missing = plan_call_args(&args, 1, &provided(&[])).unwrap_err();
        assert_eq!(missing.code(), "invalid_args");
    }

    #[test]
    fn plan_accepts_all_defaults_omitted() {
        let args = names(&["a", "b"]);
        let plan = plan_call_args(&args, 2, &provided(&[])).unwrap();
        assert_eq!(plan, vec![ArgSource::Default(0), ArgSource::Default(1)]);
    }

    #[test]
    fn exposure_skips_underscore_and_honours_declared_subset() {
        let methods = names(&["spawn_marker", "_internal", "get_speed"]);
        assert_eq!(exposed_method_names(&methods, None), names(&["spawn_marker", "get_speed"]));
        let declared = names(&["get_speed", "not_a_method"]);
        assert_eq!(exposed_method_names(&methods, Some(&declared)), names(&["get_speed"]));
    }

    #[test]
    fn fingerprint_is_order_insensitive_and_change_sensitive() {
        let a = names(&["/root/A:x()", "/root/B:y()"]);
        let b = names(&["/root/B:y()", "/root/A:x()"]);
        let c = names(&["/root/B:y()"]);
        assert_eq!(fingerprint(&a), fingerprint(&b));
        assert_ne!(fingerprint(&a), fingerprint(&c));
    }

    #[test]
    fn project_call_rejects_non_object_args() {
        let ctx = FrameContext { frame_index: 1, last_delta_ms: 16.0 };
        match project_call(&json!({ "method": "spawn", "args": [1, 2] }), &ctx) {
            HandlerOutcome::Done(Err(err)) => assert_eq!(err.code(), "invalid_args"),
            _ => panic!("expected invalid_args before any engine call"),
        }
    }

    #[test]
    fn project_call_requires_method() {
        let ctx = FrameContext { frame_index: 1, last_delta_ms: 16.0 };
        match project_call(&json!({}), &ctx) {
            HandlerOutcome::Done(Err(err)) => assert_eq!(err.code(), "invalid_args"),
            _ => panic!("expected invalid_args before any engine call"),
        }
    }
}
