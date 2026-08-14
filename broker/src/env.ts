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

/**
 * A positive integer environment variable. Throws rather than falling back on a
 * malformed value: a timeout that silently reverts to its default because
 * someone wrote "10s" is worse than a startup error naming the variable.
 */
export function envInt(name: string, value: string | undefined): number | undefined {
  if (value === undefined || value.trim() === "") {
    return undefined;
  }
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} expects a positive integer, got "${value}"`);
  }
  return parsed;
}
