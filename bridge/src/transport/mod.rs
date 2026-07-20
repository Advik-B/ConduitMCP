//! Transport layer: bounded queues between the IO thread and the main thread,
//! and the local-socket listener that carries the command protocol.

pub mod channels;
pub mod ipc;
