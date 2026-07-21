//! Editor-bridge handlers (whitepaper section 8, project and session). These run
//! only in the editor process; the game-lifecycle tools here are what bring the
//! game bridge online.

pub mod assets;
pub mod editor_state;
pub mod files;
pub mod play;
pub mod project;
pub mod resource;
pub mod scene;
pub mod script;
pub mod support;
