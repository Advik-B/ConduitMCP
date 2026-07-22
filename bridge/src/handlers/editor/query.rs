//! Edited-scene node search (whitepaper section 8 "Scene structure"): the
//! editor-bridge counterpart of gd_find_nodes, reporting scene-relative paths.

use serde_json::{json, Value};

use crate::dispatcher::{FrameContext, HandlerOutcome};
use crate::handlers::args::{optional_str, optional_u64};
use crate::handlers::classdb::paginate;
use crate::handlers::editor::support::{edited_scene_root, relative_path, resolve_editor_node};
use crate::handlers::node_query::{find_matching, NodeFilters, DEFAULT_FIND_LIMIT};

pub fn scene_find_nodes(args: &Value, _ctx: &FrameContext) -> HandlerOutcome {
    HandlerOutcome::Done((|| {
        let filters = NodeFilters::from_args(args)?;
        let limit = optional_u64(args, "limit").unwrap_or(DEFAULT_FIND_LIMIT);
        let offset = optional_u64(args, "offset").unwrap_or(0);
        let root = edited_scene_root()?;
        let start = match optional_str(args, "root_path") {
            Some(path) => resolve_editor_node(&path)?,
            None => root.clone(),
        };
        let items = find_matching(&start, &filters, &mut |node| {
            json!({
                "path": relative_path(&root, node),
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
    fn scene_find_nodes_requires_a_filter() {
        let ctx = FrameContext { frame_index: 1, last_delta_ms: 16.0 };
        match scene_find_nodes(&json!({}), &ctx) {
            HandlerOutcome::Done(Err(err)) => assert_eq!(err.code(), "invalid_args"),
            _ => panic!("expected an invalid_args error before any engine call"),
        }
    }
}
