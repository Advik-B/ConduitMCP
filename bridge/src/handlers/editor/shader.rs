//! Shader validation (whitepaper section 8, "Shader creation gets the same
//! log-derived compile diagnostics"). Separate from `script.rs` because the
//! forcing mechanism and the diagnostic format are both different, even though
//! the subprocess machinery is shaped the same way.
//!
//! Three facts settled empirically against Godot 4.7.1 before this was written
//! (`docs/api-gaps.md`), because none of them is guessable:
//!
//! 1. The headless dummy renderer *does* compile Godot-language shaders. Its
//!    `shader_set_code` runs the real `ShaderLanguage` compiler and prints
//!    `SHADER ERROR:` with a line number, so no rendering context, display, or
//!    window is needed. This is why there is no `NotAvailableHeadless` path.
//! 2. Loading the resource is not enough. `ResourceLoader.load` on a broken
//!    shader reports nothing at all; `Shader.get_shader_uniform_list()` is what
//!    forces the compile, so the driver script below must call it.
//! 3. `--script` accepts an absolute path outside the project, so the driver
//!    lives in the OS temp directory and the user's project is never written to.
//!
//! Why a subprocess rather than compiling in this process: the editor's own log
//! writer does not make just-emitted diagnostics visible to a reader inside the
//! same process on any bounded wait (`docs/api-gaps.md`, the finding that moved
//! `gd_script_validate` off `log_tail`). A child's output is complete once it
//! has exited, which `try_wait` reports, and that is a fact about the OS rather
//! than about flush timing.

use std::process::{Child, Command, Stdio};

use godot::classes::{Os, ProjectSettings};
use godot::prelude::*;
use serde_json::{json, Value};

use crate::dispatcher::{FrameContext, HandlerOutcome, PendingOp};
use crate::handlers::args::require_str;
use crate::handlers::editor::support::validate_project_path;
use crate::protocol::BridgeError;

const VALIDATE_OUTPUT_MAX_BYTES: usize = 64 * 1024;

/// Bracket the compile so engine startup noise and the GDExtension's own lines
/// are never mistaken for shader diagnostics.
const BEGIN_MARKER: &str = "CONDUIT_SHADER_BEGIN";
const MISSING_MARKER: &str = "CONDUIT_SHADER_MISSING";
const NOT_A_SHADER_MARKER: &str = "CONDUIT_SHADER_NOT_A_SHADER";

/// Runs in the child. Deliberately does nothing but force the compile: the
/// verdict is read from what the engine prints, not from anything this returns,
/// because a compile failure is not observable from GDScript.
const DRIVER_SOURCE: &str = r#"extends SceneTree

func _initialize() -> void:
	var args := OS.get_cmdline_user_args()
	if args.is_empty():
		quit(2)
		return
	var path: String = args[0]
	if not ResourceLoader.exists(path):
		print("CONDUIT_SHADER_MISSING")
		quit(3)
		return
	var res: Resource = ResourceLoader.load(path)
	var shader: Shader = res as Shader
	if shader == null:
		print("CONDUIT_SHADER_NOT_A_SHADER")
		quit(4)
		return
	print("CONDUIT_SHADER_BEGIN")
	shader.get_shader_uniform_list()
	print("CONDUIT_SHADER_END")
	quit(0)

func _process(_delta: float) -> bool:
	return true
"#;

