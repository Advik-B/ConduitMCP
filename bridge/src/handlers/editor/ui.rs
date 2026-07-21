//! Tier-2 editor control-tree tools (whitepaper section 6.8): observing and
//! dismissing modal dialogs, and a consolidated tool for finding, describing, and
//! driving the editor's own `Control` nodes when no semantic API exists. These
//! are resolution- and theme-independent because they act on objects, not pixels.
//! They are fragile only to editor UI refactors between Godot versions, a far
//! slower drift than pixel positions.

use godot::classes::{
    AcceptDialog, Button, ConfirmationDialog, Control, ItemList, LineEdit, Node, OptionButton, PopupMenu, TextEdit, Tree,
    Window,
};
use godot::prelude::*;
use serde_json::{json, Value};

use crate::dispatcher::{FrameContext, HandlerOutcome};
use crate::handlers::args::{optional_str, optional_u64, require_str};
use crate::protocol::BridgeError;

const DEFAULT_FIND_LIMIT: usize = 50;

/// The editor's root window, the search root for both dialogs and controls.
fn root_window() -> Result<Gd<Window>, BridgeError> {
    let base = godot::classes::EditorInterface::singleton()
        .get_base_control()
        .ok_or_else(|| BridgeError::Internal("editor has no base control".into()))?;
    base.get_tree()
        .get_root()
        .ok_or_else(|| BridgeError::Internal("editor has no root window".into()))
}

/// Enumerate currently visible dialogs so an unattended agent can see and dismiss
/// a modal that would otherwise stall the session.
pub fn list_dialogs(_args: &Value, _ctx: &FrameContext) -> HandlerOutcome {
    HandlerOutcome::Done(list_dialogs_inner())
}

fn list_dialogs_inner() -> Result<Value, BridgeError> {
    let root = root_window()?;
    let dialogs = root.find_children_ex("*").type_("AcceptDialog").recursive(true).owned(false).done();
    let mut visible = Vec::new();
    for (index, node) in dialogs.iter_shared().enumerate() {
        let dialog: Gd<AcceptDialog> = node.cast();
        if !dialog.is_visible() {
            continue;
        }
        visible.push(json!({
            "index": index,
            "class": dialog.get_class().to_string(),
            "title": dialog.get_title().to_string(),
            "text": dialog.get_text().to_string(),
            "buttons": dialog_buttons(&dialog),
        }));
    }
    Ok(json!({ "dialogs": visible }))
}

/// The labels of every button on a dialog: the ok button, the cancel button on a
/// ConfirmationDialog, and any custom buttons, all of which share the ok button's
/// parent container.
fn dialog_buttons(dialog: &Gd<AcceptDialog>) -> Vec<String> {
    let mut labels = Vec::new();
    if let Some(ok) = dialog.get_ok_button()
        && let Some(parent) = ok.get_parent()
    {
        for child in parent.get_children().iter_shared() {
            if let Ok(button) = child.try_cast::<Button>() {
                labels.push(button.get_text().to_string());
            }
        }
    }
    if labels.is_empty()
        && let Ok(confirm) = dialog.clone().try_cast::<ConfirmationDialog>()
        && let Some(cancel) = confirm.get_cancel_button()
    {
        labels.push(cancel.get_text().to_string());
    }
    labels
}

/// Press a named button on a visible dialog, selected by title or index.
pub fn dialog_choose(args: &Value, _ctx: &FrameContext) -> HandlerOutcome {
    HandlerOutcome::Done(dialog_choose_inner(args))
}

fn dialog_choose_inner(args: &Value) -> Result<Value, BridgeError> {
    let button_label = require_str(args, "button")?;
    let title = optional_str(args, "title");
    let index = optional_u64(args, "index").map(|value| value as usize);

    let root = root_window()?;
    let dialogs = root.find_children_ex("*").type_("AcceptDialog").recursive(true).owned(false).done();
    let visible: Vec<Gd<AcceptDialog>> = dialogs
        .iter_shared()
        .map(|node| node.cast::<AcceptDialog>())
        .filter(|dialog| dialog.is_visible())
        .collect();

    if visible.is_empty() {
        return Err(BridgeError::NodeNotFound("no dialog is currently visible".into()));
    }

    let dialog = if let Some(title) = &title {
        visible
            .iter()
            .find(|d| d.get_title().to_string().eq_ignore_ascii_case(title))
            .cloned()
            .ok_or_else(|| {
                let titles: Vec<String> = visible.iter().map(|d| d.get_title().to_string()).collect();
                BridgeError::NodeNotFound(format!("no visible dialog titled '{title}'; visible dialogs: {titles:?}"))
            })?
    } else if let Some(index) = index {
        visible
            .get(index)
            .cloned()
            .ok_or_else(|| BridgeError::NodeNotFound(format!("no visible dialog at index {index}")))?
    } else {
        visible[0].clone()
    };

    let button = find_dialog_button(&dialog, &button_label).ok_or_else(|| {
        BridgeError::NodeNotFound(format!(
            "dialog '{}' has no button labelled '{button_label}'; buttons: {:?}",
            dialog.get_title(),
            dialog_buttons(&dialog)
        ))
    })?;

    // Emitting the button's own pressed signal drives the dialog's accept, cancel,
    // or custom-action wiring exactly as a click would, without pixel input.
    button.clone().emit_signal("pressed", &[]);
    Ok(json!({ "pressed": button_label, "dialog": dialog.get_title().to_string() }))
}

