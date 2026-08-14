//! Activation gating and the local command listener.
//!
//! Per Appendix D the activation guard is written and tested before the
//! listener it protects. The listener runs on a dedicated IO thread and never
//! calls the engine; it only moves framed JSON between the transport and the
//! bounded channels. This whole module is engine-agnostic and unit-tested
//! without Godot.
//!
//! Transport is per-platform (whitepaper section 7.2). Unix uses a filesystem
//! Unix-domain socket; Windows uses a named pipe; an opt-in loopback TCP
//! fallback exists for the editor endpoint. The three share one framing and one
//! channel wiring. The serve model differs by transport: Unix sockets and TCP
//! use a single non-blocking thread that multiplexes read, responses, and
//! events; Windows named pipes must use blocking I/O with the read and write
//! halves on separate threads, because interprocess's non-blocking mode sets the
//! legacy PIPE_NOWAIT flag which is broken for duplex use (see docs/api-gaps.md).

use std::io::{ErrorKind, Read, Write};
use std::net::{Ipv4Addr, SocketAddr, TcpListener, TcpStream};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::thread::{self, JoinHandle};
use std::time::Duration;

use crossbeam_channel::{Receiver, Sender, TrySendError};
use interprocess::local_socket::traits::{Listener as _, Stream as _};
#[cfg(windows)]
use interprocess::local_socket::{GenericNamespaced, ToNsName};
#[cfg(unix)]
use interprocess::local_socket::{GenericFilePath, ToFsName};
use interprocess::local_socket::{ListenerNonblockingMode, ListenerOptions, Stream};

#[cfg(windows)]
use crate::protocol::write_frame;
use crate::protocol::{BridgeError, Command, FrameDecoder, Response};
use crate::transport::status::LinkStatus;

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
/// its endpoint name (whitepaper sections 6.3 and 7.2).
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

/// The directory holding the per-project socket endpoints on Unix.
/// `CONDUIT_RUNTIME_DIR` overrides it so a test can point both the game bridge
/// and the broker at the same private directory; otherwise it is the system temp
/// dir. On Windows named pipes live in the `\\.\pipe\` namespace and this only
/// matters for the TCP fallback's game-port file (unused today).
#[cfg(unix)]
fn runtime_dir() -> PathBuf {
    std::env::var_os("CONDUIT_RUNTIME_DIR").map(PathBuf::from).unwrap_or_else(std::env::temp_dir)
}

/// Canonicalise a project path so both the bridge and the broker derive the same
/// endpoint hash from it. Forward slashes and no trailing slash on every
/// platform; case-folded on Windows because its filesystem is case-insensitive
/// and `globalize_path` and `CONDUIT_PROJECT` can disagree on drive-letter case.
/// The broker mirrors this exactly (see broker/src/framing.ts).
pub fn canonical_project_key(path: &str) -> String {
    let mut key = path.replace('\\', "/");
    while key.len() > 1 && key.ends_with('/') {
        key.pop();
    }
    // Case-fold on case-insensitive filesystems (Windows, and macOS by default),
    // where `globalize_path` and CONDUIT_PROJECT can disagree on letter case.
    #[cfg(any(windows, target_os = "macos"))]
    {
        key = key.to_lowercase();
    }
    key
}

/// A resolved transport endpoint plus how to bind, display, and clean it up.
#[derive(Debug, Clone)]
pub struct Endpoint {
    display: String,
    kind: EndpointKind,
}

#[derive(Debug, Clone)]
enum EndpointKind {
    /// Unix-domain filesystem socket; the file is removed before bind and on stop.
    #[cfg(unix)]
    File(PathBuf),
    /// Windows named pipe; `name` is the bare token, the OS prepends `\\.\pipe\`.
    #[cfg(windows)]
    Namespaced(String),
    /// Loopback TCP fallback (opt-in via CONDUIT_TCP).
    Tcp(SocketAddr),
}

impl Endpoint {
    pub fn display(&self) -> &str {
        &self.display
    }
}

/// Whether the loopback TCP fallback is requested.
fn tcp_fallback() -> bool {
    crate::env::env_flag("CONDUIT_TCP")
}