pub fn validate(args: &Value, _ctx: &FrameContext) -> HandlerOutcome {
    let path = match require_str(args, "path") {
        Ok(v) => v,
        Err(e) => return HandlerOutcome::Done(Err(e)),
    };
    if let Err(e) = validate_project_path(&path) {
        return HandlerOutcome::Done(Err(e));
    }
    if let Err(e) = validate_shader_extension(&path) {
        return HandlerOutcome::Done(Err(e));
    }

    let godot_bin = Os::singleton().get_executable_path().to_string();
    let project_path = ProjectSettings::singleton().globalize_path("res://").to_string();
    let (driver_path, output_path) = scratch_paths();

    if let Err(e) = std::fs::write(&driver_path, DRIVER_SOURCE) {
        return HandlerOutcome::Done(Err(BridgeError::Internal(format!(
            "failed to write the shader validation driver script: {e}"
        ))));
    }

    let output_file = match std::fs::File::create(&output_path) {
        Ok(f) => f,
        Err(e) => {
            let _ = std::fs::remove_file(&driver_path);
            return HandlerOutcome::Done(Err(BridgeError::Internal(format!(
                "failed to create scratch file for shader validation: {e}"
            ))));
        }
    };
    let stderr_file = match output_file.try_clone() {
        Ok(f) => f,
        Err(e) => {
            let _ = std::fs::remove_file(&driver_path);
            let _ = std::fs::remove_file(&output_path);
            return HandlerOutcome::Done(Err(BridgeError::Internal(format!(
                "failed to prepare scratch file for shader validation: {e}"
            ))));
        }
    };

    let mut command = Command::new(&godot_bin);
    command
        .args([
            "--headless",
            "--path",
            project_path.as_str(),
            "--script",
            driver_path.to_string_lossy().as_ref(),
            "--",
            path.as_str(),
        ])
        // Same reason as gd_script_validate: the child loads this project's
        // GDExtension too, and must never try to bind a bridge socket of its own.
        .env_remove("CONDUIT_ENABLE")
        .env_remove("CONDUIT_SOCK")
        .env_remove("CONDUIT_RUNTIME_DIR")
        .stdin(Stdio::null())
        .stdout(Stdio::from(output_file))
        .stderr(Stdio::from(stderr_file));

    let child = match command.spawn() {
        Ok(c) => c,
        Err(e) => {
            let _ = std::fs::remove_file(&driver_path);
            let _ = std::fs::remove_file(&output_path);
            return HandlerOutcome::Done(Err(BridgeError::Internal(format!(
                "failed to spawn godot for shader validation: {e}"
            ))));
        }
    };

    HandlerOutcome::Pending(Box::new(ShaderCheckPending { path, child, driver_path, output_path }))
}

fn validate_shader_extension(path: &str) -> Result<(), BridgeError> {
    if path.to_ascii_lowercase().ends_with(".gdshader") {
        return Ok(());
    }
    // .gdshaderinc is deliberately rejected: an include fragment has no
    // shader_type and cannot compile on its own, so validating one would report
    // a missing declaration that is not a defect.
    Err(BridgeError::InvalidArgs(format!(
        "path '{path}' must name a .gdshader file; include fragments and other resources cannot be compiled on their own"
    )))
}

fn scratch_paths() -> (std::path::PathBuf, std::path::PathBuf) {
    use std::sync::atomic::{AtomicU64, Ordering};
    static COUNTER: AtomicU64 = AtomicU64::new(0);
    let n = COUNTER.fetch_add(1, Ordering::Relaxed);
    let dir = std::env::temp_dir();
    let stem = format!("conduit-shader-check-{}-{n}", std::process::id());
    (dir.join(format!("{stem}.gd")), dir.join(format!("{stem}.log")))
}

struct ShaderCheckPending {
    path: String,
    child: Child,
    driver_path: std::path::PathBuf,
    output_path: std::path::PathBuf,
}

impl ShaderCheckPending {
    fn cleanup(&self) {
        // No .uid sidecar to remove: Godot writes those through
        // EditorFileSystem, which a --script run does not have, and a driver
        // outside the project would not get one anyway (measured, not assumed).
        let _ = std::fs::remove_file(&self.driver_path);
        let _ = std::fs::remove_file(&self.output_path);
    }
}

impl PendingOp for ShaderCheckPending {
    fn poll(&mut self, _ctx: &FrameContext) -> Option<Result<Value, BridgeError>> {
        let status = match self.child.try_wait() {
            Ok(Some(status)) => status,
            Ok(None) => return None,
            Err(e) => {
                self.cleanup();
                return Some(Err(BridgeError::Internal(format!(
                    "failed to wait for shader validation subprocess: {e}"
                ))));
            }
        };

        let mut bytes = std::fs::read(&self.output_path).unwrap_or_default();
        self.cleanup();
        if bytes.len() > VALIDATE_OUTPUT_MAX_BYTES {
            bytes.drain(0..bytes.len() - VALIDATE_OUTPUT_MAX_BYTES);
        }
        let text = String::from_utf8_lossy(&bytes);
        let exit_code = status.code();

        Some(interpret(&text, &self.path, exit_code))
    }
}