fn find_dialog_button(dialog: &Gd<AcceptDialog>, label: &str) -> Option<Gd<Button>> {
    let ok = dialog.get_ok_button()?;
    let parent = ok.get_parent()?;
    for child in parent.get_children().iter_shared() {
        if let Ok(button) = child.try_cast::<Button>()
            && button.get_text().to_string().eq_ignore_ascii_case(label)
        {
            return Some(button);
        }
    }
    None
}

/// The consolidated tier-2 control tool (op: find, describe, click, set_text,
/// set_toggle, select_item).
pub fn editor_ui(args: &Value, _ctx: &FrameContext) -> HandlerOutcome {
    HandlerOutcome::Done(editor_ui_inner(args))
}

fn editor_ui_inner(args: &Value) -> Result<Value, BridgeError> {
    let op = require_str(args, "op")?;
    match op.as_str() {
        "find" => find_controls(args),
        "describe" => describe_control(args),
        "click" => click_control(args),
        "set_text" => set_text_control(args),
        "set_toggle" => set_toggle_control(args),
        "select_item" => select_item_control(args),
        other => Err(BridgeError::InvalidArgs(format!(
            "unknown editor_ui op '{other}'; expected find, describe, click, set_text, set_toggle, or select_item"
        ))),
    }
}

/// The search root: an explicit control path, else the editor base control.
fn ui_root(args: &Value) -> Result<Gd<Node>, BridgeError> {
    match optional_str(args, "root") {
        Some(path) => resolve_control(&path),
        None => godot::classes::EditorInterface::singleton()
            .get_base_control()
            .map(|c| c.upcast())
            .ok_or_else(|| BridgeError::Internal("editor has no base control".into())),
    }
}

/// Resolve a control by the absolute path this tool reports, anchored at the root
/// window so paths round-trip back into later calls.
fn resolve_control(path: &str) -> Result<Gd<Node>, BridgeError> {
    let root = root_window()?;
    root.get_node_or_null(path)
        .ok_or_else(|| BridgeError::NodeNotFound(format!("no control at editor path '{path}'")))
}

fn control_path(node: &Gd<Node>) -> String {
    node.get_path().to_string()
}

fn find_controls(args: &Value) -> Result<Value, BridgeError> {
    let pattern = optional_str(args, "pattern").map(|p| p.to_lowercase());
    let class = optional_str(args, "class");
    let limit = optional_u64(args, "limit").map(|value| value as usize).unwrap_or(DEFAULT_FIND_LIMIT).max(1);
    let offset = optional_u64(args, "offset").map(|value| value as usize).unwrap_or(0);

    let root = ui_root(args)?;
    let mut matches = Vec::new();
    collect_controls(&root, pattern.as_deref(), class.as_deref(), &mut matches);

    let total = matches.len();
    let page: Vec<Value> = matches.into_iter().skip(offset).take(limit).collect();
    let next_offset = offset + page.len();
    Ok(json!({
        "controls": page,
        "total_count": total,
        "has_more": next_offset < total,
        "next_offset": next_offset,
    }))
}

fn collect_controls(node: &Gd<Node>, pattern: Option<&str>, class: Option<&str>, out: &mut Vec<Value>) {
    let name = node.get_name().to_string();
    let name_matches = pattern.is_none_or(|p| name.to_lowercase().contains(p));
    let class_matches = class.is_none_or(|c| node.is_class(c));
    if name_matches && class_matches {
        out.push(control_summary(node));
    }
    for child in node.get_children().iter_shared() {
        collect_controls(&child, pattern, class, out);
    }
}