/// Derive a stable loopback port from an endpoint token, in the IANA
/// dynamic/private range so both ends agree without coordination.
fn tcp_port_for(token: &str) -> u16 {
    let mut hash: u32 = 2166136261;
    for byte in token.bytes() {
        hash ^= u32::from(byte);
        hash = hash.wrapping_mul(16777619);
    }
    49152 + (hash % 16384) as u16
}

/// Resolve the endpoint for a role, matching the `conduit-{role}-{hash}` scheme
/// of whitepaper section 7.2.
///
/// The editor endpoint honours an explicit `CONDUIT_SOCK` (used by tests and by
/// a broker that launches the editor). The game endpoint deliberately ignores
/// `CONDUIT_SOCK` and appends the process id, both because the editor-launched
/// game inherits the editor's `CONDUIT_SOCK` and must not collide with it, and
/// because several game instances can run at once (section 7.2).
pub fn endpoint(role: Role, project_path: &str) -> Endpoint {
    let hash = short_hash(&canonical_project_key(project_path));
    let token = match role {
        Role::Editor => format!("conduit-editor-{hash}"),
        Role::Game => format!("conduit-game-{hash}-{}", std::process::id()),
    };

    if role == Role::Editor && let Some(explicit) = std::env::var_os("CONDUIT_SOCK") {
        return endpoint_from_override(explicit);
    }

    if tcp_fallback() {
        let addr = SocketAddr::from((Ipv4Addr::LOCALHOST, tcp_port_for(&token)));
        return Endpoint { display: addr.to_string(), kind: EndpointKind::Tcp(addr) };
    }

    endpoint_from_token(&token)
}

/// Build the native local endpoint (Unix socket or Windows pipe) from a token.
fn endpoint_from_token(token: &str) -> Endpoint {
    #[cfg(unix)]
    {
        let path = runtime_dir().join(format!("{token}.sock"));
        Endpoint { display: path.display().to_string(), kind: EndpointKind::File(path) }
    }
    #[cfg(windows)]
    {
        Endpoint { display: format!("\\\\.\\pipe\\{token}"), kind: EndpointKind::Namespaced(token.to_string()) }
    }
    #[cfg(not(any(unix, windows)))]
    {
        // Platforms without a native local socket fall back to loopback TCP.
        let addr = SocketAddr::from((Ipv4Addr::LOCALHOST, tcp_port_for(token)));
        Endpoint { display: addr.to_string(), kind: EndpointKind::Tcp(addr) }
    }
}

/// Interpret a `CONDUIT_SOCK` override. On Unix it is a filesystem socket path;
/// on Windows it is a pipe name (a leading `\\.\pipe\` is accepted and stripped).
fn endpoint_from_override(explicit: std::ffi::OsString) -> Endpoint {
    #[cfg(unix)]
    {
        let path = PathBuf::from(explicit);
        Endpoint { display: path.display().to_string(), kind: EndpointKind::File(path) }
    }
    #[cfg(windows)]
    {
        let raw = explicit.to_string_lossy().to_string();
        let name = raw.strip_prefix("\\\\.\\pipe\\").unwrap_or(&raw).to_string();
        Endpoint { display: format!("\\\\.\\pipe\\{name}"), kind: EndpointKind::Namespaced(name) }
    }
    #[cfg(not(any(unix, windows)))]
    {
        let raw = explicit.to_string_lossy().to_string();
        let addr: SocketAddr = raw.parse().unwrap_or_else(|_| SocketAddr::from((Ipv4Addr::LOCALHOST, tcp_port_for(&raw))));
        Endpoint { display: addr.to_string(), kind: EndpointKind::Tcp(addr) }
    }
}

/// FNV-1a over the input, low 32 bits as hex. Stable and trivially reproducible
/// by the broker so both ends derive the same endpoint name.
fn short_hash(input: &str) -> String {
    let mut hash: u64 = 0xcbf2_9ce4_8422_2325;
    for byte in input.bytes() {
        hash ^= u64::from(byte);
        hash = hash.wrapping_mul(0x0000_0100_0000_01b3);
    }
    format!("{:08x}", (hash & 0xffff_ffff) as u32)
}

