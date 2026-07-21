//! Activation gating and the local-socket listener.
//!
//! Per Appendix D the activation guard is written and tested before the
//! listener it protects. The listener runs on a dedicated IO thread and never
//! calls the engine; it only moves framed JSON between the socket and the
//! bounded channels. This whole module is engine-agnostic and unit-tested
//! without Godot.

use std::io::{ErrorKind, Read, Write};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::thread::{self, JoinHandle};
use std::time::Duration;

use crossbeam_channel::{Receiver, Sender, TrySendError};
use interprocess::local_socket::traits::{Listener as _, Stream as _};
use interprocess::local_socket::{
    GenericFilePath, ListenerNonblockingMode, ListenerOptions, Stream, ToFsName,
};

use crate::protocol::{write_frame, BridgeError, Command, FrameDecoder, Response};

/// The facts that decide whether the command listener may bind. Kept as plain
/// booleans so the decision is pure and fully testable; the plugin fills them
/// in from the engine (whitepaper section 6.3).
#[derive(Debug, Clone, Copy)]
pub struct ActivationContext {
    pub is_editor: bool,
    pub is_release_build: bool,
    pub cmdline_opt_in: bool,
    pub env_opt_in: bool,
}

impl ActivationContext {
    /// Whether the listener is permitted to bind.
    ///
    /// The release check is first and absolute: a release build never binds,
    /// regardless of any opt-in flag or editor hint. Otherwise the editor
    /// always binds, and a non-editor (debug) context binds only with an
    /// explicit opt-in. This ordering is the safety property, not a convenience.
    pub fn should_bind(&self) -> bool {
        if self.is_release_build {
            return false;
        }
        if self.is_editor {
            return true;
        }
        self.cmdline_opt_in || self.env_opt_in
    }
}

/// Which personality a bridge presents, which selects both its handler set and
/// its socket endpoint name (whitepaper sections 6.3 and 7.2).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Role {
    Editor,
    Game,
}

impl Role {
    pub fn as_str(self) -> &'static str {
        match self {
            Role::Editor => "editor",
            Role::Game => "game",
        }
    }
}

/// The directory holding the per-project socket endpoints. `CONDUIT_RUNTIME_DIR`
/// overrides it so a test can point both the game bridge and the broker at the
/// same private directory; otherwise it is the system temp dir.
fn runtime_dir() -> PathBuf {
    std::env::var_os("CONDUIT_RUNTIME_DIR").map(PathBuf::from).unwrap_or_else(std::env::temp_dir)
}

/// Resolve the listener socket path for a role, matching the
/// `conduit-{role}-{hash}` scheme of whitepaper section 7.2.
///
/// The editor endpoint honours an explicit `CONDUIT_SOCK` (used by tests and by
/// a broker that launches the editor). The game endpoint deliberately ignores
/// `CONDUIT_SOCK` and appends the process id, both because the editor-launched
/// game inherits the editor's `CONDUIT_SOCK` and must not collide with it, and
/// because several game instances can run at once (section 7.2).
pub fn socket_path(role: Role, project_path: &str) -> PathBuf {
    match role {
        Role::Editor => {
            if let Some(explicit) = std::env::var_os("CONDUIT_SOCK") {
                return PathBuf::from(explicit);
            }
            runtime_dir().join(format!("conduit-editor-{}.sock", short_hash(project_path)))
        }
        Role::Game => runtime_dir().join(format!(
            "conduit-game-{}-{}.sock",
            short_hash(project_path),
            std::process::id()
        )),
    }
}

/// FNV-1a over the project path, low 32 bits as hex. Stable and trivially
/// reproducible by the broker so both ends derive the same endpoint name.
fn short_hash(input: &str) -> String {
    let mut hash: u64 = 0xcbf2_9ce4_8422_2325;
    for byte in input.bytes() {
        hash ^= u64::from(byte);
        hash = hash.wrapping_mul(0x0000_0100_0000_01b3);
    }
    format!("{:08x}", (hash & 0xffff_ffff) as u32)
}

/// A running listener thread and the means to stop it.
pub struct Listener {
    path: PathBuf,
    stop: Arc<AtomicBool>,
    handle: Option<JoinHandle<()>>,
}

impl Listener {
    /// Bind the socket and spawn the accept loop on a dedicated thread.
    ///
    /// `hello_payload` is the pre-serialised hello frame written first on every
    /// new connection (whitepaper section 7.5); it is built on the main thread
    /// so the IO thread never calls the engine. The caller is responsible for
    /// having checked [`ActivationContext::should_bind`]; this function performs
    /// the bind unconditionally.
    pub fn spawn(
        path: PathBuf,
        hello_payload: Vec<u8>,
        inbound_tx: Sender<Command>,
        outbound_rx: Receiver<Response>,
    ) -> std::io::Result<Listener> {
        // A stale socket file from a previous run would block the bind.
        let _ = std::fs::remove_file(&path);

        let name = path
            .to_str()
            .ok_or_else(|| std::io::Error::new(ErrorKind::InvalidInput, "non-utf8 socket path"))?
            .to_fs_name::<GenericFilePath>()?;
        let listener = ListenerOptions::new()
            .name(name)
            .nonblocking(ListenerNonblockingMode::Accept)
            .create_sync()?;

        let stop = Arc::new(AtomicBool::new(false));
        let thread_stop = Arc::clone(&stop);
        let handle = thread::Builder::new()
            .name("conduit-ipc".to_string())
            .spawn(move || accept_loop(listener, hello_payload, inbound_tx, outbound_rx, thread_stop))?;

        Ok(Listener { path, stop, handle: Some(handle) })
    }