fn control_summary(node: &Gd<Node>) -> Value {
    let mut entry = json!({
        "path": control_path(node),
        "name": node.get_name().to_string(),
        "class": node.get_class().to_string(),
    });
    if let Ok(control) = node.clone().try_cast::<Control>() {
        entry["visible"] = json!(control.is_visible());
        let rect = control.get_global_rect();
        entry["rect"] = json!({
            "x": rect.position.x,
            "y": rect.position.y,
            "width": rect.size.x,
            "height": rect.size.y,
        });
    }
    if let Some(text) = node_text(node) {
        entry["text"] = json!(text);
    }
    entry
}

/// The display text of a control, where it has one.
fn node_text(node: &Gd<Node>) -> Option<String> {
    if let Ok(button) = node.clone().try_cast::<Button>() {
        return Some(button.get_text().to_string());
    }
    if let Ok(line) = node.clone().try_cast::<LineEdit>() {
        return Some(line.get_text().to_string());
    }
    if let Ok(label) = node.clone().try_cast::<godot::classes::Label>() {
        return Some(label.get_text().to_string());
    }
    None
}

fn describe_control(args: &Value) -> Result<Value, BridgeError> {
    let path = require_str(args, "path")?;
    let node = resolve_control(&path)?;
    let mut entry = control_summary(&node);

    if let Ok(control) = node.clone().try_cast::<Control>() {
        entry["tooltip"] = json!(control.get_tooltip_text().to_string());
    }
    if let Ok(button) = node.clone().try_cast::<godot::classes::BaseButton>() {
        entry["toggle_mode"] = json!(button.is_toggle_mode());
        entry["pressed"] = json!(button.is_pressed());
    }
    if let Ok(popup) = node.clone().try_cast::<PopupMenu>() {
        entry["items"] = popup_items(&popup);
    }
    if let Ok(option) = node.clone().try_cast::<OptionButton>() {
        entry["items"] = option_items(&option);
    }
    if let Ok(list) = node.clone().try_cast::<ItemList>() {
        entry["items"] = item_list_items(&list);
    }
    if let Ok(tree) = node.clone().try_cast::<Tree>() {
        entry["columns"] = json!(tree.get_columns());
    }
    Ok(entry)
}

fn popup_items(popup: &Gd<PopupMenu>) -> Value {
    let count = popup.get_item_count();
    let items: Vec<Value> = (0..count)
        .map(|index| {
            json!({
                "index": index,
                "id": popup.get_item_id(index),
                "text": popup.get_item_text(index).to_string(),
                "disabled": popup.is_item_disabled(index),
            })
        })
        .collect();
    Value::Array(items)
}

fn option_items(option: &Gd<OptionButton>) -> Value {
    let count = option.get_item_count();
    let items: Vec<Value> = (0..count)
        .map(|index| json!({ "index": index, "id": option.get_item_id(index), "text": option.get_item_text(index).to_string() }))
        .collect();
    Value::Array(items)
}

fn item_list_items(list: &Gd<ItemList>) -> Value {
    let count = list.get_item_count();
    let items: Vec<Value> =
        (0..count).map(|index| json!({ "index": index, "text": list.get_item_text(index).to_string() })).collect();
    Value::Array(items)
}

fn click_control(args: &Value) -> Result<Value, BridgeError> {
    let path = require_str(args, "path")?;
    let node = resolve_control(&path)?;
    if node.is_class("MenuButton") {
        return Err(BridgeError::InvalidArgs(
            "a MenuButton opens a PopupMenu; use editor_ui op select_item on its PopupMenu instead".into(),
        ));
    }
    let mut button = node
        .try_cast::<godot::classes::BaseButton>()
        .map_err(|_| BridgeError::InvalidArgs(format!("control at '{path}' is not a button")))?;
    if button.is_toggle_mode() {
        let next = !button.is_pressed();
        button.set_pressed(next);
        return Ok(json!({ "clicked": path, "toggled_to": next }));
    }
    button.emit_signal("pressed", &[]);
    Ok(json!({ "clicked": path }))
}

fn set_text_control(args: &Value) -> Result<Value, BridgeError> {
    let path = require_str(args, "path")?;
    let text = require_str(args, "text")?;
    let submit = args.get("submit").and_then(Value::as_bool).unwrap_or(false);
    let node = resolve_control(&path)?;

    if let Ok(mut line) = node.clone().try_cast::<LineEdit>() {
        line.set_text(&text);
        line.emit_signal("text_changed", &[text.to_variant()]);
        if submit {
            line.emit_signal("text_submitted", &[text.to_variant()]);
        }
        return Ok(json!({ "set_text": path, "text": text, "submitted": submit }));
    }
    if let Ok(mut edit) = node.clone().try_cast::<TextEdit>() {
        edit.set_text(&text);
        edit.emit_signal("text_changed", &[]);
        return Ok(json!({ "set_text": path, "text": text }));
    }
    Err(BridgeError::InvalidArgs(format!("control at '{path}' is not a LineEdit or TextEdit")))
}

