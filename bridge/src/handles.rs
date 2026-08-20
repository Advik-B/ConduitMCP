//! The object handle table: how a tool call names an engine object that has no
//! name.
//!
//! The target grammar reaches nodes by path, singletons by class, and resources
//! by `res://` path. Everything else -- `PhysicsDirectSpaceState3D`,
//! `SurfaceTool`, `MeshDataTool`, `EditorSelection`, `RegEx`, and a runtime
//! resource nothing has saved -- is an `Object` with no stable name, so nothing
//! could hold one across two tool calls. That is why `gd_physics` wraps
//! space-state queries as dedicated ops instead of exposing the object.
//!
//! A handle is a small integer standing for one live object, minted explicitly
//! and released explicitly. The table is per bridge process: a handle taken out
//! of the game bridge means nothing to the editor bridge, which is why the
//! bookkeeping tool is two tools (`gd_object`, `gd_scene_object`) rather than
//! one with a bridge argument.
//!
//! Everything here runs on the main thread inside `_process`, so a plain
//! `thread_local! RefCell` is sufficient and no locking is needed -- the same
//! argument `debugger.rs` and the websocket table in `handlers/runtime/net.rs`
//! make.
//!
//! Liveness is the one subtle part. The entry keeps a strong reference only
//! when the object is `RefCounted`; a manually managed object can be freed
//! while a handle still names it. Resolution therefore always goes through
//! `try_from_instance_id` rather than through the stored pointer, so a dead
//! handle reports its death instead of panicking.

use std::cell::RefCell;
use std::collections::BTreeMap;

use godot::builtin::VariantType;
use godot::classes::RefCounted;
use godot::prelude::*;
use serde_json::{json, Value};

use crate::protocol::BridgeError;

/// How many handles one bridge process will hold at once.
///
/// At capacity minting is refused rather than evicted. An LRU would let a
/// handle an agent still holds disappear for reasons it cannot observe, which
/// is the misreporting failure mode this codebase rejects elsewhere (see the
/// undo argument in `handlers/editor/resource.rs`). Refusing is the
/// `WS_MAX_CONNECTIONS` precedent in `handlers/runtime/net.rs`.
pub const MAX_HANDLES: usize = 64;

/// The scheme prefix, shared with the target grammar so a handle reads the same
/// everywhere it appears.
pub const HANDLE_PREFIX: &str = "object:";

struct Entry {
    instance_id: InstanceId,
    class: String,
    /// `Some` only for `RefCounted` objects, where holding it keeps the object
    /// alive. For a manually managed object the table deliberately holds no
    /// pointer at all, so there is nothing that could dangle.
    strong: Option<Gd<Object>>,
}

thread_local! {
    static HANDLES: RefCell<BTreeMap<u64, Entry>> = const { RefCell::new(BTreeMap::new()) };
    static NEXT_ID: RefCell<u64> = const { RefCell::new(1) };
}

/// A handle as it appears on the wire: `object:3`.
pub fn format_handle(id: u64) -> String {
    format!("{HANDLE_PREFIX}{id}")
}

/// Parse a handle from either full (`object:3`) or bare (`3`) form.
///
/// Both are accepted because the same id arrives through two doors: the
/// `target` string, which carries the scheme, and the tagged Variant form,
/// where a caller may reasonably write either. Engine-free, so it is
/// unit-tested here.
pub fn parse_handle_id(text: &str) -> Result<u64, BridgeError> {
    let trimmed = text.trim();
    let digits = trimmed.strip_prefix(HANDLE_PREFIX).unwrap_or(trimmed).trim();
    if digits.is_empty() {
        return Err(BridgeError::InvalidArgs(
            "an object handle is empty; expected for example 'object:3'".into(),
        ));
    }
    digits.parse::<u64>().map_err(|_| {
        BridgeError::InvalidArgs(format!(
            "'{trimmed}' is not an object handle; expected for example 'object:3'"
        ))
    })
}

/// Take a handle on `object`, so later calls can name it.
///
/// Minting is always explicit: no conversion path mints on its own, because a
/// returned dictionary full of colliders would otherwise fill the table with
/// handles nobody asked for (see `variant_json::variant_to_json`, which stays
/// pure for that reason).
pub fn mint(object: Gd<Object>) -> Result<u64, BridgeError> {
    let held = HANDLES.with(|table| table.borrow().len());
    if held >= MAX_HANDLES {
        return Err(BridgeError::ResourceError(format!(
            "this bridge already holds {held} object handles (max {MAX_HANDLES}); release one before taking another"
        )));
    }

    let instance_id = object.instance_id_unchecked();
    let class = object.get_class().to_string();
    let strong = object.clone().try_cast::<RefCounted>().ok().map(|refcounted| refcounted.upcast::<Object>());

    let id = NEXT_ID.with(|next| {
        let mut next = next.borrow_mut();
        let id = *next;
        *next += 1;
        id
    });
    HANDLES.with(|table| {
        table.borrow_mut().insert(id, Entry { instance_id, class, strong });
    });
    Ok(id)
}

