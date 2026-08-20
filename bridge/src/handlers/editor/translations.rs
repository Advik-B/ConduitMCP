//! Translation management (whitepaper section 8 "Scripts and resources").
//! The project's translation state is four `internationalization/locale/*`
//! project settings: the list of imported `.translation` resources, the
//! per-resource remap table, the fallback locale, and the test locale. This
//! handler reads and writes those, which is what the editor's Localization tab
//! does.
//!
//! A settings-file write like `gd_autoload` and `gd_input_map`, so not
//! undo-wrapped: `save()` persists `project.godot` synchronously, and putting
//! the change on the edited scene's history would let `gd_undo` claim to
//! revert something the history never owned.
//!
//! Extracting strings into a POT template is deliberately absent. That is
//! `EditorNode`'s own `POTGenerator`, driven from the Localization dialog,
//! with no scripted entry point (`docs/api-gaps.md`); managing the source list
//! for a button nothing can press would look like a capability and not be one.

use godot::classes::ProjectSettings;
use godot::global::Error as GdError;
use godot::prelude::*;
use serde_json::{json, Map, Value};

use crate::dispatcher::{FrameContext, HandlerOutcome};
use crate::handlers::args::{optional_str, require_str};
use crate::handlers::editor::support::validate_project_path;
use crate::protocol::BridgeError;

const TRANSLATIONS: &str = "internationalization/locale/translations";
const REMAPS: &str = "internationalization/locale/translation_remaps";
const FALLBACK: &str = "internationalization/locale/fallback";
const TEST: &str = "internationalization/locale/test";

pub fn translations(args: &Value, _ctx: &FrameContext) -> HandlerOutcome {
    HandlerOutcome::Done((|| {
        let op = require_str(args, "op")?;
        match op.as_str() {
            "list" => Ok(read_all()),
            "add" => add(args),
            "remove" => remove(args),
            "remap_add" => remap_add(args),
            "remap_remove" => remap_remove(args),
            "set_locale" => set_locale(args),
            other => Err(BridgeError::InvalidArgs(format!(
                "unknown translations op '{other}'; expected list, add, remove, remap_add, remap_remove, or set_locale"
            ))),
        }
    })())
}

fn save(settings: &mut Gd<ProjectSettings>) -> Result<(), BridgeError> {
    let save_err = settings.save();
    if save_err != GdError::OK {
        return Err(BridgeError::ResourceError(format!("failed to save project settings: {save_err:?}")));
    }
    Ok(())
}

/// A setting the project has never written is absent rather than empty, so
/// every read treats "no setting" and "empty list" as the same state.
fn read_list(settings: &Gd<ProjectSettings>, key: &str) -> Vec<String> {
    if !settings.has_setting(key) {
        return Vec::new();
    }
    settings
        .get_setting(key)
        .try_to::<PackedStringArray>()
        .map(|packed| packed.to_vec().into_iter().map(|s| s.to_string()).collect())
        .unwrap_or_default()
}

fn write_list(settings: &mut Gd<ProjectSettings>, key: &str, values: &[String]) {
    if values.is_empty() {
        // Setting NIL erases the entry, so an emptied list leaves project.godot
        // as it was before anything was registered rather than holding a stub.
        settings.set_setting(key, &Variant::nil());
        return;
    }
    let mut packed = PackedStringArray::new();
    for value in values {
        packed.push(&GString::from(value.as_str()));
    }
    settings.set_setting(key, &packed.to_variant());
}

fn read_remaps(settings: &Gd<ProjectSettings>) -> VarDictionary {
    if !settings.has_setting(REMAPS) {
        return VarDictionary::new();
    }
    settings.get_setting(REMAPS).try_to::<VarDictionary>().unwrap_or_default()
}

fn remap_entries(remaps: &VarDictionary, resource: &str) -> Vec<String> {
    remaps
        .get(&GString::from(resource))
        .and_then(|value| value.try_to::<PackedStringArray>().ok())
        .map(|packed| packed.to_vec().into_iter().map(|s| s.to_string()).collect())
        .unwrap_or_default()
}