/// How to wake a listener thread that is parked in a blocking `accept()` so it
/// can observe the stop flag. Only the Windows named-pipe path blocks in accept.
enum Wake {
    None,
    #[cfg(windows)]
    Namespaced(String),
}

/// A running listener thread and the means to stop it.
pub struct Listener {
    display: String,
    cleanup: Option<PathBuf>,
    wake: Wake,
    stop: Arc<AtomicBool>,
    handle: Option<JoinHandle<()>>,
}

impl Listener {
    /// Bind the endpoint and spawn the accept loop on a dedicated thread.
    ///
    /// `hello_payload` is the pre-serialised hello frame written first on every
    /// new connection (whitepaper section 7.5); it is built on the main thread
    /// so the IO thread never calls the engine. The caller is responsible for
    /// having checked [`ActivationContext::should_bind`]; this function performs
    /// the bind unconditionally.
    pub fn spawn(
        endpoint: Endpoint,
        hello_payload: Vec<u8>,
        inbound_tx: Sender<Command>,
        outbound_rx: Receiver<Response>,
        event_rx: Receiver<Vec<u8>>,
        status: LinkStatus,
    ) -> std::io::Result<Listener> {
        let display = endpoint.display;
        let stop = Arc::new(AtomicBool::new(false));
        let thread_stop = Arc::clone(&stop);

        match endpoint.kind {
            #[cfg(unix)]
            EndpointKind::File(path) => {
                // The runtime dir may not exist yet (fresh CONDUIT_RUNTIME_DIR);
                // binding into a missing directory fails with ENOENT.
                if let Some(parent) = path.parent() {
                    let _ = std::fs::create_dir_all(parent);
                }
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
                status.mark_listening();
                let handle = thread::Builder::new().name("conduit-ipc".to_string()).spawn(move || {
                    accept_loop_local(listener, hello_payload, inbound_tx, outbound_rx, event_rx, thread_stop, status)
                })?;
                Ok(Listener { display, cleanup: Some(path), wake: Wake::None, stop, handle: Some(handle) })
            }
            #[cfg(windows)]
            EndpointKind::Namespaced(token) => {
                let name = token.as_str().to_ns_name::<GenericNamespaced>()?;
                // Blocking accept: interprocess non-blocking pipes are broken for
                // duplex, so the IO thread parks in accept and is woken on stop.
                let listener = ListenerOptions::new()
                    .name(name)
                    .nonblocking(ListenerNonblockingMode::Neither)
                    .create_sync()?;
                status.mark_listening();
                let handle = thread::Builder::new().name("conduit-ipc".to_string()).spawn(move || {
                    accept_loop_pipe(listener, hello_payload, inbound_tx, outbound_rx, event_rx, thread_stop, status)
                })?;
                Ok(Listener { display, cleanup: None, wake: Wake::Namespaced(token), stop, handle: Some(handle) })
            }
            EndpointKind::Tcp(addr) => {
                let listener = TcpListener::bind(addr)?;
                listener.set_nonblocking(true)?;
                status.mark_listening();
                let handle = thread::Builder::new().name("conduit-ipc".to_string()).spawn(move || {
                    accept_loop_tcp(listener, hello_payload, inbound_tx, outbound_rx, event_rx, thread_stop, status)
                })?;
                Ok(Listener { display, cleanup: None, wake: Wake::None, stop, handle: Some(handle) })
            }
        }
    }

    pub fn display(&self) -> &str {
        &self.display
    }

    // Idempotent: an explicit stop is followed by the Drop-invoked one, and the
    // second must not touch the endpoint again. On Windows, a wake connect
    // against the dead listener's name can block indefinitely in WaitNamedPipe
    // while a broker client still holds the old instance open, which turned a
    // clean editor shutdown into a hang (observed via gd_editor_quit).
    pub fn stop(&mut self) {
        let Some(handle) = self.handle.take() else {
            return;
        };
        self.stop.store(true, Ordering::SeqCst);
        self.wake_accept();
        let _ = handle.join();
        if let Some(path) = self.cleanup.take() {
            let _ = std::fs::remove_file(path);
        }
    }

