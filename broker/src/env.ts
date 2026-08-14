// Environment-variable parsing shared by the broker's configuration sites.
//
// A plain `!!process.env.X` treats "0" and "false" as on, which is the opposite
// of what anyone writing CONDUIT_DISABLE_EVAL=0 into an MCP client config
// intends. Every CONDUIT_ boolean goes through envFlag so the whole surface
// agrees on what off means (docs/environment.md).

const OFF_VALUES = new Set(["", "0", "false", "no", "off"]);

/** Whether a boolean environment variable is set to something meaning on. */
export function envFlag(value: string | undefined): boolean {
  if (value === undefined) {
    return false;
  }
  return !OFF_VALUES.has(value.trim().toLowerCase());
}