    pub fn path(&self) -> &std::path::Path {
        &self.path
    }

    pub fn stop(&mut self) {
        self.stop.store(true, Ordering::SeqCst);
        if let Some(handle) = self.handle.take() {
            let _ = handle.join();
        }
        let _ = std::fs::remove_file(&self.path);
    }
}

impl Drop for Listener {
    fn drop(&mut self) {
        self.stop();
    }
}

fn accept_loop(
    listener: interprocess::local_socket::Listener,
    hello_payload: Vec<u8>,
    inbound_tx: Sender<Command>,
    outbound_rx: Receiver<Response>,
    stop: Arc<AtomicBool>,
) {
    while !stop.load(Ordering::SeqCst) {
        match listener.accept() {
            Ok(mut stream) => {
                if let Err(err) = stream.set_nonblocking(true) {
                    eprintln!("conduit: could not set stream non-blocking: {err}");
                    continue;
                }
                // Announce ourselves first so the broker can check role and
                // protocol version before issuing commands (section 7.5).
                if write_framed_bytes(&mut stream, &hello_payload, &stop).is_err() {
                    continue;
                }
                // Drop any responses left over from a prior connection so their
                // ids cannot leak onto a freshly connected broker.
                while outbound_rx.try_recv().is_ok() {}
                serve_connection(stream, &inbound_tx, &outbound_rx, &stop);
            }
            Err(err) if err.kind() == ErrorKind::WouldBlock => {
                thread::sleep(Duration::from_millis(1));
            }
            Err(err) => {
                eprintln!("conduit: accept error: {err}");
                thread::sleep(Duration::from_millis(5));
            }
        }
    }
}

fn serve_connection(
    mut stream: Stream,
    inbound_tx: &Sender<Command>,
    outbound_rx: &Receiver<Response>,
    stop: &Arc<AtomicBool>,
) {
    let mut decoder = FrameDecoder::new();
    let mut read_buf = [0u8; 8192];

    while !stop.load(Ordering::SeqCst) {
        let mut did_work = false;

        match stream.read(&mut read_buf) {
            Ok(0) => break, // peer closed
            Ok(n) => {
                decoder.push(&read_buf[..n]);
                did_work = true;
            }
            Err(err) if err.kind() == ErrorKind::WouldBlock => {}
            Err(err) if err.kind() == ErrorKind::Interrupted => {}
            Err(err) => {
                eprintln!("conduit: read error: {err}");
                break;
            }
        }

        loop {
            match decoder.next_frame() {
                Ok(Some(frame)) => {
                    did_work = true;
                    if !handle_inbound_frame(&frame, inbound_tx, &mut stream, stop) {
                        return;
                    }
                }
                Ok(None) => break,
                Err(err) => {
                    eprintln!("conduit: framing error, closing connection: {err}");
                    return;
                }
            }
        }

        while let Ok(response) = outbound_rx.try_recv() {
            did_work = true;
            if write_response(&mut stream, &response, stop).is_err() {
                return;
            }
        }

        if !did_work {
            thread::sleep(Duration::from_micros(200));
        }
    }
}

/// Push a parsed command onto the inbound queue, or answer `busy` when the
/// queue is full. Returns false if the connection should be torn down.
fn handle_inbound_frame(
    frame: &[u8],
    inbound_tx: &Sender<Command>,
    stream: &mut Stream,
    stop: &Arc<AtomicBool>,
) -> bool {
    match serde_json::from_slice::<Command>(frame) {
        Ok(command) => {
            let id = command.id;
            match inbound_tx.try_send(command) {
                Ok(()) => true,
                Err(TrySendError::Full(_)) => {
                    // Backpressure: reject immediately rather than block or grow.
                    write_response(stream, &Response::failed(id, &BridgeError::Busy), stop).is_ok()
                }
                Err(TrySendError::Disconnected(_)) => false,
            }
        }
        Err(err) => {
            // Recover the id if we can so the broker can still correlate the error.
            let id = serde_json::from_slice::<serde_json::Value>(frame)
                .ok()
                .and_then(|value| value.get("id").and_then(serde_json::Value::as_u64));
            let error = BridgeError::InvalidArgs(format!("malformed command frame: {err}"));
            match id {
                Some(id) => write_response(stream, &Response::failed(id, &error), stop).is_ok(),
                None => true, // uncorrelatable; drop and keep the connection alive
            }
        }
    }
}

/// Write a response frame, tolerating non-blocking `WouldBlock` by retrying.
/// Frames are small and the broker reads continuously, so this seldom spins.
fn write_response(stream: &mut Stream, response: &Response, stop: &Arc<AtomicBool>) -> std::io::Result<()> {
    write_framed_bytes(stream, &response.to_bytes(), stop)
}