    /// Unblock a listener parked in a blocking `accept()` (Windows named pipes)
    /// with a throwaway self-connection so it can see the stop flag.
    fn wake_accept(&self) {
        match &self.wake {
            Wake::None => {}
            #[cfg(windows)]
            Wake::Namespaced(token) => {
                if let Ok(name) = token.as_str().to_ns_name::<GenericNamespaced>() {
                    let _ = Stream::connect(name);
                }
            }
        }
    }
}

impl Drop for Listener {
    fn drop(&mut self) {
        self.stop();
    }
}

/// A stream that can toggle non-blocking mode; lets the non-blocking serve loop
/// work over both Unix-domain sockets and TCP.
trait NbStream: Read + Write {
    fn set_nb(&self, nonblocking: bool) -> std::io::Result<()>;
}

impl NbStream for Stream {
    fn set_nb(&self, nonblocking: bool) -> std::io::Result<()> {
        self.set_nonblocking(nonblocking)
    }
}

impl NbStream for TcpStream {
    fn set_nb(&self, nonblocking: bool) -> std::io::Result<()> {
        self.set_nonblocking(nonblocking)
    }
}

/// Non-blocking accept loop for interprocess local sockets (Unix domain).
#[cfg(unix)]
fn accept_loop_local(
    listener: interprocess::local_socket::Listener,
    hello_payload: Vec<u8>,
    inbound_tx: Sender<Command>,
    outbound_rx: Receiver<Response>,
    event_rx: Receiver<Vec<u8>>,
    stop: Arc<AtomicBool>,
    status: LinkStatus,
) {
    while !stop.load(Ordering::SeqCst) {
        match listener.accept() {
            Ok(stream) => {
                serve_nonblocking(stream, &hello_payload, &inbound_tx, &outbound_rx, &event_rx, &stop, &status);
                // Every serve exit path funnels here, so one mark covers all
                // disconnect causes (peer close, read error, framing error).
                status.mark_listening();
            }
            Err(err) if err.kind() == ErrorKind::WouldBlock => thread::sleep(Duration::from_millis(1)),
            Err(err) => {
                eprintln!("conduit: accept error: {err}");
                thread::sleep(Duration::from_millis(5));
            }
        }
    }
}

/// Non-blocking accept loop for loopback TCP.
fn accept_loop_tcp(
    listener: TcpListener,
    hello_payload: Vec<u8>,
    inbound_tx: Sender<Command>,
    outbound_rx: Receiver<Response>,
    event_rx: Receiver<Vec<u8>>,
    stop: Arc<AtomicBool>,
    status: LinkStatus,
) {
    while !stop.load(Ordering::SeqCst) {
        match listener.accept() {
            Ok((stream, _addr)) => {
                serve_nonblocking(stream, &hello_payload, &inbound_tx, &outbound_rx, &event_rx, &stop, &status);
                status.mark_listening();
            }
            Err(err) if err.kind() == ErrorKind::WouldBlock => thread::sleep(Duration::from_millis(1)),
            Err(err) => {
                eprintln!("conduit: accept error: {err}");
                thread::sleep(Duration::from_millis(5));
            }
        }
    }
}

/// Blocking accept loop for Windows named pipes. Serves one connection at a time
/// with the read and write halves on separate threads (see [`serve_split`]).
#[cfg(windows)]
fn accept_loop_pipe(
    listener: interprocess::local_socket::Listener,
    hello_payload: Vec<u8>,
    inbound_tx: Sender<Command>,
    outbound_rx: Receiver<Response>,
    event_rx: Receiver<Vec<u8>>,
    stop: Arc<AtomicBool>,
    status: LinkStatus,
) {
    while !stop.load(Ordering::SeqCst) {
        match listener.accept() {
            Ok(stream) => {
                if stop.load(Ordering::SeqCst) {
                    break; // woken by the stop self-connection
                }
                serve_split(stream, &hello_payload, &inbound_tx, &outbound_rx, &event_rx, &stop, &status);
                // The split writer lingers briefly to flush after reader EOF, so
                // Connected can outlive the peer by a beat; benign for a UI dot.
                status.mark_listening();
            }
            Err(err) => {
                if !stop.load(Ordering::SeqCst) {
                    eprintln!("conduit: accept error: {err}");
                }
                break;
            }
        }
    }
}

