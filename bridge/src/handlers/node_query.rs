//! Shared class/group/name-pattern node search used by both bridges
//! (whitepaper section 8). The walk and the glob matcher are engine-free in
//! shape; only `matches` touches the engine, so the filter and glob logic
//! stay unit-testable under plain `cargo test`.

use godot::classes::Node;
use godot::prelude::*;
use serde_json::Value;

use crate::handlers::args::optional_str;
use crate::protocol::BridgeError;

pub const DEFAULT_FIND_LIMIT: u64 = 50;

#[derive(Debug)]
pub struct NodeFilters {
    pub class: Option<String>,
    pub group: Option<String>,
    pub name_pattern: Option<String>,
}

impl NodeFilters {
    /// Parse the shared filter arguments, requiring at least one so a bare
    /// call cannot dump an entire tree unfiltered.
    pub fn from_args(args: &Value) -> Result<NodeFilters, BridgeError> {
        let filters = NodeFilters {
            class: optional_str(args, "class"),
            group: optional_str(args, "group"),
            name_pattern: optional_str(args, "name_pattern"),
        };
        if filters.class.is_none() && filters.group.is_none() && filters.name_pattern.is_none() {
            return Err(BridgeError::InvalidArgs(
                "provide at least one of 'class', 'group', or 'name_pattern'".into(),
            ));
        }
        Ok(filters)
    }

    fn matches(&self, node: &Gd<Node>) -> bool {
        if self.class.as_deref().is_some_and(|class| !node.is_class(class)) {
            return false;
        }
        if self.group.as_deref().is_some_and(|group| !node.is_in_group(group)) {
            return false;
        }
        if self
            .name_pattern
            .as_deref()
            .is_some_and(|pattern| !glob_match(&node.get_name().to_string(), pattern))
        {
            return false;
        }
        true
    }
}

/// Depth-first walk from `start` (inclusive), collecting an entry for every
/// matching node. The caller supplies the entry shape so the game bridge can
/// report absolute paths and the editor bridge edited-scene-relative ones.
pub fn find_matching(
    start: &Gd<Node>,
    filters: &NodeFilters,
    to_entry: &mut dyn FnMut(&Gd<Node>) -> Value,
) -> Vec<Value> {
    let mut results = Vec::new();
    walk(start, filters, to_entry, &mut results);
    results
}

fn walk(
    node: &Gd<Node>,
    filters: &NodeFilters,
    to_entry: &mut dyn FnMut(&Gd<Node>) -> Value,
    results: &mut Vec<Value>,
) {
    if filters.matches(node) {
        results.push(to_entry(node));
    }
    for child in node.get_children().iter_shared() {
        walk(&child, filters, to_entry, results);
    }
}

/// Case-sensitive glob with `*` (any run) and `?` (any one character),
/// matching the semantics of Godot's `String.match` and `Node.find_children`.
pub fn glob_match(name: &str, pattern: &str) -> bool {
    let name: Vec<char> = name.chars().collect();
    let pattern: Vec<char> = pattern.chars().collect();
    // Iterative wildcard matching with backtracking over the last `*`.
    let (mut n, mut p) = (0usize, 0usize);
    let (mut star, mut star_n) = (None::<usize>, 0usize);
    while n < name.len() {
        if p < pattern.len() && (pattern[p] == '?' || pattern[p] == name[n]) {
            n += 1;
            p += 1;
        } else if p < pattern.len() && pattern[p] == '*' {
            star = Some(p);
            star_n = n;
            p += 1;
        } else if let Some(star_p) = star {
            p = star_p + 1;
            star_n += 1;
            n = star_n;
        } else {
            return false;
        }
    }
    while p < pattern.len() && pattern[p] == '*' {
        p += 1;
    }
    p == pattern.len()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn filters_require_at_least_one_criterion() {
        assert_eq!(NodeFilters::from_args(&json!({})).unwrap_err().code(), "invalid_args");
        assert!(NodeFilters::from_args(&json!({ "class": "Node2D" })).is_ok());
        assert!(NodeFilters::from_args(&json!({ "group": "enemies" })).is_ok());
        assert!(NodeFilters::from_args(&json!({ "name_pattern": "Enemy*" })).is_ok());
    }

    #[test]
    fn glob_matches_literal_star_and_question() {
        assert!(glob_match("Player", "Player"));
        assert!(!glob_match("Player", "player"));
        assert!(glob_match("Enemy3", "Enemy?"));
        assert!(!glob_match("Enemy30", "Enemy?"));
        assert!(glob_match("Enemy30", "Enemy*"));
        assert!(glob_match("Enemy", "Enemy*"));
        assert!(glob_match("MainCamera3D", "*Camera*"));
        assert!(!glob_match("MainCam", "*Camera*"));
        assert!(glob_match("anything", "*"));
        assert!(!glob_match("", "?"));
        assert!(glob_match("", "*"));
    }
}