/// A remap entry is `<variant path>:<locale>`. Split on the last colon, not the
/// first: every variant path starts `res://`, which carries one of its own.
fn split_entry(entry: &str) -> (String, Option<String>) {
    match entry.rsplit_once(':') {
        Some((variant, locale)) => (variant.to_string(), Some(locale.to_string())),
        None => (entry.to_string(), None),
    }
}

fn locale_of(entry: &str) -> Option<String> {
    split_entry(entry).1
}

fn read_all() -> Value {
    let settings = ProjectSettings::singleton();
    let remaps = read_remaps(&settings);
    let mut remap_json = Map::new();
    for (key, _) in remaps.iter_shared() {
        let resource = key.to_string();
        let entries: Vec<Value> = remap_entries(&remaps, &resource)
            .iter()
            .map(|entry| {
                let (variant, locale) = split_entry(entry);
                json!({ "variant": variant, "locale": locale })
            })
            .collect();
        remap_json.insert(resource, Value::Array(entries));
    }

    let locale = |key: &str| -> Value {
        if settings.has_setting(key) {
            json!(settings.get_setting(key).to_string())
        } else {
            Value::Null
        }
    };

    json!({
        "translations": read_list(&settings, TRANSLATIONS),
        "remaps": Value::Object(remap_json),
        "fallback": locale(FALLBACK),
        "test": locale(TEST),
    })
}

fn add(args: &Value) -> Result<Value, BridgeError> {
    let path = require_str(args, "path")?;
    validate_project_path(&path)?;

    let mut settings = ProjectSettings::singleton();
    let mut current = read_list(&settings, TRANSLATIONS);
    if current.iter().any(|entry| entry == &path) {
        return Err(BridgeError::AlreadyExists(format!("translation '{path}' is already registered")));
    }
    current.push(path.clone());
    write_list(&mut settings, TRANSLATIONS, &current);
    save(&mut settings)?;
    Ok(json!({ "path": path, "translations": current }))
}

fn remove(args: &Value) -> Result<Value, BridgeError> {
    let path = require_str(args, "path")?;

    let mut settings = ProjectSettings::singleton();
    let current = read_list(&settings, TRANSLATIONS);
    if !current.iter().any(|entry| entry == &path) {
        return Err(BridgeError::InvalidArgs(format!("no registered translation '{path}'")));
    }
    let remaining: Vec<String> = current.into_iter().filter(|entry| entry != &path).collect();
    write_list(&mut settings, TRANSLATIONS, &remaining);
    save(&mut settings)?;
    Ok(json!({ "path": path, "removed": true, "translations": remaining }))
}

fn require_locale(args: &Value, key: &str) -> Result<String, BridgeError> {
    let locale = require_str(args, key)?;
    if locale.trim().is_empty() {
        return Err(BridgeError::InvalidArgs(format!("'{key}' must be a locale code such as 'fr' or 'pt_BR'")));
    }
    Ok(locale)
}

fn remap_add(args: &Value) -> Result<Value, BridgeError> {
    let resource = require_str(args, "resource")?;
    let variant = require_str(args, "variant")?;
    let locale = require_locale(args, "locale")?;
    validate_project_path(&resource)?;
    validate_project_path(&variant)?;

    let mut settings = ProjectSettings::singleton();
    let mut remaps = read_remaps(&settings);
    let mut entries = remap_entries(&remaps, &resource);
    if entries.iter().any(|entry| locale_of(entry).as_deref() == Some(locale.as_str())) {
        return Err(BridgeError::AlreadyExists(format!(
            "'{resource}' already has a remap for locale '{locale}'; remove it first to replace it"
        )));
    }
    entries.push(format!("{variant}:{locale}"));

    let mut packed = PackedStringArray::new();
    for entry in &entries {
        packed.push(&GString::from(entry.as_str()));
    }
    remaps.set(&GString::from(resource.as_str()), &packed.to_variant());
    settings.set_setting(REMAPS, &remaps.to_variant());
    save(&mut settings)?;
    Ok(json!({ "resource": resource, "variant": variant, "locale": locale, "entries": entries }))
}