/// The verdict, read from the child's output rather than its exit status. The
/// child exits 0 whether or not the shader compiled -- a compile failure is not
/// observable from GDScript, so it cannot set a code -- which makes the output
/// the only signal. That matches the lesson `gd_script_validate` learned when
/// `--check-only` turned out to exit 0 on a parse error on macOS.
fn interpret(text: &str, path: &str, exit_code: Option<i32>) -> Result<Value, BridgeError> {
    if text.contains(MISSING_MARKER) {
        return Err(BridgeError::ResourceError(format!("no shader resource at '{path}'")));
    }
    if text.contains(NOT_A_SHADER_MARKER) {
        return Err(BridgeError::InvalidArgs(format!("'{path}' is not a Shader resource")));
    }
    if !text.contains(BEGIN_MARKER) {
        // The driver never reached the compile, so nothing here is a statement
        // about the shader. Report the failure instead of calling it valid.
        let tail: String = text.lines().rev().take(20).collect::<Vec<_>>().into_iter().rev().collect::<Vec<_>>().join("\n");
        return Err(BridgeError::Internal(format!(
            "shader validation subprocess did not run to the compile step (exit {exit_code:?}): {tail}"
        )));
    }

    let diagnostics = extract_diagnostics(text);
    Ok(json!({
        "path": path,
        "valid": diagnostics.is_empty(),
        "diagnostics": diagnostics,
        "exit_code": exit_code,
    }))
}

/// Pull shader diagnostics out of the child's combined output.
///
/// The format, confirmed against 4.7.1, is a source dump followed by the error:
///
/// ```text
/// --Main Shader--
///     3 | void fragment() {
/// E   4->  COLOR = vec4(1.0, 0.0, 0.0 1.0);
/// SHADER ERROR: Expected ',' or ')' after argument.
///    at: (null) (:4)
/// ERROR: Shader compilation failed.
/// ```
///
/// Two things make this different enough from `script.rs`'s extractor to want
/// its own: the `at:` continuation carries no path (`(null)`), so pairing on the
/// path finds nothing, and the dump echoes the user's own source, so a
/// "contains error" test would report the shader's own text as a diagnostic.
/// Both are handled structurally rather than by keyword.
fn extract_diagnostics(text: &str) -> Vec<Value> {
    let lines: Vec<&str> = text.lines().collect();
    let mut diagnostics = Vec::new();
    for (i, line) in lines.iter().enumerate() {
        if is_source_dump_line(line) {
            continue;
        }
        let trimmed = line.trim();
        let message = if let Some(rest) = trimmed.strip_prefix("SHADER ERROR:") {
            rest.trim().to_string()
        } else if let Some(name) = unsupported_shader_type(trimmed) {
            shader_type_message(&name)
        } else {
            continue;
        };
        let line_number = lines[i + 1..]
            .iter()
            .take_while(|next| next.trim_start().starts_with("at:"))
            .find_map(|next| line_number_from_at(next));
        diagnostics.push(json!({ "line": line_number, "message": message }));
    }
    diagnostics
}

/// Whether a line belongs to the compiler's echo of the shader source, which is
/// `%5d | %s` for context lines and `E%4d-> %s` for the offending one.
///
/// Anchored on the leading marker *and* the exact separator rather than on
/// "starts with a number", because the echo reproduces the user's own source:
/// a shader carrying an ASCII table in a comment prints lines that look like
/// dump rows. Those stay nested inside the outer numbering, so matching the
/// outer prefix is what keeps them out of the diagnostics, and a real engine
/// line never has either shape.
fn is_source_dump_line(line: &str) -> bool {
    if line.trim() == "--Main Shader--" {
        return true;
    }
    if let Some(rest) = line.strip_prefix('E') {
        return match after_right_aligned_number(rest) {
            Some(after) => after.starts_with("-> "),
            None => false,
        };
    }
    match after_right_aligned_number(line) {
        // A blank source line is `%5d | ` with nothing after it, and that
        // trailing space does not always survive.
        Some(after) => after.starts_with(" | ") || after.trim_end() == "|",
        None => false,
    }
}

/// The text following a run of padding spaces and digits, or `None` when the
/// line does not begin with a right-aligned number.
fn after_right_aligned_number(line: &str) -> Option<&str> {
    let rest = line.trim_start_matches(' ');
    let digits = rest.len() - rest.trim_start_matches(|c: char| c.is_ascii_digit()).len();
    if digits == 0 {
        return None;
    }
    Some(&rest[digits..])
}

/// The dummy renderer words a missing or unrecognised `shader_type` as its own
/// limitation ("not supported in Dummy renderer"), which reads like a defect in
/// this tool rather than in the shader. It is a real error either way -- the
/// five documented types all compile there (`docs/api-gaps.md`) -- so the
/// message is restated in the shader's terms.
fn unsupported_shader_type(line: &str) -> Option<String> {
    let rest = line.strip_prefix("ERROR:")?.trim();
    let rest = rest.strip_prefix("Shader type")?;
    let name = rest.strip_suffix("not supported in Dummy renderer.")?;
    Some(name.trim().to_string())
}