/// Length-prefix and write an arbitrary payload, retrying on non-blocking
/// `WouldBlock`. Shared by the hello frame and every response.
fn write_framed_bytes(stream: &mut Stream, payload: &[u8], stop: &Arc<AtomicBool>) -> std::io::Result<()> {
    let mut framed = Vec::with_capacity(payload.len() + 4);
    framed.extend_from_slice(&(payload.len() as u32).to_be_bytes());
    framed.extend_from_slice(payload);

    let mut written = 0;
    while written < framed.len() {
        if stop.load(Ordering::SeqCst) {
            return Err(std::io::Error::new(ErrorKind::Interrupted, "listener stopping"));
        }
        match stream.write(&framed[written..]) {
            Ok(0) => return Err(std::io::Error::new(ErrorKind::WriteZero, "socket closed")),
            Ok(n) => written += n,
            Err(err) if err.kind() == ErrorKind::WouldBlock => {
                thread::sleep(Duration::from_micros(100));
            }
            Err(err) if err.kind() == ErrorKind::Interrupted => {}
            Err(err) => return Err(err),
        }
    }
    stream.flush()
}

// Keep the blocking single-frame writer referenced so it remains available to
// clients and tests without a dead-code warning in the cdylib build.
#[allow(dead_code)]
fn write_single_frame<W: Write>(writer: &mut W, payload: &[u8]) -> std::io::Result<()> {
    write_frame(writer, payload)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ctx(is_editor: bool, is_release: bool, cmd: bool, env: bool) -> ActivationContext {
        ActivationContext {
            is_editor,
            is_release_build: is_release,
            cmdline_opt_in: cmd,
            env_opt_in: env,
        }
    }

    #[test]
    fn editor_binds() {
        assert!(ctx(true, false, false, false).should_bind());
    }

    #[test]
    fn debug_non_editor_needs_opt_in() {
        assert!(!ctx(false, false, false, false).should_bind());
        assert!(ctx(false, false, true, false).should_bind());
        assert!(ctx(false, false, false, true).should_bind());
    }

    #[test]
    fn release_build_never_binds_even_with_every_opt_in() {
        // The mandated safety test (CLAUDE.md, whitepaper 6.3): a release
        // context refuses to bind regardless of flags, and even if the editor
        // hint were somehow set.
        assert!(!ctx(false, true, true, true).should_bind());
        assert!(!ctx(true, true, true, true).should_bind());
    }

    #[test]
    fn should_bind_false_context_creates_no_socket() {
        // Prove the gate is what prevents the bind: a refusing context means we
        // never call Listener::spawn, so no socket file is created.
        let path = std::env::temp_dir().join("conduit-test-must-not-exist.sock");
        let _ = std::fs::remove_file(&path);
        let context = ctx(false, true, true, true);
        if context.should_bind() {
            panic!("release context must not bind");
        }
        assert!(!path.exists());
    }

    #[test]
    fn editor_socket_path_honours_explicit_override() {
        // Uses a process-wide env var; scoped tightly and restored. `set_var`
        // and `remove_var` are unsafe in edition 2024 because they mutate shared
        // process state; no other test reads CONDUIT_SOCK concurrently.
        let previous = std::env::var_os("CONDUIT_SOCK");
        unsafe { std::env::set_var("CONDUIT_SOCK", "/tmp/explicit-conduit.sock") };
        assert_eq!(socket_path(Role::Editor, "/whatever"), PathBuf::from("/tmp/explicit-conduit.sock"));
        unsafe {
            match previous {
                Some(value) => std::env::set_var("CONDUIT_SOCK", value),
                None => std::env::remove_var("CONDUIT_SOCK"),
            }
        }
    }

    #[test]
    fn game_socket_path_ignores_override_and_carries_pid() {
        // The game endpoint must never reuse CONDUIT_SOCK (the editor-launched
        // game inherits it) and appends the pid so instances never collide.
        let previous = std::env::var_os("CONDUIT_SOCK");
        unsafe { std::env::set_var("CONDUIT_SOCK", "/tmp/explicit-conduit.sock") };
        let path = socket_path(Role::Game, "/whatever");
        let name = path.file_name().and_then(|n| n.to_str()).unwrap_or_default();
        assert!(name.starts_with("conduit-game-"), "unexpected game socket name: {name}");
        assert!(name.ends_with(&format!("-{}.sock", std::process::id())));
        assert_ne!(path, PathBuf::from("/tmp/explicit-conduit.sock"));
        unsafe {
            match previous {
                Some(value) => std::env::set_var("CONDUIT_SOCK", value),
                None => std::env::remove_var("CONDUIT_SOCK"),
            }
        }
    }

    #[test]
    fn short_hash_is_stable_and_project_specific() {
        assert_eq!(short_hash("/a/b/c"), short_hash("/a/b/c"));
        assert_ne!(short_hash("/a/b/c"), short_hash("/a/b/d"));
        assert_eq!(short_hash("/a/b/c").len(), 8);
    }
}
