// Bun parses TOML imports natively (used for the workspace Cargo.toml, the
// single source of the project version); this declares the module shape for tsc.
declare module "*.toml" {
  const value: Record<string, any>;
  export default value;
}
