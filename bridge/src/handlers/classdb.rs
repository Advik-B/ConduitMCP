//! ClassDB introspection (whitepaper section 8 "API introspection"),
//! registered by both personalities so the agent can ground itself in the
//! exact engine build. Read-only. List-style ops paginate per section 7.1.

use godot::builtin::VariantType;
use godot::classes::ClassDb;
use godot::prelude::*;
use serde_json::{json, Value};

use crate::dispatcher::{FrameContext, HandlerOutcome};
use crate::handlers::args::{optional_bool, optional_str, optional_u64, require_str};
use crate::protocol::BridgeError;

const DEFAULT_CLASS_LIMIT: u64 = 100;
const DEFAULT_MEMBER_LIMIT: u64 = 50;

// PROPERTY_USAGE_GROUP | PROPERTY_USAGE_CATEGORY | PROPERTY_USAGE_SUBGROUP:
// inspector section markers in get_property_list output, not real properties.
const GROUP_MARKER_USAGE: i64 = 64 | 128 | 256;

pub fn classdb(args: &Value, _ctx: &FrameContext) -> HandlerOutcome {
    HandlerOutcome::Done((|| {
        let op = require_str(args, "op")?;
        match op.as_str() {
            "list_classes" => list_classes(args),
            "class_info" => class_info(args),
            "properties" => members(args, list_properties),
            "methods" => members(args, list_methods),
            "signals" => members(args, list_signals),
            "constants" => members(args, list_constants),
            "enums" => members(args, list_enums),
            "parents" => parents(args),
            "exists" => exists(args),
            other => Err(BridgeError::InvalidArgs(format!(
                "unknown op '{other}'; expected list_classes, class_info, properties, methods, signals, constants, enums, parents, or exists"
            ))),
        }
    })())
}

/// Slice a full item list into the section 7.1 pagination envelope. Shared
/// with the node-query handlers, which paginate the same way.
pub fn paginate(items: Vec<Value>, limit: u64, offset: u64) -> Value {
    let total = items.len() as u64;
    let start = offset.min(total) as usize;
    let end = offset.saturating_add(limit).min(total) as usize;
    let has_more = (end as u64) < total;
    json!({
        "items": items[start..end].to_vec(),
        "total_count": total,
        "has_more": has_more,
        "next_offset": if has_more { json!(end as u64) } else { Value::Null },
    })
}

fn require_class(args: &Value) -> Result<String, BridgeError> {
    let class = require_str(args, "class")?;
    if !ClassDb::singleton().class_exists(class.as_str()) {
        return Err(BridgeError::InvalidArgs(format!("class '{class}' does not exist in this engine build")));
    }
    Ok(class)
}

fn dict_str(dict: &VarDictionary, key: &str) -> String {
    dict.get(&GString::from(key)).map(|v| v.to_string()).unwrap_or_default()
}

fn dict_i64(dict: &VarDictionary, key: &str) -> i64 {
    dict.get(&GString::from(key)).and_then(|v| v.try_to::<i64>().ok()).unwrap_or(0)
}

/// A readable type label for a property/argument dictionary: the class name
/// for object types, otherwise the canonical Variant type name.
fn type_label(dict: &VarDictionary) -> String {
    let class_name = dict_str(dict, "class_name");
    if !class_name.is_empty() {
        return class_name;
    }
    VariantType { ord: dict_i64(dict, "type") as i32 }.godot_type_name().to_string()
}

/// The `{name, type}` argument entries of a method or signal dictionary.
/// gdext's Array conversion is strict about the element type and the engine
/// does not document whether `args` is typed, so both shapes are accepted; a
/// single wrong guess would silently report every method as argument-free.
fn args_json(dict: &VarDictionary) -> Vec<Value> {
    let Some(value) = dict.get(&GString::from("args")) else {
        return Vec::new();
    };
    let arg_entry = |arg: &VarDictionary| json!({ "name": dict_str(arg, "name"), "type": type_label(arg) });
    if let Ok(typed) = value.try_to::<Array<VarDictionary>>() {
        return typed.iter_shared().map(|arg| arg_entry(&arg)).collect();
    }
    value
        .try_to::<VarArray>()
        .map(|arr| {
            arr.iter_shared()
                .filter_map(|item| item.try_to::<VarDictionary>().ok())
                .map(|arg| arg_entry(&arg))
                .collect()
        })
        .unwrap_or_default()
}