fn remap_remove(args: &Value) -> Result<Value, BridgeError> {
    let resource = require_str(args, "resource")?;
    let locale = require_locale(args, "locale")?;

    let mut settings = ProjectSettings::singleton();
    let mut remaps = read_remaps(&settings);
    let entries = remap_entries(&remaps, &resource);
    if entries.is_empty() {
        return Err(BridgeError::InvalidArgs(format!("no remaps registered for '{resource}'")));
    }
    let remaining: Vec<String> = entries
        .iter()
        .filter(|entry| locale_of(entry).as_deref() != Some(locale.as_str()))
        .cloned()
        .collect();
    if remaining.len() == entries.len() {
        return Err(BridgeError::InvalidArgs(format!("'{resource}' has no remap for locale '{locale}'")));
    }

    if remaining.is_empty() {
        // A resource whose last variant goes leaves the table, so an emptied
        // remap does not linger as an empty array in project.godot.
        remaps.remove(&GString::from(resource.as_str()));
    } else {
        let mut packed = PackedStringArray::new();
        for entry in &remaining {
            packed.push(&GString::from(entry.as_str()));
        }
        remaps.set(&GString::from(resource.as_str()), &packed.to_variant());
    }

    if remaps.is_empty() {
        settings.set_setting(REMAPS, &Variant::nil());
    } else {
        settings.set_setting(REMAPS, &remaps.to_variant());
    }
    save(&mut settings)?;
    Ok(json!({ "resource": resource, "locale": locale, "removed": true, "entries": remaining }))
}

fn set_locale(args: &Value) -> Result<Value, BridgeError> {
    let fallback = optional_str(args, "fallback");
    let test = optional_str(args, "test");
    if fallback.is_none() && test.is_none() {
        return Err(BridgeError::InvalidArgs("set_locale needs 'fallback', 'test', or both".into()));
    }
    if fallback.as_deref().is_some_and(|value| value.trim().is_empty()) {
        return Err(BridgeError::InvalidArgs("'fallback' must be a locale code such as 'en'".into()));
    }

    let mut settings = ProjectSettings::singleton();
    if let Some(value) = &fallback {
        settings.set_setting(FALLBACK, &GString::from(value.as_str()).to_variant());
    }
    // An empty test locale is the "no override" state the editor writes, so it
    // is a legal value here rather than an error.
    if let Some(value) = &test {
        settings.set_setting(TEST, &GString::from(value.as_str()).to_variant());
    }
    save(&mut settings)?;
    Ok(read_all())
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
    fn translations_requires_op_and_arguments() {
        assert_invalid_args(translations(&json!({}), &ctx()));
        assert_invalid_args(translations(&json!({ "op": "sync" }), &ctx()));
        assert_invalid_args(translations(&json!({ "op": "add" }), &ctx()));
        assert_invalid_args(translations(&json!({ "op": "remove" }), &ctx()));
        assert_invalid_args(translations(&json!({ "op": "remap_add", "resource": "res://a.png" }), &ctx()));
        assert_invalid_args(translations(&json!({ "op": "remap_remove" }), &ctx()));
    }

    #[test]
    fn paths_are_confined_to_the_project() {
        assert_invalid_args(translations(&json!({ "op": "add", "path": "/etc/passwd.translation" }), &ctx()));
        assert_invalid_args(translations(&json!({ "op": "add", "path": "res://../x.translation" }), &ctx()));
        assert_invalid_args(
            translations(&json!({ "op": "remap_add", "resource": "res://a.png", "variant": "/tmp/b.png", "locale": "fr" }), &ctx()),
        );
    }

    #[test]
    fn set_locale_needs_something_to_set() {
        assert_invalid_args(translations(&json!({ "op": "set_locale" }), &ctx()));
        assert_invalid_args(translations(&json!({ "op": "set_locale", "fallback": "  " }), &ctx()));
    }

    #[test]
    fn remap_entries_split_on_the_last_colon() {
        assert_eq!(split_entry("res://icon.fr.png:fr"), ("res://icon.fr.png".to_string(), Some("fr".to_string())));
        assert_eq!(locale_of("res://a/b.png:pt_BR"), Some("pt_BR".to_string()));
        assert_eq!(locale_of("malformed"), None);
    }

    #[test]
    fn a_blank_locale_is_rejected_before_any_engine_call() {
        assert_invalid_args(
            translations(&json!({ "op": "remap_add", "resource": "res://a.png", "variant": "res://b.png", "locale": " " }), &ctx()),
        );
    }
}
