//! Game-bridge runtime handlers (whitepaper section 6.6). Every handler here
//! runs on the main thread inside `_process` and reaches the engine through
//! global singletons; none is registered in the engine-free `phase1` registry.

pub mod eval;
pub mod inspect;
pub mod mutate;
pub mod signals;
pub mod support;