/// Serve one connection with a single non-blocking thread multiplexing inbound
/// frames, dispatcher responses, and unsolicited events (Unix sockets and TCP).
fn serve_nonblocking<S: NbStream>(
    mut stream: S,
    hello_payload: &[u8],
    inbound_tx: &Sender<Command>,
    outbound_rx: &Receiver<Response>,
    event_rx: &Receiver<Vec<u8>>,
    stop: &Arc<AtomicBool>,
    status: &LinkStatus,
) {
    if let Err(err) = stream.set_nb(true) {
        eprintln!("conduit: could not set stream non-blocking: {err}");
        return;
    }
    // Announce ourselves first so the broker can check role and protocol version
    // before issuing commands (section 7.5).
    if write_framed_bytes(&mut stream, hello_payload, stop).is_err() {
        return;
    }
    status.mark_connected();
    // Drop any responses or events left over from a prior connection so stale ids
    // cannot leak onto a freshly connected broker and a stale event cannot wedge
    // its state; the broker resyncs on connect (whitepaper section 7.5).
    while outbound_rx.try_recv().is_ok() {}
    while event_rx.try_recv().is_ok() {}

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
                    if !handle_inbound_frame_nb(&frame, inbound_tx, &mut stream, stop) {
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
            if write_framed_bytes(&mut stream, &response.to_bytes(), stop).is_err() {
                return;
            }
        }

        // Unsolicited event frames (already serialised on the main thread) are
        // written after responses so a break event never jumps ahead of the
        // response to the command that induced it (whitepaper section 7.5).
        while let Ok(payload) = event_rx.try_recv() {
            did_work = true;
            if write_framed_bytes(&mut stream, &payload, stop).is_err() {
                return;
            }
        }

        if !did_work {
            thread::sleep(Duration::from_micros(200));
        }
    }
}

/// Serve one Windows named-pipe connection with blocking I/O and the read and
/// write halves on separate threads. interprocess's non-blocking mode is
/// unusable here (see the module docs), so the reader parks in a blocking read
/// while the writer emits dispatcher responses and unsolicited events whenever
/// they are ready. The reader routes its own out-of-band responses (busy
/// backpressure, malformed-frame errors) to the writer rather than touching the
/// pipe directly, since only one thread may write.
#[cfg(windows)]
fn serve_split(
    stream: Stream,
    hello_payload: &[u8],
    inbound_tx: &Sender<Command>,
    outbound_rx: &Receiver<Response>,
    event_rx: &Receiver<Vec<u8>>,
    stop: &Arc<AtomicBool>,
    status: &LinkStatus,
) {
    let (mut recv, mut send) = stream.split();

    // Drain stale state before the hello, matching serve_nonblocking.
    while outbound_rx.try_recv().is_ok() {}
    while event_rx.try_recv().is_ok() {}
    if write_frame(&mut send, hello_payload).is_err() {
        return;
    }
    status.mark_connected();

    let reader_done = Arc::new(AtomicBool::new(false));
    let (local_tx, local_rx) = crossbeam_channel::unbounded::<Response>();

    let reader = {
        let inbound_tx = inbound_tx.clone();
        let stop = Arc::clone(stop);
        let reader_done = Arc::clone(&reader_done);
        thread::Builder::new()
            .name("conduit-ipc-read".to_string())
            .spawn(move || {
                let mut decoder = FrameDecoder::new();
                let mut read_buf = [0u8; 8192];
                'outer: while !stop.load(Ordering::SeqCst) {
                    match recv.read(&mut read_buf) {
                        Ok(0) => break,
                        Ok(n) => {
                            decoder.push(&read_buf[..n]);
                            loop {
                                match decoder.next_frame() {
                                    Ok(Some(frame)) => {
                                        if !route_inbound_frame(&frame, &inbound_tx, &local_tx) {
                                            break 'outer;
                                        }
                                    }
                                    Ok(None) => break,
                                    Err(err) => {
                                        eprintln!("conduit: framing error, closing connection: {err}");
                                        break 'outer;
                                    }
                                }
                            }
                        }
                        Err(err) if err.kind() == ErrorKind::Interrupted => {}
                        Err(_) => break,
                    }
                }
                reader_done.store(true, Ordering::SeqCst);
            })
            .ok()
    };

    // Writer (this thread): drain io-generated responses first, then dispatcher
    // responses, then events, all with blocking writes.
    while !stop.load(Ordering::SeqCst) {
        let mut did_work = false;
        let mut broken = false;

        for source in [&local_rx, outbound_rx] {
            while let Ok(response) = source.try_recv() {
                did_work = true;
                if write_frame(&mut send, &response.to_bytes()).is_err() {
                    broken = true;
                    break;
                }
            }
            if broken {
                break;
            }
        }
        if !broken {
            while let Ok(payload) = event_rx.try_recv() {
                did_work = true;
                if write_frame(&mut send, &payload).is_err() {
                    broken = true;
                    break;
                }
            }
        }

        if broken {
            break;
        }
        // The connection is finished once the reader saw EOF and nothing is left
        // to flush. The reader thread is detached (not joined) so a stop while it
        // is parked in a blocking read does not hang the accept thread; it ends
        // when the peer disconnects or the process exits (see docs/api-gaps.md).
        if reader_done.load(Ordering::SeqCst) && local_rx.is_empty() && outbound_rx.is_empty() && event_rx.is_empty() {
            break;
        }
        if !did_work {
            thread::sleep(Duration::from_micros(500));
        }
    }
    drop(send);
    drop(reader);
}

