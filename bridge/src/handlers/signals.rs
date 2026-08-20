//! Signal operations over any object the target grammar can name, shared by
//! both bridges (`gd_signal` in a running game, `gd_scene_signal` in the
//! editor).
//!
//! Before this existed the two signal tools were the only generic verbs that
//! had never learned the `target` grammar: both resolved `node_path` through a
//! scene tree, so a signal on a singleton, on a handle-held object, or on a
//! resource was reachable only by writing GDScript. That is the whole of what
//! the coverage matrix still graded T2 in the class reference.
//!
//! `await` is the part that needed a new mechanism rather than a new argument.
//! It used to generate `return await Signal(get_node(path), signal)` and hand
//! it to the evaluation runner, which limited it to node paths by construction
//! and ran the eval machinery even in a deployment that passed `--disable-eval`
//! to drop it. The native implementation connects a Rust callable and settles a
//! `PendingOp` when it fires. `Callable::from_fn` takes `&[&Variant]`, so it
//! accepts a signal of any arity; a `#[func]` method (the `ConduitEvalSink`
//! idiom) has a fixed one, and the signal name only arrives as a string at run
//! time, so there is no sink class to pick.

use std::cell::RefCell;
use std::rc::Rc;

use godot::classes::object::ConnectFlags;
use godot::obj::EngineBitfield;
use godot::prelude::*;
use serde_json::{json, Value};

use crate::dispatcher::{FrameContext, HandlerOutcome, PendingOp};
use crate::handlers::runtime::support::{object_signal_names, variant_type_name};
use crate::handlers::target::{target_response, TargetSpec};
use crate::protocol::BridgeError;
use crate::variant_json::{json_to_variant, variant_to_json};

/// A generous upper bound on how long an await may stay pending on the bridge,
/// matching the evaluation runner's. The broker's per-request timeout normally
/// settles first; this only bounds a signal that never fires, so the pending
/// set cannot grow without limit (whitepaper section 6.4).
const AWAIT_DEADLINE_FRAMES: u64 = 60 * 60 * 5;

/// Reject a signal name the object does not declare, before connecting or
/// emitting. Godot answers a missing signal with an error code the caller would
/// otherwise have to interpret.
fn require_signal(object: &Gd<Object>, signal: &str, label: &str) -> Result<(), BridgeError> {
    if object.has_signal(signal) {
        return Ok(());
    }
    Err(BridgeError::InvalidArgs(format!(
        "'{label}' ({}) has no signal '{signal}'",
        object.get_class()
    )))
}

/// Every signal the object declares, with how many connections each carries.
pub fn list_signals(object: &Gd<Object>, filter: Option<&str>) -> Vec<Value> {
    object_signal_names(object)
        .into_iter()
        .filter(|name| filter.is_none_or(|wanted| wanted == name))
        .map(|name| {
            let connections = object.get_signal_connection_list(name.as_str()).len();
            json!({ "name": name, "connection_count": connections })
        })
        .collect()
}

/// The `args` array as Variants, for `emit`.
pub fn emit_args(args: &Value) -> Result<Vec<Variant>, BridgeError> {
    match args.get("args") {
        None | Some(Value::Null) => Ok(Vec::new()),
        Some(Value::Array(items)) => items.iter().map(json_to_variant).collect(),
        Some(_) => Err(BridgeError::InvalidArgs("'args' must be an array".into())),
    }
}

/// Emit a signal on any object.
pub fn emit_signal(
    object: &mut Gd<Object>,
    signal: &str,
    label: &str,
    args: &Value,
) -> Result<(), BridgeError> {
    require_signal(object, signal, label)?;
    let varargs = emit_args(args)?;
    let error = object.emit_signal(signal, &varargs);
    if error != godot::global::Error::OK {
        return Err(BridgeError::CallFailed(format!("emit of {label}.{signal} failed ({error:?})")));
    }
    Ok(())
}

/// One end of a connection: what the caller named it, and what that name
/// resolved to. The two travel together because every error message here quotes
/// the name while every engine call needs the object.
pub struct Endpoint {
    pub spec: TargetSpec,
    pub object: Gd<Object>,
}

impl Endpoint {
    pub fn label(&self) -> String {
        self.spec.label()
    }
}

/// Connect a signal to a method on another object, with explicit flags.
pub fn connect_signal(
    source: &mut Endpoint,
    signal: &str,
    receiver: &Endpoint,
    method: &str,
    flags: u32,
) -> Result<(), BridgeError> {
    let (source_label, receiver_label) = (source.label(), receiver.label());
    require_signal(&source.object, signal, &source_label)?;
    let callable = Callable::from_object_method(&receiver.object, method);
    if source.object.is_connected(signal, &callable) {
        return Err(BridgeError::AlreadyExists(format!(
            "{source_label}.{signal} is already connected to {receiver_label}.{method}"
        )));
    }
    let error = source.object.connect_flags(signal, &callable, ConnectFlags::from_ord(flags as u64));
    if error != godot::global::Error::OK {
        return Err(BridgeError::CallFailed(format!(
            "could not connect {source_label}.{signal} to {receiver_label}.{method} ({error:?})"
        )));
    }
    Ok(())
}

