//! Opt-in editor-process evaluation (whitepaper sections 8 and 9). The
//! handler is registered unconditionally, like the pixel tools; enforcement
//! is broker-side surface omission behind --enable-editor-eval. The runner is
//! the runtime eval machinery: the editor's MainLoop is a SceneTree, the
//! deferred-completion await path runs in the editor's dispatcher identically,
//! and the driver script is @tool so it instantiates in the editor.

use serde_json::Value;

use crate::dispatcher::{FrameContext, HandlerOutcome};
use crate::handlers::args::require_str;
use crate::handlers::runtime::eval::run_source;

pub fn editor_eval(args: &Value, ctx: &FrameContext) -> HandlerOutcome {
    let source = match require_str(args, "source") {
        Ok(source) => source,
        Err(err) => return HandlerOutcome::Done(Err(err)),
    };
    run_source(&source, ctx)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn editor_eval_requires_source() {
        let ctx = FrameContext { frame_index: 1, last_delta_ms: 16.0 };
        match editor_eval(&json!({}), &ctx) {
            HandlerOutcome::Done(Err(err)) => assert_eq!(err.code(), "invalid_args"),
            _ => panic!("expected an invalid_args error before any engine call"),
        }
    }
}
