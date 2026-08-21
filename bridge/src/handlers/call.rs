//! Dynamic method dispatch: the one place a caller-supplied method name and
//! caller-supplied arguments meet the engine.
//!
//! Two things live here because both are consequences of the same fact -- that
//! the arguments came off the wire and may be wrong.
//!
//! The first is error shape. gdext's `Object::call` is
//! `try_call(...).unwrap_or_else(|e| panic!("{e}"))`, so an argument the method
//! cannot accept used to reach the client as `internal_error: handler panicked`
//! by way of the dispatcher's `catch_unwind`: the caller could not tell a bad
//! argument from a genuine fault, which is the divergence from whitepaper
//! section 7.4 that `docs/api-gaps.md` recorded. Calling `try_call` instead and
//! mapping its `CallError` gives the caller the parameter index and the types
//! involved, in the engine's own words.
//!
//! The second is the static call. `FileAccess.open` and `DirAccess.open` are
//! static methods on a class, so there is no instance to dispatch through and
//! `ClassDb::class_call_static` is the only door. It is a varcall like every
//! other dynamic call and fails the same way, so it shares the mapping rather
//! than growing a second one.

use godot::classes::ClassDb;
use godot::meta::error::CallError;
use godot::obj::EngineBitfield;
use godot::prelude::*;
use godot::register::info::MethodFlags;
use serde_json::Value;

use crate::protocol::BridgeError;
use crate::variant_json::json_to_variant;

/// The optional `args` array of a call tool, converted to Variants.
///
/// Callers run this before resolving the target, deliberately: the conversion
/// does not depend on what is being called, and doing it first is what lets the
/// static and instance paths share one argument list. The visible consequence
/// is that a tagged `Resource` argument is loaded, and a tagged `Object` handle
/// resolved, before a bad target is reported. Neither mutates anything and a
/// load is cached, so the cost is an ordering difference in the error, not in
/// the effect.
pub fn call_args(args: &Value) -> Result<Vec<Variant>, BridgeError> {
    match args.get("args") {
        None | Some(Value::Null) => Ok(Vec::new()),
        Some(Value::Array(items)) => items.iter().map(json_to_variant).collect(),
        Some(_) => Err(BridgeError::InvalidArgs("'args' must be an array".into())),
    }
}

/// Map a failed varcall onto the structured error model.
///
/// `invalid_args` rather than `call_failed` for every kind, because gdext 0.5.5
/// exposes `class_name`, `method_name`, and `message` on `CallError` but no
/// public accessor for its `CallErrorType`, so the kinds cannot be told apart
/// structurally. They do not need to be: a `CallError` is always a dispatch
/// failure -- a method that fails at runtime returns normally -- and every
/// caller here prechecks that the method exists, which leaves argument type and
/// argument count. The engine's own message carries the rest.
fn call_error(error: CallError) -> BridgeError {
    BridgeError::InvalidArgs(error.to_string())
}

/// Call a method on an object with caller-supplied arguments.
pub fn call_on(object: &mut Gd<Object>, method: &str, args: &[Variant]) -> Result<Variant, BridgeError> {
    object.try_call(method, args).map_err(call_error)
}

/// Call a static method on a class, for the `class:<Class>` target scheme.
///
/// The STATIC precheck is what makes the scheme usable rather than merely
/// possible: the likely mistake is naming an instance method, and dispatching
/// blind would answer that with an argument error about the class name.
pub fn call_static(class: &str, method: &str, args: &[Variant]) -> Result<Variant, BridgeError> {
    let mut db = ClassDb::singleton();
    if !db.class_exists(class) {
        return Err(BridgeError::InvalidArgs(format!(
            "class '{class}' does not exist in this engine build"
        )));
    }
    match static_method_exists(&db, class, method) {
        StaticLookup::Static => {}
        StaticLookup::Instance => {
            return Err(BridgeError::InvalidArgs(format!(
                "'{class}.{method}' is an instance method, not a static one; obtain an instance first (for example with a static factory such as open) and call it on the object handle that came back"
            )))
        }
        StaticLookup::Absent => {
            return Err(BridgeError::CallFailed(format!("class '{class}' has no method '{method}'")))
        }
    }
    db.try_class_call_static(class, method, args).map_err(call_error)
}

enum StaticLookup {
    Static,
    Instance,
    Absent,
}

/// Whether a `class_get_method_list` entry describes a static method.
///
/// `class_has_method` answers for both kinds and carries no flags, so the
/// method list is the only door. Measured rather than assumed:
/// `FileAccess.open` and `DirAccess.open` report flags 33, which is
/// NORMAL|STATIC, while `FileAccess.get_as_text` reports 5 and
/// `ResourceLoader.load` reports 1.
pub(crate) fn method_dict_is_static(dict: &VarDictionary) -> bool {
    crate::handlers::classdb::dict_i64(dict, "flags") & (MethodFlags::STATIC.ord() as i64) != 0
}

/// Whether a class declares `method`, and if so whether it is static.
///
/// Inheritance is included, matching `class_call_static`: the two could have
/// disagreed about a static a class inherits rather than declares, which would
/// have let the precheck pass a call the dispatch then refused. Measured across
/// all 1510 classes in the 4.7 build -- 1714 inherited statics, mostly
/// `Node.print_orphan_nodes` and `Window.get_focused_window` -- and every one
/// dispatches on the subclass name.
fn static_method_exists(db: &ClassDb, class: &str, method: &str) -> StaticLookup {
    for dict in db.class_get_method_list(class).iter_shared() {
        if crate::handlers::classdb::dict_str(&dict, "name") != method {
            continue;
        }
        return if method_dict_is_static(&dict) {
            StaticLookup::Static
        } else {
            StaticLookup::Instance
        };
    }
    StaticLookup::Absent
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    // Engine-free: both of these settle while reading the argument, before any
    // Variant is built. The populated case converts through json_to_variant,
    // which does call into the engine, and is covered by the live runners.

    #[test]
    fn an_absent_args_array_is_an_empty_call() {
        assert!(call_args(&json!({ "method": "get_name" })).unwrap().is_empty());
        assert!(call_args(&json!({ "args": Value::Null })).unwrap().is_empty());
    }

    #[test]
    fn args_must_be_an_array() {
        assert_eq!(call_args(&json!({ "args": 3 })).unwrap_err().code(), "invalid_args");
        assert_eq!(call_args(&json!({ "args": { "x": 1 } })).unwrap_err().code(), "invalid_args");
        assert_eq!(call_args(&json!({ "args": "one" })).unwrap_err().code(), "invalid_args");
    }
}