fn list_classes(args: &Value) -> Result<Value, BridgeError> {
    let filter = optional_str(args, "filter").map(|f| f.to_lowercase());
    let limit = optional_u64(args, "limit").unwrap_or(DEFAULT_CLASS_LIMIT);
    let offset = optional_u64(args, "offset").unwrap_or(0);

    let mut names: Vec<String> = ClassDb::singleton()
        .get_class_list()
        .to_vec()
        .into_iter()
        .map(|s| s.to_string())
        .filter(|name| filter.as_deref().is_none_or(|f| name.to_lowercase().contains(f)))
        .collect();
    names.sort_unstable();
    Ok(paginate(names.into_iter().map(Value::String).collect(), limit, offset))
}

fn class_info(args: &Value) -> Result<Value, BridgeError> {
    let class = require_class(args)?;
    let no_inheritance = optional_bool(args, "no_inheritance").unwrap_or(false);
    let db = ClassDb::singleton();
    let parent = db.get_parent_class(class.as_str()).to_string();
    Ok(json!({
        "class": class,
        "parent": if parent.is_empty() { Value::Null } else { json!(parent) },
        "instantiable": db.can_instantiate(class.as_str()),
        "counts": {
            "properties": db.class_get_property_list_ex(class.as_str()).no_inheritance(no_inheritance).done().len(),
            "methods": db.class_get_method_list_ex(class.as_str()).no_inheritance(no_inheritance).done().len(),
            "signals": db.class_get_signal_list_ex(class.as_str()).no_inheritance(no_inheritance).done().len(),
            "constants": db.class_get_integer_constant_list_ex(class.as_str()).no_inheritance(no_inheritance).done().len(),
            "enums": db.class_get_enum_list_ex(class.as_str()).no_inheritance(no_inheritance).done().len(),
        },
    }))
}

/// Shared shell for the paginated member ops: parse the common arguments once
/// and delegate to the per-member listing function.
fn members(args: &Value, list: fn(&str, bool) -> Vec<Value>) -> Result<Value, BridgeError> {
    let class = require_class(args)?;
    let no_inheritance = optional_bool(args, "no_inheritance").unwrap_or(false);
    let limit = optional_u64(args, "limit").unwrap_or(DEFAULT_MEMBER_LIMIT);
    let offset = optional_u64(args, "offset").unwrap_or(0);
    Ok(paginate(list(&class, no_inheritance), limit, offset))
}

fn list_properties(class: &str, no_inheritance: bool) -> Vec<Value> {
    ClassDb::singleton()
        .class_get_property_list_ex(class)
        .no_inheritance(no_inheritance)
        .done()
        .iter_shared()
        .filter(|dict| dict_i64(dict, "usage") & GROUP_MARKER_USAGE == 0)
        .map(|dict| json!({ "name": dict_str(&dict, "name"), "type": type_label(&dict) }))
        .collect()
}

fn list_methods(class: &str, no_inheritance: bool) -> Vec<Value> {
    ClassDb::singleton()
        .class_get_method_list_ex(class)
        .no_inheritance(no_inheritance)
        .done()
        .iter_shared()
        .map(|dict| {
            let return_type = dict
                .get(&GString::from("return"))
                .and_then(|v| v.try_to::<VarDictionary>().ok())
                .map(|ret| {
                    if dict_i64(&ret, "type") == 0 && dict_str(&ret, "class_name").is_empty() {
                        "void".to_string()
                    } else {
                        type_label(&ret)
                    }
                })
                .unwrap_or_else(|| "void".to_string());
            json!({ "name": dict_str(&dict, "name"), "return_type": return_type, "args": args_json(&dict) })
        })
        .collect()
}

