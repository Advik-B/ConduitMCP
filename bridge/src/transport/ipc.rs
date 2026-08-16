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
#[cfg(windows)]
use std::sync::atomic::AtomicU64;
use std::sync::Arc;
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant};

use crossbeam_channel::{Receiver, Sender, TrySendError};
use interprocess::local_socket::traits::{Listener as _, Stream as _};
#[cfg(windows)]
use interprocess::local_socket::{GenericNamespaced, ToNsName};
#[cfg(unix)]
use interprocess::local_socket::{GenericFilePath, ToFsName};
use interprocess::local_socket::{ListenerNonblockingMode, ListenerOptions, Stream};

#[cfg(windows)]
use crate::protocol::write_frame;
use crate::protocol::{ping_payload, pong_payload, BridgeError, Command, FrameDecoder, Response};
use crate::transport::status::LinkStatus;

/// How long the peer may be silent before we ask whether it is still there.
#[cfg(not(test))]
const PING_AFTER: Duration = Duration::from_secs(5);

/// How long the peer may be silent before we stop believing in it. Three missed
/// pings plus margin. Reaching it drops the connection, which is what returns
/// the listener to Listening and frees the accept slot for another broker; a
/// bridge serves one client at a time, so holding a dead one is not a cosmetic
/// problem (docs/api-gaps.md).
#[cfg(not(test))]
const LIVENESS_TIMEOUT: Duration = Duration::from_secs(20);

/// How long a single frame may take to leave, when the peer has stopped reading
/// and the socket buffer is full. Without this the non-blocking write retries on
/// WouldBlock forever and pins the IO thread, so the serve function never
/// returns and the accept slot is never freed.
#[cfg(not(test))]
const WRITE_STALL_TIMEOUT: Duration = Duration::from_secs(20);

