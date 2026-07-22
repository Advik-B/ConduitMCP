//! Editor status surface: the toolbar indicator and the Conduit bottom panel
//! (whitepaper section 6.10).
//!
//! Both classes are dumb views. The plugin polls `BridgeCore` once per frame
//! on the main thread and pushes changes in via `bind_mut`, so nothing here
//! touches transport state or runs off the main thread.

use godot::classes::control::{CursorShape, SizeFlags};
use godot::classes::{
    Control, HBoxContainer, IControl, IVBoxContainer, InputEvent, InputEventMouseButton, Label,
    Time, Tree, VBoxContainer,
};
use godot::global::MouseButton;
use godot::prelude::*;

use crate::history::{ToolHistory, HISTORY_CAPACITY};
use crate::transport::status::LinkState;

const INDICATOR_SIZE: f32 = 16.0;
const DOT_RADIUS: f32 = 4.5;

// Hardcoded rather than theme-derived so the dot reads the same on both
// editor themes without guarded theme lookups.
const COLOR_CONNECTED: Color = Color::from_rgb(0.35, 0.75, 0.35);
const COLOR_LISTENING: Color = Color::from_rgb(0.5, 0.5, 0.5);
const COLOR_INACTIVE: Color = Color::from_rgb(0.8, 0.3, 0.3);
const COLOR_ERROR_TEXT: Color = Color::from_rgb(0.9, 0.45, 0.45);

fn dot_color(state: LinkState) -> Color {
    match state {
        LinkState::Connected => COLOR_CONNECTED,
        LinkState::Listening => COLOR_LISTENING,
        LinkState::Inactive => COLOR_INACTIVE,
    }
}

/// The always-visible toolbar dot. Emits `pressed` on left click; the plugin
/// connects that to opening the bottom panel.
#[derive(GodotClass)]
#[class(tool, base=Control)]
pub struct ConduitStatusIndicator {
    base: Base<Control>,
    state: LinkState,
}

#[godot_api]
impl IControl for ConduitStatusIndicator {
    fn init(base: Base<Control>) -> Self {
        ConduitStatusIndicator { base, state: LinkState::Inactive }
    }

    fn ready(&mut self) {
        self.base_mut().set_default_cursor_shape(CursorShape::POINTING_HAND);
    }

    fn get_minimum_size(&self) -> Vector2 {
        Vector2::new(INDICATOR_SIZE, INDICATOR_SIZE)
    }

    fn draw(&mut self) {
        let center = self.base().get_size() * 0.5;
        let color = dot_color(self.state);
        self.base_mut().draw_circle(center, DOT_RADIUS, color);
    }

    fn gui_input(&mut self, event: Gd<InputEvent>) {
        let Ok(mouse) = event.try_cast::<InputEventMouseButton>() else {
            return;
        };
        if mouse.get_button_index() == MouseButton::LEFT && mouse.is_pressed() {
            self.base_mut().emit_signal("pressed", &[]);
        }
    }
}

#[godot_api]
impl ConduitStatusIndicator {
    #[signal]
    fn pressed();
}

impl ConduitStatusIndicator {
    /// Called by the plugin only when the link snapshot changed.
    pub fn set_state(&mut self, state: LinkState, tooltip: &str) {
        self.base_mut().set_tooltip_text(tooltip);
        if state != self.state {
            self.state = state;
            self.base_mut().queue_redraw();
        }
    }
}

/// The Conduit bottom panel: a status header over the tool-call history list.
#[derive(GodotClass)]
#[class(tool, base=VBoxContainer)]
pub struct ConduitPanel {
    base: Base<VBoxContainer>,
    status_label: Option<Gd<Label>>,
    endpoint_label: Option<Gd<Label>>,
    stats_label: Option<Gd<Label>>,
    history_tree: Option<Gd<Tree>>,
    /// Highest history seq already rendered; rows only ever append.
    cursor: u64,
    rows: usize,
}

#[godot_api]
impl IVBoxContainer for ConduitPanel {
    fn init(base: Base<VBoxContainer>) -> Self {
        ConduitPanel {
            base,
            status_label: None,
            endpoint_label: None,
            stats_label: None,
            history_tree: None,
            cursor: 0,
            rows: 0,
        }
    }

    fn ready(&mut self) {
        self.build_ui();
    }
}