fn set_toggle_control(args: &Value) -> Result<Value, BridgeError> {
    let path = require_str(args, "path")?;
    let pressed = args
        .get("pressed")
        .and_then(Value::as_bool)
        .ok_or_else(|| BridgeError::InvalidArgs("'pressed' (bool) is required for set_toggle".into()))?;
    let node = resolve_control(&path)?;
    let mut button = node
        .try_cast::<godot::classes::BaseButton>()
        .map_err(|_| BridgeError::InvalidArgs(format!("control at '{path}' is not a button")))?;
    button.set_pressed(pressed);
    Ok(json!({ "set_toggle": path, "pressed": pressed }))
}

fn select_item_control(args: &Value) -> Result<Value, BridgeError> {
    let path = require_str(args, "path")?;
    let node = resolve_control(&path)?;
    let index = optional_u64(args, "index").map(|value| value as i32);
    let id = optional_u64(args, "id").map(|value| value as i32);
    let text = optional_str(args, "text");

    if let Ok(mut popup) = node.clone().try_cast::<PopupMenu>() {
        let target_id = resolve_popup_id(&popup, index, id, text.as_deref())?;
        // Emit id_pressed directly: the no-popup activation path the editor's own
        // menus connect to, so the menu action runs without showing the popup.
        popup.emit_signal("id_pressed", &[target_id.to_variant()]);
        return Ok(json!({ "select_item": path, "id": target_id }));
    }
    if let Ok(mut option) = node.clone().try_cast::<OptionButton>() {
        let idx = resolve_index(option.get_item_count(), index, |i| option.get_item_text(i).to_string(), text.as_deref())?;
        option.select(idx);
        option.emit_signal("item_selected", &[idx.to_variant()]);
        return Ok(json!({ "select_item": path, "index": idx }));
    }
    if let Ok(mut list) = node.clone().try_cast::<ItemList>() {
        let idx = resolve_index(list.get_item_count(), index, |i| list.get_item_text(i).to_string(), text.as_deref())?;
        list.select(idx);
        list.emit_signal("item_selected", &[idx.to_variant()]);
        return Ok(json!({ "select_item": path, "index": idx }));
    }
    if let Ok(mut tree) = node.clone().try_cast::<Tree>() {
        let root = tree.get_root().ok_or_else(|| BridgeError::InvalidArgs("tree has no items".into()))?;
        let want = index.unwrap_or(0).max(0) as usize;
        let mut item = root.get_child(0);
        let mut i = 0usize;
        while let Some(current) = item {
            if i == want {
                tree.set_selected(&current, 0);
                tree.emit_signal("cell_selected", &[]);
                return Ok(json!({ "select_item": path, "index": want }));
            }
            i += 1;
            item = current.get_next();
        }
        return Err(BridgeError::InvalidArgs(format!("tree has no item at index {want}")));
    }
    Err(BridgeError::InvalidArgs(format!("control at '{path}' is not a selectable list, option, tree, or menu")))
}

fn resolve_popup_id(popup: &Gd<PopupMenu>, index: Option<i32>, id: Option<i32>, text: Option<&str>) -> Result<i32, BridgeError> {
    if let Some(id) = id {
        return Ok(id);
    }
    let count = popup.get_item_count();
    if let Some(index) = index {
        if index < 0 || index >= count {
            return Err(BridgeError::InvalidArgs(format!("popup index {index} out of range 0..{count}")));
        }
        return Ok(popup.get_item_id(index));
    }
    if let Some(text) = text {
        for i in 0..count {
            if popup.get_item_text(i).to_string().eq_ignore_ascii_case(text) {
                return Ok(popup.get_item_id(i));
            }
        }
        return Err(BridgeError::InvalidArgs(format!("popup has no item matching '{text}'")));
    }
    Err(BridgeError::InvalidArgs("select_item on a PopupMenu needs one of id, index, or text".into()))
}

fn resolve_index(
    count: i32,
    index: Option<i32>,
    text_at: impl Fn(i32) -> String,
    text: Option<&str>,
) -> Result<i32, BridgeError> {
    if let Some(index) = index {
        if index < 0 || index >= count {
            return Err(BridgeError::InvalidArgs(format!("index {index} out of range 0..{count}")));
        }
        return Ok(index);
    }
    if let Some(text) = text {
        for i in 0..count {
            if text_at(i).eq_ignore_ascii_case(text) {
                return Ok(i);
            }
        }
        return Err(BridgeError::InvalidArgs(format!("no item matching '{text}'")));
    }
    Err(BridgeError::InvalidArgs("select_item needs one of index or text".into()))
}
