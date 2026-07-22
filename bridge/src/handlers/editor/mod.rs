//! Editor-bridge handlers (whitepaper section 8, project and session). These run
//! only in the editor process; the game-lifecycle tools here are what bring the
//! game bridge online.

pub mod assets;
pub mod autoload;
pub mod collab;
pub mod debug;
pub mod editor_state;
pub mod eval;
pub mod files;
pub mod import_export;
pub mod input_map;
pub mod pixel;
pub mod play;
pub mod project;
pub mod properties;
pub mod query;
pub mod resource;
pub mod scene;
pub mod script;
pub mod support;
pub mod ui;
pub mod wiring;
