//! Argument-parsing helpers with no engine dependency, shared by every
//! handler (runtime and editor). Kept engine-free so they stay unit-testable
//! under plain `cargo test` (see `docs/api-gaps.md`).

use serde_json::Value;

use crate::protocol::BridgeError;

pub fn require_str(args: &Value, key: &str) -> Result<String, BridgeError> {
    args.get(key)
        .and_then(Value::as_str)
        .map(str::to_string)
        .ok_or_else(|| BridgeError::InvalidArgs(format!("'{key}' is required and must be a string")))
}

pub fn optional_str(args: &Value, key: &str) -> Option<String> {
    args.get(key).and_then(Value::as_str).map(str::to_string)
}

pub fn optional_u64(args: &Value, key: &str) -> Option<u64> {
    args.get(key).and_then(Value::as_u64)
}

pub fn optional_bool(args: &Value, key: &str) -> Option<bool> {
    args.get(key).and_then(Value::as_bool)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn require_str_extracts_and_reports() {
        let args = json!({ "name": "Player" });
        assert_eq!(require_str(&args, "name").unwrap(), "Player");
        let missing = require_str(&args, "path").unwrap_err();
        assert_eq!(missing.code(), "invalid_args");
    }

    #[test]
    fn optional_helpers_return_none_when_absent() {
        let args = json!({ "frames": 3, "paused": true });
        assert_eq!(optional_str(&args, "name"), None);
        assert_eq!(optional_u64(&args, "frames"), Some(3));
        assert_eq!(optional_bool(&args, "paused"), Some(true));
        assert_eq!(optional_bool(&args, "missing"), None);
    }
}