impl ConduitPanel {
    fn build_ui(&mut self) {
        self.base_mut().set_custom_minimum_size(Vector2::new(0.0, 180.0));

        let mut header = HBoxContainer::new_alloc();
        header.add_theme_constant_override("separation", 24);
        let mut status_label = Label::new_alloc();
        status_label.set_text("Status: inactive");
        header.add_child(&status_label);
        let endpoint_label = Label::new_alloc();
        header.add_child(&endpoint_label);
        let stats_label = Label::new_alloc();
        header.add_child(&stats_label);
        self.base_mut().add_child(&header);

        let mut tree = Tree::new_alloc();
        tree.set_columns(4);
        tree.set_column_titles_visible(true);
        tree.set_column_title(0, "Time");
        tree.set_column_title(1, "Tool");
        tree.set_column_title(2, "Status");
        tree.set_column_title(3, "Duration");
        tree.set_column_expand(0, false);
        tree.set_column_custom_minimum_width(0, 90);
        tree.set_column_expand(1, true);
        tree.set_column_expand(2, false);
        tree.set_column_custom_minimum_width(2, 110);
        tree.set_column_expand(3, false);
        tree.set_column_custom_minimum_width(3, 80);
        tree.set_hide_root(true);
        tree.create_item();
        tree.set_h_size_flags(SizeFlags::EXPAND_FILL);
        tree.set_v_size_flags(SizeFlags::EXPAND_FILL);
        self.base_mut().add_child(&tree);

        self.status_label = Some(status_label);
        self.endpoint_label = Some(endpoint_label);
        self.stats_label = Some(stats_label);
        self.history_tree = Some(tree);
    }

    /// Refresh the header labels. Called on link changes and on a coarse timer.
    pub fn set_header(
        &mut self,
        state: LinkState,
        endpoint: Option<&str>,
        bind_failed: bool,
        uptime: Option<std::time::Duration>,
        completed_calls: u64,
        in_flight: usize,
    ) {
        let status = match state {
            LinkState::Connected => match uptime {
                Some(uptime) => format!("Status: connected ({})", format_uptime(uptime)),
                None => "Status: connected".to_string(),
            },
            LinkState::Listening => "Status: waiting for broker".to_string(),
            LinkState::Inactive if bind_failed => "Status: inactive (bind failed)".to_string(),
            LinkState::Inactive => "Status: inactive (not activated)".to_string(),
        };
        if let Some(label) = self.status_label.as_mut() {
            label.set_text(&status);
        }
        if let Some(label) = self.endpoint_label.as_mut() {
            label.set_text(endpoint.unwrap_or(""));
        }
        if let Some(label) = self.stats_label.as_mut() {
            let stats = if in_flight > 0 {
                format!("{completed_calls} calls, {in_flight} in flight")
            } else {
                format!("{completed_calls} calls")
            };
            label.set_text(&stats);
        }
    }

    /// Render history records newer than the cursor. Rows append incrementally
    /// while under the ring capacity; once trimming would be needed the whole
    /// tree is rebuilt from the ring instead, because `Tree::clear` frees every
    /// item engine-side and so avoids manual `TreeItem` lifetime management
    /// entirely. A rebuild is at most `HISTORY_CAPACITY` rows, cheap at the
    /// rate tool calls complete.
    pub fn append_history(&mut self, history: &ToolHistory) {
        if history.latest_seq() <= self.cursor {
            return;
        }
        let Some(mut tree) = self.history_tree.clone() else {
            return;
        };
        // Timezone bias in minutes, read once per batch.
        let bias_minutes = Time::singleton()
            .get_time_zone_from_system()
            .get("bias")
            .and_then(|value| value.try_to::<i64>().ok())
            .unwrap_or(0);

        let fresh = history.records_since(self.cursor).count();
        if self.rows + fresh > HISTORY_CAPACITY {
            tree.clear();
            tree.create_item();
            self.rows = 0;
            self.cursor = 0;
        }

        let mut last_item = None;
        for record in history.records_since(self.cursor) {
            // With a root present, parentless create_item appends under it.
            let Some(mut item) = tree.create_item() else {
                continue;
            };
            item.set_text(0, &format_row_time(record.started_unix_ms, bias_minutes));
            item.set_text(1, &record.tool);
            match &record.error_code {
                None => item.set_text(2, "ok"),
                Some(code) => {
                    item.set_text(2, code);
                    item.set_custom_color(2, COLOR_ERROR_TEXT);
                    item.set_tooltip_text(2, code);
                }
            }
            item.set_text(3, &format!("{} ms", record.duration.as_millis()));
            self.cursor = record.seq;
            self.rows += 1;
            last_item = Some(item);
        }

        if let Some(item) = last_item {
            tree.scroll_to_item(&item);
        }
    }
}

fn format_row_time(unix_ms: u64, bias_minutes: i64) -> GString {
    let local_seconds = unix_ms as i64 / 1000 + bias_minutes * 60;
    Time::singleton().get_time_string_from_unix_time(local_seconds)
}

fn format_uptime(uptime: std::time::Duration) -> String {
    let total = uptime.as_secs();
    if total >= 3600 {
        format!("up {}h {}m", total / 3600, (total % 3600) / 60)
    } else if total >= 60 {
        format!("up {}m {}s", total / 60, total % 60)
    } else {
        format!("up {total}s")
    }
}