fn list_signals(class: &str, no_inheritance: bool) -> Vec<Value> {
    ClassDb::singleton()
        .class_get_signal_list_ex(class)
        .no_inheritance(no_inheritance)
        .done()
        .iter_shared()
        .map(|dict| json!({ "name": dict_str(&dict, "name"), "args": args_json(&dict) }))
        .collect()
}

fn list_constants(class: &str, no_inheritance: bool) -> Vec<Value> {
    let db = ClassDb::singleton();
    db.class_get_integer_constant_list_ex(class)
        .no_inheritance(no_inheritance)
        .done()
        .to_vec()
        .into_iter()
        .map(|name| {
            let value = db.class_get_integer_constant(class, name.to_string().as_str());
            json!({ "name": name.to_string(), "value": value })
        })
        .collect()
}

fn list_enums(class: &str, no_inheritance: bool) -> Vec<Value> {
    let db = ClassDb::singleton();
    db.class_get_enum_list_ex(class)
        .no_inheritance(no_inheritance)
        .done()
        .to_vec()
        .into_iter()
        .map(|enum_name| {
            let enum_string = enum_name.to_string();
            let constants: Vec<Value> = db
                .class_get_enum_constants_ex(class, enum_string.as_str())
                .no_inheritance(no_inheritance)
                .done()
                .to_vec()
                .into_iter()
                .map(|constant| {
                    let value = db.class_get_integer_constant(class, constant.to_string().as_str());
                    json!({ "name": constant.to_string(), "value": value })
                })
                .collect();
            json!({ "name": enum_string, "constants": constants })
        })
        .collect()
}

fn parents(args: &Value) -> Result<Value, BridgeError> {
    let class = require_class(args)?;
    let db = ClassDb::singleton();
    let mut chain = Vec::new();
    let mut current = class.clone();
    loop {
        let parent = db.get_parent_class(current.as_str()).to_string();
        if parent.is_empty() {
            break;
        }
        chain.push(json!(parent));
        current = parent;
    }
    Ok(json!({ "class": class, "parents": chain }))
}

fn exists(args: &Value) -> Result<Value, BridgeError> {
    let class = require_str(args, "class")?;
    let db = ClassDb::singleton();
    let class_exists = db.class_exists(class.as_str());
    let mut result = json!({ "class": class, "class_exists": class_exists });
    if let Some(method) = optional_str(args, "method") {
        result["method_exists"] = json!(class_exists && db.class_has_method(class.as_str(), method.as_str()));
    }
    if let Some(signal) = optional_str(args, "signal") {
        result["signal_exists"] = json!(class_exists && db.class_has_signal(class.as_str(), signal.as_str()));
    }
    if let Some(property) = optional_str(args, "property") {
        let found = class_exists
            && db
                .class_get_property_list(class.as_str())
                .iter_shared()
                .any(|dict| dict_str(&dict, "name") == property);
        result["property_exists"] = json!(found);
    }
    Ok(result)
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
    fn classdb_requires_op() {
        assert_invalid_args(classdb(&json!({}), &ctx()));
    }

    #[test]
    fn classdb_rejects_unknown_op() {
        assert_invalid_args(classdb(&json!({ "op": "nope" }), &ctx()));
    }

    #[test]
    fn paginate_slices_and_reports() {
        let items: Vec<Value> = (0..10).map(|n| json!(n)).collect();
        let page = paginate(items.clone(), 4, 0);
        assert_eq!(page["items"].as_array().unwrap().len(), 4);
        assert_eq!(page["total_count"], 10);
        assert_eq!(page["has_more"], true);
        assert_eq!(page["next_offset"], 4);

        let tail = paginate(items.clone(), 4, 8);
        assert_eq!(tail["items"].as_array().unwrap().len(), 2);
        assert_eq!(tail["has_more"], false);
        assert!(tail["next_offset"].is_null());

        let past_end = paginate(items, 4, 50);
        assert_eq!(past_end["items"].as_array().unwrap().len(), 0);
        assert_eq!(past_end["has_more"], false);
    }

    #[test]
    fn paginate_handles_empty_input() {
        let page = paginate(Vec::new(), 10, 0);
        assert_eq!(page["total_count"], 0);
        assert_eq!(page["has_more"], false);
        assert!(page["next_offset"].is_null());
    }
}