// Scaled down under test, and only under test: the behaviour being asserted is
// which event happens and in what order, not how many seconds it waits, and the
// shipped values would make each of these a half-minute test. The ratios are
// kept so the ordering the tests rely on is the shipped ordering.
#[cfg(test)]
const PING_AFTER: Duration = Duration::from_millis(100);
#[cfg(test)]
const LIVENESS_TIMEOUT: Duration = Duration::from_millis(400);
#[cfg(test)]
const WRITE_STALL_TIMEOUT: Duration = Duration::from_millis(400);

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
    let mut liveness = Liveness::new();

    while !stop.load(Ordering::SeqCst) {
        let mut did_work = false;

        match stream.read(&mut read_buf) {
            Ok(0) => break, // peer closed
            Ok(n) => {
                // Any inbound byte proves the peer is acting, so a busy link is
                // never pinged; only genuine silence is.
                liveness.saw_input();
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
                    match classify_inbound(&frame) {
                        Inbound::Ping(seq) => {
                            if write_framed_bytes(&mut stream, &pong_payload(seq), stop).is_err() {
                                return;
                            }
                        }
                        Inbound::Pong => liveness.saw_pong(),
                        Inbound::Other => {
                            if !handle_inbound_frame_nb(&frame, inbound_tx, &mut stream, stop) {
                                return;
                            }
                        }
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
            match liveness.due() {
                Due::Dead => {
                    eprintln!(
                        "conduit: broker silent for {}s, dropping the connection so another can attach",
                        LIVENESS_TIMEOUT.as_secs()
                    );
                    break;
                }
                Due::Ping(seq) => {
                    if write_framed_bytes(&mut stream, &ping_payload(seq), stop).is_err() {
                        return;
                    }
                }
                Due::Nothing => thread::sleep(Duration::from_micros(200)),
            }
        }
    }
}

/// What an inbound frame is, before it costs a serde command parse. Liveness
/// frames are answered or counted on the IO thread and never reach the
/// dispatcher, so a busy main thread cannot make a live peer look dead.
enum Inbound {
    Ping(u64),
    Pong,
    Other,
}

fn classify_inbound(frame: &[u8]) -> Inbound {
    // Cheap reject first: every command frame carries an id and a tool, so the
    // common case never runs this parse.
    if !frame.starts_with(b"{\"ping\":") && !frame.starts_with(b"{\"pong\":") {
        return Inbound::Other;
    }
    match serde_json::from_slice::<serde_json::Value>(frame) {
        Ok(value) => match (value.get("ping").and_then(serde_json::Value::as_u64), value.get("pong")) {
            (Some(seq), _) => Inbound::Ping(seq),
            (None, Some(_)) => Inbound::Pong,
            _ => Inbound::Other,
        },
        Err(_) => Inbound::Other,
    }
}

/// Whether the peer owes us a sign of life, and whether it has run out of time.
struct Liveness {
    last_input: Instant,
    last_ping: Option<Instant>,
    seq: u64,
    // The deadline is armed only once the peer has answered a ping. A broker too
    // old to know the frame would otherwise be disconnected every twenty seconds
    // for speaking the protocol it was built against, so an unanswering peer
    // degrades to the previous behaviour instead of being killed.
    armed: bool,
}

enum Due {
    Nothing,
    Ping(u64),
    Dead,
}

impl Liveness {
    fn new() -> Self {
        Liveness { last_input: Instant::now(), last_ping: None, seq: 0, armed: false }
    }

    fn saw_input(&mut self) {
        self.last_input = Instant::now();
        self.last_ping = None;
    }

    fn saw_pong(&mut self) {
        self.armed = true;
        self.saw_input();
    }

    fn due(&mut self) -> Due {
        let silent = self.last_input.elapsed();
        if self.armed && silent >= LIVENESS_TIMEOUT {
            return Due::Dead;
        }
        if silent < PING_AFTER {
            return Due::Nothing;
        }
        // One ping per interval rather than one per idle pass, so a peer that is
        // merely quiet is asked a handful of times before the deadline, not
        // thousands.
        if self.last_ping.is_some_and(|sent| sent.elapsed() < PING_AFTER) {
            return Due::Nothing;
        }
        self.seq += 1;
        self.last_ping = Some(Instant::now());
        Due::Ping(self.seq)
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
    // Raw pre-framed payloads the reader needs written: only one thread may write
    // the pipe, so a pong the reader owes goes through the writer like everything
    // else. Separate from local_tx because a pong is not a Response.
    let (raw_tx, raw_rx) = crossbeam_channel::unbounded::<Vec<u8>>();
    // Liveness state the reader observes and the writer acts on, since the read
    // and write halves are on different threads here.
    let last_input = Arc::new(AtomicU64::new(0));
    let armed = Arc::new(AtomicBool::new(false));
    let epoch = Instant::now();

    let reader = {
        let inbound_tx = inbound_tx.clone();
        let stop = Arc::clone(stop);
        let reader_done = Arc::clone(&reader_done);
        let last_input = Arc::clone(&last_input);
        let armed = Arc::clone(&armed);
        thread::Builder::new()
            .name("conduit-ipc-read".to_string())
            .spawn(move || {
                let mut decoder = FrameDecoder::new();
                let mut read_buf = [0u8; 8192];
                'outer: while !stop.load(Ordering::SeqCst) {
                    match recv.read(&mut read_buf) {
                        Ok(0) => break,
                        Ok(n) => {
                            last_input.store(epoch.elapsed().as_millis() as u64, Ordering::Relaxed);
                            decoder.push(&read_buf[..n]);
                            loop {
                                match decoder.next_frame() {
                                    Ok(Some(frame)) => {
                                        match classify_inbound(&frame) {
                                            Inbound::Ping(seq) => {
                                                if raw_tx.send(pong_payload(seq)).is_err() {
                                                    break 'outer;
                                                }
                                            }
                                            Inbound::Pong => armed.store(true, Ordering::Relaxed),
                                            Inbound::Other => {
                                                if !route_inbound_frame(&frame, &inbound_tx, &local_tx) {
                                                    break 'outer;
                                                }
                                            }
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
    let mut last_ping: Option<Instant> = None;
    let mut ping_seq = 0u64;
    while !stop.load(Ordering::SeqCst) {
        let mut did_work = false;
        let mut broken = false;

        while let Ok(payload) = raw_rx.try_recv() {
            did_work = true;
            if write_frame(&mut send, &payload).is_err() {
                broken = true;
                break;
            }
        }

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
        if reader_done.load(Ordering::SeqCst)
            && raw_rx.is_empty()
            && local_rx.is_empty()
            && outbound_rx.is_empty()
            && event_rx.is_empty()
        {
            break;
        }
        if !did_work {
            // Same liveness contract as serve_nonblocking, split across the two
            // threads: the reader stamps inbound, this thread asks and decides.
            let silent = epoch.elapsed().saturating_sub(Duration::from_millis(last_input.load(Ordering::Relaxed)));
            if armed.load(Ordering::Relaxed) && silent >= LIVENESS_TIMEOUT {
                eprintln!(
                    "conduit: broker silent for {}s, dropping the connection so another can attach",
                    LIVENESS_TIMEOUT.as_secs()
                );
                break;
            }
            if silent >= PING_AFTER && !last_ping.is_some_and(|sent| sent.elapsed() < PING_AFTER) {
                ping_seq += 1;
                last_ping = Some(Instant::now());
                if write_frame(&mut send, &ping_payload(ping_seq)).is_err() {
                    break;
                }
                continue;
            }
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
    // A peer that stops reading is as dead to us as one that closed, and without
    // a deadline the WouldBlock retry below spins until the process exits: the
    // serve function never returns, so the accept slot is never freed and no
    // other broker can ever attach. The clock starts on the first stall and is
    // reset by any progress, so a slow but live peer is not penalised for the
    // size of the frame.
    let mut stalled_since: Option<Instant> = None;
    while written < framed.len() {
        if stop.load(Ordering::SeqCst) {
            return Err(std::io::Error::new(ErrorKind::Interrupted, "listener stopping"));
        }
        match stream.write(&framed[written..]) {
            Ok(0) => return Err(std::io::Error::new(ErrorKind::WriteZero, "socket closed")),
            Ok(n) => {
                written += n;
                stalled_since = None;
            }
            Err(err) if err.kind() == ErrorKind::WouldBlock => {
                let since = stalled_since.get_or_insert_with(Instant::now);
                if since.elapsed() >= WRITE_STALL_TIMEOUT {
                    return Err(std::io::Error::new(
                        ErrorKind::TimedOut,
                        "peer stopped reading; abandoning the frame and the connection",
                    ));
                }
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

    /// Serialises the tests that mutate the transport environment.
    ///
    /// Environment variables are process-global and cargo runs tests in parallel
    /// threads of one process, so two tests each setting CONDUIT_SOCK will
    /// interleave: one overwrites the other's value between its set and its
    /// read, and the assertion fails on whichever platform lost the race that
    /// run. This is the lock that stops that being a coin flip.
    static ENV_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

    /// Save and clear the transport env vars, run `body`, then restore them, so a
    /// developer's ambient CONDUIT_SOCK/CONDUIT_TCP cannot flip the transport the
    /// test asserts. `set_var`/`remove_var` are unsafe in edition 2024 because
    /// they mutate shared process state; these are the only tests touching them.
    fn with_native_transport(body: impl FnOnce()) {
        // Poisoning only means an earlier test panicked while holding this; the
        // guarded state is the environment, which is restored below either way.
        let _guard = ENV_LOCK.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
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

    /// Liveness over loopback TCP, which every platform can run, so the Unix
    /// socket and Windows pipe transports are covered by the same assertions
    /// through the shared serve model.
    mod liveness {
        use super::*;
        use crate::protocol::FrameDecoder;
        use crate::transport::status::LinkState;
        use std::net::TcpStream;

        struct Harness {
            _listener: Listener,
            status: LinkStatus,
            addr: SocketAddr,
            // Held so the channels stay open for the listener's lifetime.
            _inbound_rx: Receiver<Command>,
            _outbound_tx: Sender<Response>,
            event_tx: Sender<Vec<u8>>,
        }

        fn hello_bytes() -> Vec<u8> {
            crate::protocol::Hello {
                role: "editor".into(),
                protocol_version: crate::protocol::PROTOCOL_VERSION,
                bridge_version: "0.0.0".into(),
                engine_version: "4.4.0".into(),
                project_path: "/tmp/project".into(),
                pid: 1,
            }
            .to_frame_payload()
        }

        /// Bind and release a port so the listener under test gets one nothing
        /// else is on. A racy pick is still better than a fixed port, which two
        /// concurrent cargo test threads would collide on every run.
        fn free_port() -> u16 {
            let probe = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).expect("probe bind");
            probe.local_addr().expect("probe addr").port()
        }

        fn start() -> Harness {
            let addr = SocketAddr::from((Ipv4Addr::LOCALHOST, free_port()));
            let (inbound_tx, _inbound_rx) = crossbeam_channel::bounded::<Command>(16);
            let (_outbound_tx, outbound_rx) = crossbeam_channel::unbounded::<Response>();
            let (event_tx, event_rx) = crossbeam_channel::unbounded::<Vec<u8>>();
            let status = LinkStatus::default();
            let listener = Listener::spawn(
                Endpoint { display: addr.to_string(), kind: EndpointKind::Tcp(addr) },
                hello_bytes(),
                inbound_tx,
                outbound_rx,
                event_rx,
                status.clone(),
            )
            .expect("listener binds");
            Harness { _listener: listener, status, addr, _inbound_rx, _outbound_tx, event_tx }
        }

        /// Connect and consume the hello, leaving the stream positioned on the
        /// first frame the bridge sends afterwards.
        fn connect_and_greet(addr: SocketAddr) -> (TcpStream, FrameDecoder) {
            let mut stream = TcpStream::connect(addr).expect("connect");
            stream.set_read_timeout(Some(Duration::from_secs(5))).expect("read timeout");
            let mut decoder = FrameDecoder::new();
            let mut buf = [0u8; 4096];
            loop {
                if let Ok(Some(frame)) = decoder.next_frame() {
                    let value: serde_json::Value = serde_json::from_slice(&frame).expect("json frame");
                    assert!(value.get("hello").is_some(), "first frame should be the hello: {value}");
                    return (stream, decoder);
                }
                let n = stream.read(&mut buf).expect("read hello");
                assert_ne!(n, 0, "closed before hello");
                decoder.push(&buf[..n]);
            }
        }

        fn wait_for_state(status: &LinkStatus, want: LinkState, within: Duration) -> bool {
            let deadline = Instant::now() + within;
            while Instant::now() < deadline {
                if status.snapshot().state == want {
                    return true;
                }
                thread::sleep(Duration::from_millis(10));
            }
            status.snapshot().state == want
        }

        #[test]
        fn a_peer_that_stops_answering_is_dropped_and_the_slot_is_freed() {
            // The reported failure: the socket stays open, so no EOF ever
            // arrives, and without liveness the bridge stays Connected forever
            // and no second broker can ever attach.
            let h = start();
            let (mut client, mut decoder) = connect_and_greet(h.addr);
            assert!(wait_for_state(&h.status, LinkState::Connected, Duration::from_secs(2)));

            // Answer exactly one ping. That arms the deadline, proving the peer
            // does speak the protocol, and then we go silent while holding the
            // socket open.
            let mut buf = [0u8; 4096];
            let mut answered = false;
            let deadline = Instant::now() + Duration::from_secs(5);
            while !answered && Instant::now() < deadline {
                if let Ok(Some(frame)) = decoder.next_frame() {
                    let value: serde_json::Value = serde_json::from_slice(&frame).expect("json frame");
                    if let Some(seq) = value.get("ping").and_then(serde_json::Value::as_u64) {
                        crate::protocol::write_frame(&mut client, &crate::protocol::pong_payload(seq))
                            .expect("write pong");
                        answered = true;
                    }
                    continue;
                }
                let n = client.read(&mut buf).expect("read ping");
                assert_ne!(n, 0, "closed before pinging");
                decoder.push(&buf[..n]);
            }
            assert!(answered, "the bridge never pinged a silent peer");

            assert!(
                wait_for_state(&h.status, LinkState::Listening, LIVENESS_TIMEOUT * 4),
                "a silent peer should be dropped, leaving the listener free"
            );

            // The property that actually matters: the accept slot is usable
            // again. A bridge serves one client at a time, so a link wrongly
            // held Connected locks every future broker out.
            let (_second, _) = connect_and_greet(h.addr);
            assert!(wait_for_state(&h.status, LinkState::Connected, Duration::from_secs(2)));
            drop(client);
        }

        #[test]
        fn a_peer_that_never_answers_a_ping_is_left_alone() {
            // Compatibility rule: a broker too old to know the frame must not be
            // disconnected every LIVENESS_TIMEOUT for speaking the protocol it
            // was built against. The deadline arms only after a pong.
            let h = start();
            let (client, _decoder) = connect_and_greet(h.addr);
            assert!(wait_for_state(&h.status, LinkState::Connected, Duration::from_secs(2)));

            thread::sleep(LIVENESS_TIMEOUT * 3);
            assert_eq!(
                h.status.snapshot().state,
                LinkState::Connected,
                "a peer that never pongs should stay connected, not be killed for silence"
            );
            drop(client);
        }

        #[test]
        fn a_peer_that_stops_reading_does_not_pin_the_io_thread() {
            // The write-side half of the same problem. Without a deadline on the
            // WouldBlock retry, filling the socket buffer parks the IO thread
            // inside one frame forever, so the serve function never returns and
            // mark_listening is never reached.
            let h = start();
            let (client, _decoder) = connect_and_greet(h.addr);
            assert!(wait_for_state(&h.status, LinkState::Connected, Duration::from_secs(2)));

            // Never read again, and give the bridge far more than any socket
            // buffer can hold.
            let payload = vec![b'x'; 1024 * 1024];
            for _ in 0..64 {
                h.event_tx.send(payload.clone()).expect("queue event");
            }

            assert!(
                wait_for_state(&h.status, LinkState::Listening, WRITE_STALL_TIMEOUT * 8),
                "a peer that stopped reading should be dropped, not pin the IO thread"
            );
            drop(client);
        }
    }
}
