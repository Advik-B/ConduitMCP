# Conduit

Native in-process MCP bridge for full agentic control of the Godot engine. A Rust GDExtension ("bridge") loads into the editor and game processes; a thin TypeScript stdio server ("broker") aggregates both over local IPC and speaks MCP to the client.

## Source of truth

The complete design is in `docs/conduit-whitepaper.md` (v0.2). Read it before writing code. Appendix D contains working instructions addressed to you specifically; follow them. When this document and your prior knowledge of Godot or gdext disagree, the document wins, then verify the specific API against https://godot-rust.github.io/docs/gdext/master/godot/ because both Godot and gdext change between releases.

Target: Godot 4.4+, gdext (godot crate), Node 20+ for the broker.

## Phase discipline

The roadmap (whitepaper section 10) has six phases, each with an acceptance criterion. Work on exactly one phase per session unless told otherwise. A phase is done when its acceptance criterion passes as an automated or scripted check, not when the code compiles. Do not begin phase N+1 in the same session that finished phase N; stop and report instead.

Phase 1 is small but load-bearing: the threading proof (bounded queue, main-thread drain, deferred completion for await) must be demonstrated with the stress test before anything else is built on it.

## Safety properties, not features

- The bridge listener must never bind in a release build. Write the `OS::has_feature` guard and the explicit opt-in check (`--conduit` user arg or `CONDUIT_ENABLE`) before writing the listener itself, and keep the test that asserts the listener does not bind in a simulated release context.
- `gd_game_eval` and pixel tools ship behind flags exactly as section 9 specifies. Do not weaken defaults for convenience during development; use the flags.

## Workspace layout

Follow whitepaper section 11 exactly (`bridge/` Rust cdylib, `broker/` TypeScript, `example-project/` for integration tests). Do not invent a different layout. An empty `.gdignore` in `bridge/` keeps Godot from importing Rust sources.

## Build and test

- Bridge: `cargo build` in `bridge/`, `cargo test` for unit tests, `cargo clippy -- -D warnings` before declaring work done.
- Broker: `npm ci` and `npm test` in `broker/`.
- Integration tests launch Godot headless against `example-project/`; the Godot binary path comes from `GODOT_BIN`. If it is unset, ask rather than guessing.
- Cross-platform: the project builds and its acceptance runners pass on Windows, macOS, and Linux. The broker-to-bridge transport is per-OS (Unix socket, Windows named pipe, opt-in loopback TCP) and the eval runners go through `tests/evals/harness.ts` for all host-specific behaviour (display, process cleanup, endpoint discovery). Display tooling (Xvfb) is Linux-only; Windows and macOS render natively. Platform specifics are in `docs/api-gaps.md`.

## Code style

- No emojis anywhere: code, comments, strings, identifiers, commit messages.
- No ASCII art, decorative separators, banners, or comment borders (no repeated `=`, `-`, `*`).
- Comments minimal, plain, functional. Explain why, not what.
- Shell commands single-line, no backslash continuations.
- Rust: idiomatic, `thiserror` for error types, no `unwrap` outside tests; every handler returns the structured error model of whitepaper section 7.4.
- TypeScript: strict mode, zod for schema validation at the MCP boundary.

## When stuck

If an API the whitepaper assumes is missing or renamed in the gdext version in use, fall back to dynamic `call` invocation and record the gap in `docs/api-gaps.md` rather than abandoning the approach or silently substituting a different design.