/// Push a parsed command onto the inbound queue, or answer `busy` when the queue
/// is full (non-blocking serve). Returns false if the connection should be torn
/// down.
fn handle_inbound_frame_nb<S: NbStream>(
    frame: &[u8],
    inbound_tx: &Sender<Command>,
    stream: &mut S,
    stop: &Arc<AtomicBool>,
) -> bool {
    match decode_command(frame) {
        DecodeOutcome::Command(command) => match inbound_tx.try_send(command) {
            Ok(()) => true,
            Err(TrySendError::Full(rejected)) => {
                write_framed_bytes(stream, &Response::failed(rejected.id, &BridgeError::Busy).to_bytes(), stop).is_ok()
            }
            Err(TrySendError::Disconnected(_)) => false,
        },
        DecodeOutcome::Error { id: Some(id), error } => {
            write_framed_bytes(stream, &Response::failed(id, &error).to_bytes(), stop).is_ok()
        }
        DecodeOutcome::Error { id: None, .. } => true, // uncorrelatable; keep the connection alive
    }
}

/// Reader-thread variant of [`handle_inbound_frame_nb`]: routes out-of-band
/// responses to the writer via `local_tx` instead of writing the pipe directly.
#[cfg(windows)]
fn route_inbound_frame(frame: &[u8], inbound_tx: &Sender<Command>, local_tx: &Sender<Response>) -> bool {
    match decode_command(frame) {
        DecodeOutcome::Command(command) => match inbound_tx.try_send(command) {
            Ok(()) => true,
            Err(TrySendError::Full(rejected)) => {
                local_tx.send(Response::failed(rejected.id, &BridgeError::Busy)).is_ok()
            }
            Err(TrySendError::Disconnected(_)) => false,
        },
        DecodeOutcome::Error { id: Some(id), error } => local_tx.send(Response::failed(id, &error)).is_ok(),
        DecodeOutcome::Error { id: None, .. } => true,
    }
}

enum DecodeOutcome {
    Command(Command),
    Error { id: Option<u64>, error: BridgeError },
}

/// Parse a command frame, recovering the id from a malformed frame where
/// possible so the broker can still correlate the error.
fn decode_command(frame: &[u8]) -> DecodeOutcome {
    match serde_json::from_slice::<Command>(frame) {
        Ok(command) => DecodeOutcome::Command(command),
        Err(err) => {
            let id = serde_json::from_slice::<serde_json::Value>(frame)
                .ok()
                .and_then(|value| value.get("id").and_then(serde_json::Value::as_u64));
            DecodeOutcome::Error { id, error: BridgeError::InvalidArgs(format!("malformed command frame: {err}")) }
        }
    }
}