/// The object a handle names, or an error saying which of the two things went
/// wrong: the handle was never minted, or the object behind it is gone.
pub fn resolve(id: u64) -> Result<Gd<Object>, BridgeError> {
    let known =
        HANDLES.with(|table| table.borrow().get(&id).map(|entry| (entry.instance_id, entry.class.clone())));
    let Some((instance_id, class)) = known else {
        return Err(BridgeError::ObjectNotFound(format!(
            "no object handle {}; take one with the create op, or with capture on a call that returns an object",
            format_handle(id)
        )));
    };
    Gd::<Object>::try_from_instance_id(instance_id).map_err(|_| {
        BridgeError::ObjectNotFound(format!(
            "{} named a {class} that no longer exists; it was freed after the handle was taken",
            format_handle(id)
        ))
    })
}

/// The class an entry recorded at mint time, for callers that want to name the
/// object without resolving it: a dead handle still knows what it was.
pub fn class_of(id: u64) -> Option<String> {
    HANDLES.with(|table| table.borrow().get(&id).map(|entry| entry.class.clone()))
}

/// Drop a handle. Reports whether it was there.
///
/// This never frees the object. `create` only builds `RefCounted` classes, so
/// dropping the reference is the whole of the cleanup; a captured object
/// belongs to whatever handed it out, and freeing it here would be a surprise.
pub fn release(id: u64) -> bool {
    HANDLES.with(|table| table.borrow_mut().remove(&id).is_some())
}

/// Drop every handle, returning how many there were.
pub fn release_all() -> usize {
    HANDLES.with(|table| {
        let mut table = table.borrow_mut();
        let count = table.len();
        table.clear();
        count
    })
}

/// Every handle with the class it named and whether the object is still alive,
/// so a dead handle is visible rather than only discovered on use.
pub fn list() -> Vec<Value> {
    HANDLES.with(|table| {
        table
            .borrow()
            .iter()
            .map(|(id, entry)| {
                json!({
                    "handle": format_handle(*id),
                    "id": id,
                    "class": entry.class,
                    "refcounted": entry.strong.is_some(),
                    "valid": Gd::<Object>::try_from_instance_id(entry.instance_id).is_ok(),
                })
            })
            .collect()
    })
}

/// The opt-in `capture` argument on a call or a property read: if the value
/// that came back is an object, take a handle on it and say so in the
/// response.
///
/// Capture is a flag rather than automatic because `variant_to_json` recurses
/// into arrays and dictionaries, and a `gd_physics intersect_point` result
/// carries collider objects that already have node paths; minting for those
/// would fill the table with entries nobody asked for. Only the top-level value
/// is considered, which is the limitation `docs/api-gaps.md` records.
///
/// Asking to capture a non-object is not an error: the response says
/// `captured: false`, so a caller can tell "there was nothing to hold" from
/// "the handle is here" without parsing the value itself.
pub fn apply_capture(args: &Value, value: &Variant, response: &mut Value) -> Result<(), BridgeError> {
    if crate::handlers::args::optional_bool(args, "capture") != Some(true) {
        return Ok(());
    }
    let Some(map) = response.as_object_mut() else {
        return Err(BridgeError::Internal("capture needs an object response to write into".into()));
    };
    if value.get_type() != VariantType::OBJECT {
        map.insert("captured".into(), Value::Bool(false));
        return Ok(());
    }
    let object = value.try_to::<Gd<Object>>().map_err(|_| {
        BridgeError::ObjectNotFound(
            "the value is an object but no longer addressable; it was freed before it could be captured".into(),
        )
    })?;
    let class = object.get_class().to_string();
    let id = mint(object)?;
    // Flat fields rather than the tagged `__type: Object` form the input side
    // accepts: a response is read, not fed back verbatim, and `handle` beside
    // `result` is easier to read than a second nested object next to it. The
    // caller builds the tagged form when it wants to pass the handle onward.
    map.insert("captured".into(), Value::Bool(true));
    map.insert("handle".into(), Value::String(format_handle(id)));
    map.insert("handle_class".into(), Value::String(class));
    Ok(())
}

pub fn count() -> usize {
    HANDLES.with(|table| table.borrow().len())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn handles_format_and_parse_round_trip() {
        for id in [1_u64, 7, 64, 9999] {
            assert_eq!(parse_handle_id(&format_handle(id)).unwrap(), id);
        }
    }

    #[test]
    fn a_bare_number_is_accepted_as_a_handle() {
        assert_eq!(parse_handle_id("3").unwrap(), 3);
        assert_eq!(parse_handle_id(" object: 12 ").unwrap(), 12);
    }

    #[test]
    fn non_numeric_and_empty_handles_are_rejected() {
        assert_eq!(parse_handle_id("object:").unwrap_err().code(), "invalid_args");
        assert_eq!(parse_handle_id("   ").unwrap_err().code(), "invalid_args");
        assert_eq!(parse_handle_id("object:abc").unwrap_err().code(), "invalid_args");
        assert_eq!(parse_handle_id("object:-1").unwrap_err().code(), "invalid_args");
    }

    #[test]
    fn an_unminted_handle_resolves_to_object_not_found() {
        // Engine-free: the lookup fails before any engine call is made, because
        // the id is not in the table at all.
        assert_eq!(resolve(4_000_000).unwrap_err().code(), "object_not_found");
    }

    #[test]
    fn releasing_an_absent_handle_reports_it_rather_than_failing() {
        assert!(!release(4_000_001));
    }
}
