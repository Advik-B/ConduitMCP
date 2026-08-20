//! Arbitrary GDScript evaluation with deferred completion for `await`
//! (whitepaper sections 6.4 and 6.6). This is the highest-capability and
//! highest-risk runtime tool.
//!
//! The snippet is wrapped in a throwaway `Node` script that emits a completion
//! signal with the result. A native sink object captures that result; a
//! `PendingOp` polls the sink each frame and settles when it fills, so a snippet
//! that suspends on `await` completes frames later without blocking the game.
//! When the snippet contains no `await` the signal fires synchronously during
//! the initiating call and the op settles on its first poll.

use godot::classes::{GDScript, Node, RefCounted};
use godot::prelude::*;
use serde_json::{json, Value};

use crate::dispatcher::{FrameContext, HandlerOutcome, PendingOp};
use crate::handlers::runtime::support::{require_str, scene_root, variant_type_name};
use crate::protocol::BridgeError;
use crate::variant_json::variant_to_json;

/// A generous upper bound on how long a suspended evaluation may stay pending
/// on the bridge. The broker's per-request timeout normally settles this first;
/// the cap only bounds a snippet whose awaited signal never fires, so the
/// pending set cannot grow without limit (whitepaper section 6.4).
const EVAL_DEADLINE_FRAMES: u64 = 60 * 60 * 5;

/// Native receiver for the completion signal. Holds the result until the
/// `PendingOp` reads it; lives on the main thread only.
#[derive(GodotClass)]
#[class(base = RefCounted, init)]
pub struct ConduitEvalSink {
    base: Base<RefCounted>,
    done: bool,
    value: Option<Variant>,
}

#[godot_api]
impl ConduitEvalSink {
    #[func]
    fn on_done(&mut self, value: Variant) {
        self.value = Some(value);
        self.done = true;
    }
}

pub fn game_eval(args: &Value, ctx: &FrameContext) -> HandlerOutcome {
    let source = match require_str(args, "source") {
        Ok(source) => source,
        Err(err) => return HandlerOutcome::Done(Err(err)),
    };
    run_source(&source, ctx)
}

/// Compile and start a snippet, returning a pending op unless it fails to
/// compile. Shared by `gd_game_eval` and `gd_editor_eval`.
///
/// `gd_signal await` used to come through here too, which meant a deployment
/// that passed `--disable-eval` still compiled GDScript on this path. It now
/// connects a native callable instead (`crate::handlers::signals`); nothing
/// outside the two eval tools should reach this function again.
pub fn run_source(source: &str, ctx: &FrameContext) -> HandlerOutcome {
    if source.trim().is_empty() {
        return HandlerOutcome::Done(Err(BridgeError::InvalidArgs("'source' must not be empty".into())));
    }

    let mut script = GDScript::new_gd();
    script.set_source_code(&wrap_source(source));
    if script.reload() != godot::global::Error::OK {
        return HandlerOutcome::Done(Err(BridgeError::CallFailed(
            "evaluation source failed to compile; see gd_get_errors for the parser diagnostics".into(),
        )));
    }

    let root = match scene_root() {
        Ok(root) => root,
        Err(err) => return HandlerOutcome::Done(Err(err)),
    };

    let mut holder = Node::new_alloc();
    holder.set_script(&script);
    if !holder.has_method("_conduit_run") {
        holder.queue_free();
        return HandlerOutcome::Done(Err(BridgeError::CallFailed(
            "evaluation script did not attach; see gd_get_errors".into(),
        )));
    }

    let mut root = root;
    root.add_child(&holder);

    let sink = ConduitEvalSink::new_gd();
    holder.connect("_conduit_done", &Callable::from_object_method(&sink, "on_done"));
    holder.call("_conduit_run", &[]);

    HandlerOutcome::Pending(Box::new(EvalPending {
        holder,
        sink,
        deadline_frame: ctx.frame_index.saturating_add(EVAL_DEADLINE_FRAMES),
    }))
}

struct EvalPending {
    holder: Gd<Node>,
    sink: Gd<ConduitEvalSink>,
    deadline_frame: u64,
}

impl EvalPending {
    fn cleanup(&mut self) {
        if self.holder.is_instance_valid() {
            self.holder.queue_free();
        }
    }
}

impl PendingOp for EvalPending {
    fn poll(&mut self, ctx: &FrameContext) -> Option<Result<Value, BridgeError>> {
        if self.sink.bind().done {
            let value = self.sink.bind().value.clone().unwrap_or_else(Variant::nil);
            self.cleanup();
            return Some(Ok(json!({
                "type": variant_type_name(&value),
                "value": variant_to_json(&value),
            })));
        }
        if ctx.frame_index >= self.deadline_frame {
            self.cleanup();
            return Some(Err(BridgeError::CallFailed(
                "evaluation did not complete before the bridge deadline".into(),
            )));
        }
        None
    }
}

/// Wrap a snippet in a driver script. The driver awaits the snippet only when it
/// contains `await`, so a plain expression never awaits a non-coroutine, and
/// emits the result through `_conduit_done`. The `@tool` annotation lets the
/// same driver instantiate inside the editor process for gd_editor_eval; it is
/// inert in a running game.
fn wrap_source(source: &str) -> GString {
    let body = if source.contains("return") {
        source.to_string()
    } else {
        format!("return {source}")
    };
    let indented: String = body.lines().map(|line| format!("\t{line}\n")).collect();
    let run = if source.contains("await") {
        "\tvar __r = await _conduit_eval()\n\t_conduit_done.emit(__r)\n"
    } else {
        "\tvar __r = _conduit_eval()\n\t_conduit_done.emit(__r)\n"
    };
    let script = format!(
        "@tool\nextends Node\nsignal _conduit_done(value)\nfunc _conduit_run():\n{run}func _conduit_eval():\n{indented}"
    );
    GString::from(script.as_str())
}