/// Length-prefix and write a payload on a non-blocking stream, retrying on
/// `WouldBlock`. Shared by the hello frame and every response in the
/// non-blocking serve model.
fn write_framed_bytes<S: NbStream>(stream: &mut S, payload: &[u8], stop: &Arc<AtomicBool>) -> std::io::Result<()> {
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
        // never call Listener::spawn, so no endpoint is created.
        let path = std::env::temp_dir().join("conduit-test-must-not-exist.sock");
        let _ = std::fs::remove_file(&path);
        let context = ctx(false, true, true, true);
        if context.should_bind() {
            panic!("release context must not bind");
        }
        assert!(!path.exists());
    }

    #[test]
    fn canonical_project_key_normalises_separators_and_trailing_slash() {
        // The whole point of the canonical key: variants that denote the same
        // project must hash identically so the bridge and broker agree.
        assert_eq!(short_hash(&canonical_project_key("/a/b/c/")), short_hash(&canonical_project_key("/a/b/c")));
        #[cfg(windows)]
        {
            assert_eq!(
                short_hash(&canonical_project_key("C:\\Games\\Proj\\")),
                short_hash(&canonical_project_key("c:/games/proj"))
            );
        }
        #[cfg(not(windows))]
        {
            assert_eq!(canonical_project_key("/a/b/c/"), "/a/b/c");
        }
    }

    /// Save and clear the transport env vars, run `body`, then restore them, so a
    /// developer's ambient CONDUIT_SOCK/CONDUIT_TCP cannot flip the transport the
    /// test asserts. `set_var`/`remove_var` are unsafe in edition 2024 because
    /// they mutate shared process state; these are the only tests touching them.
    fn with_native_transport(body: impl FnOnce()) {
        let prev_sock = std::env::var_os("CONDUIT_SOCK");
        let prev_tcp = std::env::var_os("CONDUIT_TCP");
        unsafe {
            std::env::remove_var("CONDUIT_TCP");
        }
        body();
        unsafe {
            match prev_sock {
                Some(value) => std::env::set_var("CONDUIT_SOCK", value),
                None => std::env::remove_var("CONDUIT_SOCK"),
            }
            match prev_tcp {
                Some(value) => std::env::set_var("CONDUIT_TCP", value),
                None => std::env::remove_var("CONDUIT_TCP"),
            }
        }
    }

    #[cfg(unix)]
    #[test]
    fn editor_endpoint_honours_explicit_override() {
        with_native_transport(|| {
            unsafe { std::env::set_var("CONDUIT_SOCK", "/tmp/explicit-conduit.sock") };
            let ep = endpoint(Role::Editor, "/whatever");
            assert!(matches!(ep.kind, EndpointKind::File(ref p) if p == std::path::Path::new("/tmp/explicit-conduit.sock")));
        });
    }

    #[test]
    fn game_endpoint_ignores_override_and_carries_pid() {
        // The game endpoint must never reuse CONDUIT_SOCK (the editor-launched
        // game inherits it) and appends the pid so instances never collide.
        with_native_transport(|| {
            unsafe { std::env::set_var("CONDUIT_SOCK", "explicit-conduit") };
            let ep = endpoint(Role::Game, "/whatever");
            assert!(ep.display().contains("conduit-game-"), "unexpected game endpoint: {}", ep.display());
            assert!(
                ep.display().contains(&format!("-{}", std::process::id())),
                "game endpoint should carry the pid: {}",
                ep.display()
            );
        });
    }

    #[test]
    fn short_hash_is_stable_and_project_specific() {
        assert_eq!(short_hash("/a/b/c"), short_hash("/a/b/c"));
        assert_ne!(short_hash("/a/b/c"), short_hash("/a/b/d"));
        assert_eq!(short_hash("/a/b/c").len(), 8);
    }

    #[test]
    fn tcp_port_is_stable_and_in_dynamic_range() {
        let p = tcp_port_for("conduit-editor-deadbeef");
        assert_eq!(p, tcp_port_for("conduit-editor-deadbeef"));
        assert!(p >= 49152);
    }
}
