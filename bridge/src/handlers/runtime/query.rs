//! Runtime node search (whitepaper section 8 "Runtime inspection"): find
//! nodes by class, group, or name pattern in the live scene tree.

use godot::classes::Node;
use serde_json::{json, Value};

use crate::dispatcher::{FrameContext, HandlerOutcome};
use crate::handlers::args::{optional_str, optional_u64};
use crate::handlers::classdb::paginate;
use crate::handlers::node_query::{find_matching, NodeFilters, DEFAULT_FIND_LIMIT};
use crate::handlers::runtime::support::{resolve_node, scene_root};

pub fn find_nodes(args: &Value, _ctx: &FrameContext) -> HandlerOutcome {
    HandlerOutcome::Done((|| {
        let filters = NodeFilters::from_args(args)?;
        let limit = optional_u64(args, "limit").unwrap_or(DEFAULT_FIND_LIMIT);
        let offset = optional_u64(args, "offset").unwrap_or(0);
        let start = match optional_str(args, "root_path") {
            Some(path) => resolve_node(&path)?,
            None => scene_root()?.upcast::<Node>(),
        };
        let items = find_matching(&start, &filters, &mut |node| {
            json!({
                "path": node.get_path().to_string(),
                "name": node.get_name().to_string(),
                "class": node.get_class().to_string(),
            })
        });
        Ok(paginate(items, limit, offset))
    })())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn find_nodes_requires_a_filter() {
        let ctx = FrameContext { frame_index: 1, last_delta_ms: 16.0 };
        match find_nodes(&json!({}), &ctx) {
            HandlerOutcome::Done(Err(err)) => assert_eq!(err.code(), "invalid_args"),
            _ => panic!("expected an invalid_args error before any engine call"),
        }
    }
}