/// Sever a connection made to a method on another object.
pub fn disconnect_signal(
    source: &mut Endpoint,
    signal: &str,
    receiver: &Endpoint,
    method: &str,
) -> Result<(), BridgeError> {
    let callable = Callable::from_object_method(&receiver.object, method);
    if !source.object.is_connected(signal, &callable) {
        return Err(BridgeError::InvalidArgs(format!(
            "{}.{signal} is not connected to {}.{method}",
            source.label(),
            receiver.label()
        )));
    }
    source.object.disconnect(signal, &callable);
    Ok(())
}

/// Suspend until `signal` fires on `object`, then settle with its arguments.
///
/// The pending op holds the emitter's instance id rather than a `Gd`, and
/// re-resolves it on every poll the way `crate::handles` does: an awaited
/// `Tween` or `SceneTreeTimer` can free itself mid-wait, and a dead emitter has
/// to answer `object_not_found` rather than be dereferenced.
pub fn await_signal(
    mut object: Gd<Object>,
    signal: &str,
    spec: &TargetSpec,
    ctx: &FrameContext,
) -> HandlerOutcome {
    let label = spec.label();
    if let Err(err) = require_signal(&object, signal, &label) {
        return HandlerOutcome::Done(Err(err));
    }

    let fired: Rc<RefCell<Option<Vec<Variant>>>> = Rc::new(RefCell::new(None));
    let sink = Rc::clone(&fired);
    let callable = Callable::from_fn(format!("conduit_await_{signal}"), move |args: &[&Variant]| {
        *sink.borrow_mut() = Some(args.iter().map(|value| (*value).clone()).collect());
        Variant::nil()
    });

    // ONE_SHOT covers the fired case. It does not cover the deadline case, and
    // a callable made with from_fn is not tied to any object's lifetime, so the
    // pending op disconnects explicitly on every settle path as well.
    let error = object.connect_flags(signal, &callable, ConnectFlags::ONE_SHOT);
    if error != godot::global::Error::OK {
        return HandlerOutcome::Done(Err(BridgeError::CallFailed(format!(
            "could not connect to {label}.{signal} to await it ({error:?})"
        ))));
    }

    HandlerOutcome::Pending(Box::new(SignalWait {
        instance_id: object.instance_id_unchecked(),
        signal: signal.to_string(),
        spec: spec.clone(),
        callable,
        fired,
        deadline_frame: ctx.frame_index.saturating_add(AWAIT_DEADLINE_FRAMES),
    }))
}

/// What GDScript `await` on a signal yields, which is what the eval-backed
/// implementation used to put in `value`: nothing for a signal with no
/// arguments, the argument itself for one, and an array for more than one.
/// Reproduced rather than replaced with the first argument, because a caller
/// written against the old response would otherwise read `a` where it used to
/// read `[a, b]` and never be told. `args` is the unambiguous field; this one
/// exists for continuity.
fn awaited_value(values: &[Variant]) -> Variant {
    match values {
        [] => Variant::nil(),
        [single] => single.clone(),
        many => {
            let mut array = Array::<Variant>::new();
            for value in many {
                array.push(value);
            }
            array.to_variant()
        }
    }
}

struct SignalWait {
    instance_id: InstanceId,
    signal: String,
    spec: TargetSpec,
    callable: Callable,
    fired: Rc<RefCell<Option<Vec<Variant>>>>,
    deadline_frame: u64,
}

impl SignalWait {
    /// Drop the connection if the emitter is still alive. A freed emitter took
    /// its connections with it, and resolving a dead id is a lookup rather than
    /// a dereference, so this is safe on every path.
    fn disconnect(&self) {
        if let Ok(mut object) = Gd::<Object>::try_from_instance_id(self.instance_id)
            && object.is_connected(self.signal.as_str(), &self.callable)
        {
            object.disconnect(self.signal.as_str(), &self.callable);
        }
    }

    fn settled(&self, values: Vec<Variant>) -> Value {
        let awaited = awaited_value(&values);
        target_response(
            &self.spec,
            json!({
                "signal": self.signal,
                "args": values.iter().map(variant_to_json).collect::<Vec<Value>>(),
                "value": variant_to_json(&awaited),
                "type": variant_type_name(&awaited),
            }),
        )
    }
}

impl PendingOp for SignalWait {
    fn poll(&mut self, ctx: &FrameContext) -> Option<Result<Value, BridgeError>> {
        if let Some(values) = self.fired.borrow_mut().take() {
            self.disconnect();
            return Some(Ok(self.settled(values)));
        }
        if Gd::<Object>::try_from_instance_id(self.instance_id).is_err() {
            return Some(Err(BridgeError::ObjectNotFound(format!(
                "{} was freed while awaiting '{}'; the signal can no longer fire",
                self.spec.label(),
                self.signal
            ))));
        }
        if ctx.frame_index >= self.deadline_frame {
            self.disconnect();
            return Some(Err(BridgeError::CallFailed(format!(
                "{}.{} did not fire before the bridge deadline",
                self.spec.label(),
                self.signal
            ))));
        }
        None
    }
}