fn shader_type_message(name: &str) -> String {
    if name.is_empty() {
        "no 'shader_type' declaration was found; a shader must declare one (a failed #include can also leave it unreachable)".to_string()
    } else {
        format!("unknown shader_type '{name}'")
    }
}

/// The line number from an `at:` continuation, taking the digits before the
/// closing parenthesis. Handles both the shader form `at: (null) (:4)` and the
/// path-bearing form other subsystems use.
fn line_number_from_at(line: &str) -> Option<u64> {
    let close = line.rfind(')')?;
    let head = &line[..close];
    let colon = head.rfind(':')?;
    let digits = &head[colon + 1..];
    if digits.is_empty() || !digits.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    digits.parse().ok()
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
    fn validate_requires_path() {
        assert_invalid_args(validate(&json!({}), &ctx()));
    }

    #[test]
    fn validate_rejects_a_path_outside_the_project() {
        assert_invalid_args(validate(&json!({ "path": "/tmp/evil.gdshader" }), &ctx()));
    }

    #[test]
    fn validate_rejects_a_non_shader_extension() {
        assert_invalid_args(validate(&json!({ "path": "res://player.gd" }), &ctx()));
        // An include fragment has no shader_type and cannot compile alone.
        assert_invalid_args(validate(&json!({ "path": "res://lib.gdshaderinc" }), &ctx()));
    }

    // The real 4.7.1 output for a syntax error, source dump included.
    const BAD_BODY_OUTPUT: &str = concat!(
        "CONDUIT_SHADER_BEGIN\n",
        "--Main Shader--\n",
        "    2 | \n",
        "    3 | void fragment() {\n",
        "E   4->  COLOR = vec4(1.0, 0.0, 0.0 1.0);\n",
        "    5 | }\n",
        "SHADER ERROR: Expected ',' or ')' after argument.\n",
        "   at: (null) (:4)\n",
        "   GDScript backtrace (most recent call first):\n",
        "       [0] _initialize (C:/tmp/conduit-shader-check-1-0.gd:20)\n",
        "ERROR: Shader compilation failed.\n",
        "   at: shader_set_code (servers/rendering/dummy/storage/material_storage.cpp:192)\n",
        "CONDUIT_SHADER_END\n",
    );

    #[test]
    fn a_syntax_error_yields_one_diagnostic_with_its_line() {
        let value = interpret(BAD_BODY_OUTPUT, "res://bad.gdshader", Some(0)).unwrap();
        assert_eq!(value["valid"], false);
        let diagnostics = value["diagnostics"].as_array().unwrap();
        // "Shader compilation failed." is a summary of the error above it, not a
        // second defect, so it must not double-report.
        assert_eq!(diagnostics.len(), 1);
        assert_eq!(diagnostics[0]["line"], 4);
        assert!(diagnostics[0]["message"].as_str().unwrap().contains("Expected ',' or ')'"));
    }

    #[test]
    fn a_clean_compile_is_valid() {
        let output = "CONDUIT_SHADER_BEGIN\nCONDUIT_SHADER_END\n";
        let value = interpret(output, "res://good.gdshader", Some(0)).unwrap();
        assert_eq!(value["valid"], true);
        assert_eq!(value["diagnostics"].as_array().unwrap().len(), 0);
    }

    #[test]
    fn the_source_dump_is_never_read_as_a_diagnostic() {
        // The dump echoes the user's own source, so a shader that mentions the
        // word "error" in its own text would otherwise report itself broken.
        let output = concat!(
            "CONDUIT_SHADER_BEGIN\n",
            "--Main Shader--\n",
            "    3 | // error handling helper\n",
            "E   4->  float error_amount = 1.0 1.0;\n",
            "SHADER ERROR: Expected ';'.\n",
            "   at: (null) (:4)\n",
            "CONDUIT_SHADER_END\n",
        );
        let value = interpret(output, "res://bad.gdshader", Some(0)).unwrap();
        assert_eq!(value["diagnostics"].as_array().unwrap().len(), 1);
    }

    #[test]
    fn an_unrelated_engine_warning_does_not_fail_a_valid_shader() {
        let output = concat!(
            "CONDUIT_SHADER_BEGIN\n",
            "ERROR: Cannot open file 'res://unrelated.png'.\n",
            "   at: open (core/io/file_access.cpp:1)\n",
            "CONDUIT_SHADER_END\n",
        );
        let value = interpret(output, "res://good.gdshader", Some(0)).unwrap();
        assert_eq!(value["valid"], true);
    }

    #[test]
    fn a_missing_shader_type_is_restated_in_the_shaders_own_terms() {
        let output = concat!(
            "CONDUIT_SHADER_BEGIN\n",
            "ERROR: Shader type  not supported in Dummy renderer.\n",
            "   at: shader_set_code (servers/rendering/dummy/storage/material_storage.cpp:185)\n",
            "CONDUIT_SHADER_END\n",
        );
        let value = interpret(output, "res://notype.gdshader", Some(0)).unwrap();
        assert_eq!(value["valid"], false);
        let message = value["diagnostics"][0]["message"].as_str().unwrap();
        assert!(message.contains("shader_type"));
        assert!(!message.contains("Dummy"), "the renderer's own wording must not leak: {message}");
    }

    #[test]
    fn an_unknown_shader_type_names_what_was_declared() {
        let output = concat!(
            "CONDUIT_SHADER_BEGIN\n",
            "ERROR: Shader type bogus_type_name not supported in Dummy renderer.\n",
            "CONDUIT_SHADER_END\n",
        );
        let value = interpret(output, "res://bogus.gdshader", Some(0)).unwrap();
        assert_eq!(value["valid"], false);
        assert!(value["diagnostics"][0]["message"].as_str().unwrap().contains("bogus_type_name"));
    }

    #[test]
    fn a_child_that_never_reached_the_compile_is_an_error_not_a_pass() {
        let output = "Godot Engine v4.7.1.stable.official\nERROR: Failed to load project.\n";
        let err = interpret(output, "res://x.gdshader", Some(1)).unwrap_err();
        assert_eq!(err.code(), "internal_error");
    }

    #[test]
    fn a_missing_shader_reports_a_resource_error() {
        let err = interpret("CONDUIT_SHADER_MISSING\n", "res://gone.gdshader", Some(3)).unwrap_err();
        assert_eq!(err.code(), "resource_error");
    }

    #[test]
    fn a_resource_that_is_not_a_shader_reports_invalid_args() {
        let err = interpret("CONDUIT_SHADER_NOT_A_SHADER\n", "res://curve.gdshader", Some(4)).unwrap_err();
        assert_eq!(err.code(), "invalid_args");
    }

    #[test]
    fn line_numbers_parse_from_both_at_forms() {
        assert_eq!(line_number_from_at("   at: (null) (:4)"), Some(4));
        assert_eq!(line_number_from_at("   at: GDScript::reload (res://broken.gd:12)"), Some(12));
        assert_eq!(line_number_from_at("   at: something with no line"), None);
    }

    #[test]
    fn a_source_line_shaped_like_a_dump_row_is_still_only_source() {
        // A shader carrying an ASCII table in a comment echoes lines that look
        // exactly like dump rows. They arrive nested inside the outer
        // numbering, so the outer prefix is what matches and the one real
        // diagnostic below is still the only thing reported.
        let output = concat!(
            "CONDUIT_SHADER_BEGIN\n",
            "--Main Shader--\n",
            "    3 | // col | value\n",
            "    4 | //     3 | something\n",
            "E   5->  COLOR = vec4(1.0 1.0);\n",
            "SHADER ERROR: Expected ','.\n",
            "   at: (null) (:5)\n",
            "CONDUIT_SHADER_END\n",
        );
        let value = interpret(output, "res://bad.gdshader", Some(0)).unwrap();
        let diagnostics = value["diagnostics"].as_array().unwrap();
        assert_eq!(diagnostics.len(), 1);
        assert_eq!(diagnostics[0]["line"], 5);
    }

    #[test]
    fn source_dump_lines_are_recognised_by_shape() {
        assert!(is_source_dump_line("--Main Shader--"));
        assert!(is_source_dump_line("    3 | void fragment() {"));
        assert!(is_source_dump_line("E   4->  COLOR = vec4(1.0);"));
        assert!(is_source_dump_line("    2 | "));
        assert!(!is_source_dump_line("SHADER ERROR: Expected ';'."));
        assert!(!is_source_dump_line("ERROR: Shader compilation failed."));
        assert!(!is_source_dump_line("   at: (null) (:4)"));
        // "->" and "|" only count behind a right-aligned number, so neither a
        // stray arrow nor a table row on its own is mistaken for the echo.
        assert!(!is_source_dump_line("-> not a dump row"));
        assert!(!is_source_dump_line("col | value"));
    }
}
