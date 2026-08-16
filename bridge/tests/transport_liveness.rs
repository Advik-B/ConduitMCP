//! Liveness over each platform's real transport, with no Godot involved.
//!
//! The unit tests in `transport::ipc` cover the same properties over loopback
//! TCP, which every platform can run but which reaches only one of the two serve
//! models: `accept_loop_tcp` into `serve_nonblocking`. On Windows the shipping
//! transport is a named pipe served by `accept_loop_pipe` into `serve_split`, a
//! separate implementation with its own reader/writer split and its own copy of
//! the heartbeat, and nothing else in the repository binds a pipe from a test.
//! This file is what covers it, by resolving whatever endpoint the platform
//! actually uses and driving it end to end.
//!
//! Unlike the unit tests, this links the normal library build, so the
//! `#[cfg(test)]` timing overrides do not apply and the shipped five-second ping
//! and twenty-second deadline are what run. That is deliberate: it is the one
//! place the real constants are exercised, and it costs about half a minute.

use std::io::Read;
use std::time::{Duration, Instant};

use conduit::protocol::{pong_payload, write_frame, FrameDecoder, Hello, PROTOCOL_VERSION};
use conduit::transport::channels::CommandChannels;
use conduit::transport::ipc::{endpoint, Listener, Role};
use conduit::transport::status::{LinkState, LinkStatus};

use interprocess::local_socket::traits::Stream as _;
#[cfg(windows)]
use interprocess::local_socket::{GenericNamespaced, ToNsName};
#[cfg(unix)]
use interprocess::local_socket::{GenericFilePath, ToFsName};
use interprocess::local_socket::Stream;

/// Generous next to the twenty-second deadline, so a loaded CI runner cannot
/// fail this by being slow, while still bounding a hang.
const SETTLE: Duration = Duration::from_secs(90);

fn hello_bytes() -> Vec<u8> {
    Hello {
        role: "game".into(),
        protocol_version: PROTOCOL_VERSION,
        bridge_version: "0.0.0".into(),
        engine_version: "4.4.0".into(),
        project_path: "/tmp/conduit-transport-test".into(),
        pid: std::process::id(),
    }
    .to_frame_payload()
}

/// The loopback fallback would silently retarget these at the very serve model
/// this file exists to avoid, so it is cleared once for the process. Cargo runs
/// these tests as parallel threads of one process, hence `Once` rather than a
/// per-test call: `remove_var` mutates shared state and is only sound before the
/// threads start racing on it.
static CLEAR_TCP: std::sync::Once = std::sync::Once::new();

struct Harness {
    listener: Listener,
    status: LinkStatus,
    display: String,
    _channels: CommandChannels,
}

/// Bind a listener on an endpoint unique to `key`.
///
/// The key must differ per test. Endpoints are derived from a hash of the
/// project path, and `Listener::spawn` unlinks a stale socket file before
/// binding, so two tests sharing a path would have the second one pull the
/// first one's live socket out from under it. Cargo runs them in parallel
/// threads of one process, so the pid in a game token does not separate them.
fn start(key: &str) -> Harness {
    CLEAR_TCP.call_once(|| unsafe {
        std::env::remove_var("CONDUIT_TCP");
    });

    // Role::Game, not Editor: game endpoints ignore the CONDUIT_SOCK override, so
    // an ambient variable cannot hijack this into a shared endpoint.
    let ep = endpoint(Role::Game, &format!("/tmp/conduit-transport-test/{key}"));
    let display = ep.display().to_string();
    let channels = CommandChannels::default();
    let status = LinkStatus::default();
    let listener = Listener::spawn(
        ep,
        hello_bytes(),
        channels.inbound_tx.clone(),
        channels.outbound_rx.clone(),
        channels.event_rx.clone(),
        status.clone(),
    )
    .expect("listener binds the native endpoint");
    Harness { listener, status, display, _channels: channels }
}

/// Connect over the same local-socket API the bridge binds with, which is the
/// only one that reaches a Windows pipe.
fn connect(display: &str) -> Stream {
    #[cfg(windows)]
    {
        let bare = display.strip_prefix("\\\\.\\pipe\\").unwrap_or(display);
        let name = bare.to_ns_name::<GenericNamespaced>().expect("pipe name");
        Stream::connect(name).expect("connect to the named pipe")
    }
    #[cfg(unix)]
    {
        let name = display.to_fs_name::<GenericFilePath>().expect("socket path");
        Stream::connect(name).expect("connect to the unix socket")
    }
}

