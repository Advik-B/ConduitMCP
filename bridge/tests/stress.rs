//! Engine-free threading proof for phase 1 (whitepaper section 6.4, section 10
//! acceptance). Background threads flood the bounded inbound queue while a
//! simulated main loop drains it under the per-frame budget. Asserts:
//!
//!   - the queue never exceeds its bound (backpressure, not unbounded growth);
//!   - a flood produces `busy` rejections rather than memory growth;
//!   - every command is answered exactly once, accepted xor busy, ids correlated;
//!   - per-frame work stays within the drain budget (editor stays responsive);
//!   - one `gd_wait_frames` submitted amid the flood completes via deferred
//!     resolution exactly N frames later.
//!
//! This runs under plain `cargo test` with no Godot instance, isolating the
//! dispatcher so a threading bug surfaces here before any engine is involved.

use std::collections::HashSet;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;
use std::thread;
use std::time::{Duration, Instant};

use conduit::dispatcher::{Dispatcher, DrainBudget};
use conduit::handlers::HandlerRegistry;
use conduit::protocol::Command;
use conduit::transport::channels::CommandChannels;

use crossbeam_channel::TrySendError;
use serde_json::json;

const INBOUND_CAPACITY: usize = 256;
const PRODUCERS: u64 = 4;
const PER_PRODUCER: u64 = 15_000;
const WAIT_ID: u64 = u64::MAX;
const WAIT_FRAMES: u64 = 30;
const FRAME_CAP: u64 = 2_000_000;

#[test]
fn flood_stays_bounded_and_deferred_completion_survives() {
    let channels = CommandChannels::new(INBOUND_CAPACITY);
    let budget = DrainBudget::default();
    let mut dispatcher = Dispatcher::new(HandlerRegistry::phase1(), budget);

    // Submit the await-style command first, with a blocking send so it is
    // guaranteed accepted, then flood around it. It must complete exactly
    // WAIT_FRAMES frames after it is drained despite the flood.
    channels
        .inbound_tx
        .send(Command { id: WAIT_ID, tool: "gd_wait_frames".into(), args: json!({ "frames": WAIT_FRAMES }) })
        .expect("wait command accepted");

    let running = Arc::new(AtomicUsize::new(PRODUCERS as usize));
    let mut producer_handles = Vec::new();
    for p in 0..PRODUCERS {
        let tx = channels.inbound_tx.clone();
        let running = Arc::clone(&running);
        let handle = thread::spawn(move || {
            let mut accepted = Vec::new();
            let mut busy = Vec::new();
            let base = p * PER_PRODUCER;
            for offset in 0..PER_PRODUCER {
                let id = base + offset;
                let command = Command { id, tool: "gd_ping".into(), args: json!({}) };
                // Single-shot: a full queue is recorded as busy (as the IO
                // thread would answer) rather than retried, which is what
                // generates backpressure under load.
                match tx.try_send(command) {
                    Ok(()) => accepted.push(id),
                    Err(TrySendError::Full(cmd)) => busy.push(cmd.id),
                    Err(TrySendError::Disconnected(cmd)) => busy.push(cmd.id),
                }
            }
            running.fetch_sub(1, Ordering::SeqCst);
            (accepted, busy)
        });
        producer_handles.push(handle);
    }

    let mut frames = 0u64;
    let mut max_queue_len = 0usize;
    let loop_start = Instant::now();
    loop {
        // Throttle the consumer slightly so producers overflow the bound and
        // the busy path is genuinely exercised, mimicking real frame pacing.
        thread::sleep(Duration::from_micros(100));

        let queue_len = channels.inbound_rx.len();
        if queue_len > max_queue_len {
            max_queue_len = queue_len;
        }
        assert!(queue_len <= INBOUND_CAPACITY, "inbound queue exceeded its bound: {queue_len}");

        dispatcher.run_frame(&channels.inbound_rx, &channels.outbound_tx, 16.6);
        frames += 1;

        let done = running.load(Ordering::SeqCst) == 0
            && channels.inbound_rx.is_empty()
            && dispatcher.pending_count() == 0;
        if done {
            break;
        }
        assert!(frames < FRAME_CAP, "consumer did not converge within frame cap");
    }
    let wall = loop_start.elapsed();

    let mut accepted_ids: HashSet<u64> = HashSet::new();
    let mut busy_ids: HashSet<u64> = HashSet::new();
    for handle in producer_handles {
        let (accepted, busy) = handle.join().expect("producer joined");
        for id in accepted {
            assert!(accepted_ids.insert(id), "producer reported duplicate accepted id {id}");
        }
        for id in busy {
            assert!(busy_ids.insert(id), "producer reported duplicate busy id {id}");
        }
    }

    // Collect every response and verify exact, once-only id correlation.
    let mut answered: HashSet<u64> = HashSet::new();
    let mut wait_result = None;
    while let Ok(response) = channels.outbound_rx.try_recv() {
        assert!(answered.insert(response.id), "id {} answered more than once", response.id);
        if response.id == WAIT_ID {
            wait_result = Some(response.result.clone().expect("wait result present"));
        }
    }

    let total_sent = PRODUCERS * PER_PRODUCER;
    let metrics = dispatcher.metrics();

    // Accounting: accepted and busy partition the sent ids exactly.
    assert!(accepted_ids.is_disjoint(&busy_ids), "an id was both accepted and busy");
    assert_eq!(
        accepted_ids.len() as u64 + busy_ids.len() as u64,
        total_sent,
        "accepted + busy must equal total sent"
    );

    // Backpressure genuinely engaged.
    assert!(!busy_ids.is_empty(), "flood produced no busy rejections; backpressure not exercised");

    // Every accepted ping was answered exactly once, plus the wait command.
    for id in &accepted_ids {
        assert!(answered.contains(id), "accepted id {id} was never answered");
    }
    assert!(answered.contains(&WAIT_ID), "wait command was never answered");
    assert_eq!(answered.len(), accepted_ids.len() + 1, "answered set does not match accepted set + wait");

    // Per-frame work stayed within the budget: responsiveness proof.
    assert!(
        metrics.max_commands_in_frame <= budget.max_commands,
        "a frame drained {} commands, over the budget of {}",
        metrics.max_commands_in_frame,
        budget.max_commands
    );

    // Deferred completion: the wait command settled exactly WAIT_FRAMES frames
    // after it was drained.
    let wait = wait_result.expect("wait command produced a result");
    let submitted = wait["submitted_frame"].as_u64().unwrap();
    let completed = wait["completed_frame"].as_u64().unwrap();
    assert_eq!(completed - submitted, WAIT_FRAMES, "deferred completion did not span exactly N frames");

    eprintln!("stress summary:");
    eprintln!("  total sent          : {total_sent}");
    eprintln!("  accepted (answered) : {}", accepted_ids.len());
    eprintln!("  busy (rejected)     : {}", busy_ids.len());
    eprintln!("  inbound capacity    : {INBOUND_CAPACITY}");
    eprintln!("  max queue observed  : {max_queue_len}");
    eprintln!("  frames run          : {frames}");
    eprintln!("  max cmds / frame    : {} (budget {})", metrics.max_commands_in_frame, budget.max_commands);
    eprintln!("  max drain time      : {} us (budget {} ms)", metrics.max_drain_micros, budget.max_duration.as_millis());
    eprintln!("  deferred completed  : {} (wait spanned {} frames)", metrics.deferred_completed, completed - submitted);
    eprintln!("  wall time           : {} ms", wall.as_millis());
}