/// Read frames until `want` returns Some, or the deadline passes.
fn read_until<T>(
    stream: &mut Stream,
    decoder: &mut FrameDecoder,
    within: Duration,
    mut want: impl FnMut(&serde_json::Value) -> Option<T>,
) -> Option<T> {
    let deadline = Instant::now() + within;
    let mut buf = [0u8; 8192];
    while Instant::now() < deadline {
        while let Ok(Some(frame)) = decoder.next_frame() {
            if let Ok(value) = serde_json::from_slice::<serde_json::Value>(&frame)
                && let Some(found) = want(&value)
            {
                return Some(found);
            }
        }
        match stream.read(&mut buf) {
            Ok(0) => return None,
            Ok(n) => decoder.push(&buf[..n]),
            Err(_) => return None,
        }
    }
    None
}

fn wait_for_state(status: &LinkStatus, want: LinkState, within: Duration) -> bool {
    let deadline = Instant::now() + within;
    while Instant::now() < deadline {
        if status.snapshot().state == want {
            return true;
        }
        std::thread::sleep(Duration::from_millis(50));
    }
    status.snapshot().state == want
}

#[test]
fn the_endpoint_under_test_is_the_platform_native_one() {
    // Guards the whole file: if this ever resolves to TCP, every assertion below
    // silently stops covering the serve model it was written for.
    let h = start("native-shape");
    #[cfg(windows)]
    assert!(h.display.starts_with("\\\\.\\pipe\\"), "expected a named pipe, got {}", h.display);
    #[cfg(unix)]
    assert!(h.display.ends_with(".sock"), "expected a unix socket, got {}", h.display);
    drop(h);
}

#[test]
fn a_silent_peer_is_dropped_and_the_listener_serves_the_next_one() {
    let mut h = start("silent-peer");

    let mut client = connect(&h.display);
    let mut decoder = FrameDecoder::new();
    let greeted = read_until(&mut client, &mut decoder, SETTLE, |value| value.get("hello").map(|_| ()));
    assert!(greeted.is_some(), "no hello frame over {}", h.display);
    assert!(wait_for_state(&h.status, LinkState::Connected, SETTLE));

    // Answer exactly one ping. That proves the peer speaks the protocol, which
    // is what arms the deadline, and then it goes quiet while still holding the
    // connection open, so no close is ever reported.
    let seq = read_until(&mut client, &mut decoder, SETTLE, |value| {
        value.get("ping").and_then(serde_json::Value::as_u64)
    });
    let seq = seq.expect("the bridge should ping a silent peer");
    write_frame(&mut client, &pong_payload(seq)).expect("write pong");

    assert!(
        wait_for_state(&h.status, LinkState::Listening, SETTLE),
        "a peer that stopped answering should be dropped"
    );

    // The property the one-client-at-a-time listener makes critical: the accept
    // slot is usable again. Holding a dead link locks every future broker out.
    let mut second = connect(&h.display);
    let mut second_decoder = FrameDecoder::new();
    let greeted_again = read_until(&mut second, &mut second_decoder, SETTLE, |value| value.get("hello").map(|_| ()));
    assert!(greeted_again.is_some(), "the listener did not serve a second client");
    assert!(wait_for_state(&h.status, LinkState::Connected, SETTLE));

    drop(client);
    drop(second);
    h.listener.stop();
}

#[test]
fn a_peer_that_never_answers_a_ping_keeps_its_connection() {
    // Compatibility rule: the deadline arms only after a pong, so a broker too
    // old to know the frame is not disconnected every twenty seconds for
    // speaking the protocol it was built against.
    let mut h = start("never-pongs");

    let mut client = connect(&h.display);
    let mut decoder = FrameDecoder::new();
    assert!(read_until(&mut client, &mut decoder, SETTLE, |v| v.get("hello").map(|_| ())).is_some());
    assert!(wait_for_state(&h.status, LinkState::Connected, SETTLE));

    // Read and discard whatever arrives, answering nothing, for comfortably
    // longer than the deadline would be if it were armed.
    let until = Instant::now() + Duration::from_secs(30);
    let mut buf = [0u8; 8192];
    while Instant::now() < until {
        match client.read(&mut buf) {
            Ok(0) => break,
            Ok(_) => {}
            Err(_) => break,
        }
    }

    assert_eq!(
        h.status.snapshot().state,
        LinkState::Connected,
        "a peer that never pongs should stay connected, not be killed for silence"
    );

    drop(client);
    h.listener.stop();
}
