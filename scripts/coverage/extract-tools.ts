// Dumps the broker's registered MCP tool surface without starting a broker.
//
// The trick is the one broker/tests/tools.test.ts already uses: registerTools
// only ever touches server.registerTool, so a fake McpServer that records its
// arguments yields the whole surface -- names, descriptions, annotations, and
// the raw zod input shapes -- offline and in-process.

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import type { BridgeManager } from "../../broker/src/bridge-manager.ts";
import type { EventRing } from "../../broker/src/events.ts";
import { GodotResolver } from "../../broker/src/godot-locate.ts";
import { registerTools } from "../../broker/src/index.ts";
import { DEFAULT_TIMEOUTS } from "../../broker/src/tool-helpers.ts";
import { TOOL_GROUP_BY_NAME, type ToolGroup } from "../../broker/src/tool-registry.ts";

export interface ParamRecord {
  name: string;
  kind: string;
  optional: boolean;
  description: string | null;
  /** Present for z.enum fields; this is what makes a (tool, op) capability. */
  values: string[] | null;
}

export interface ToolRecord {
  name: string;
  group: ToolGroup;
  description: string;
  annotations: Record<string, unknown>;
  params: ParamRecord[];
  /** Enumerated values of the discriminator field, when the tool has one. */
  ops: string[];
}

export interface SurfaceFlags {
  enablePixelTools: boolean;
  enableEditorEval: boolean;
  disableEval: boolean;
}

export const MAXIMAL_FLAGS: SurfaceFlags = {
  enablePixelTools: true,
  enableEditorEval: true,
  disableEval: false,
};

export const DEFAULT_FLAGS: SurfaceFlags = {
  enablePixelTools: false,
  enableEditorEval: false,
  disableEval: false,
};

/**
 * Unwrap optional/nullable/default wrappers down to the schema that carries the
 * type. Zod 4 exposes the wrapper kind on _def.type and the inner schema through
 * unwrap(), so this stays a loop rather than a per-wrapper special case.
 */
function unwrap(schema: unknown): { inner: unknown; optional: boolean } {
  let current = schema;
  let optional = false;
  for (let depth = 0; depth < 8; depth += 1) {
    const def = (current as { _def?: { type?: string } })?._def;
    const kind = def?.type;
    if (kind !== "optional" && kind !== "nullable" && kind !== "default") break;
    if (kind === "optional" || kind === "default") optional = true;
    const unwrapper = (current as { unwrap?: () => unknown }).unwrap;
    if (typeof unwrapper !== "function") break;
    current = unwrapper.call(current);
  }
  return { inner: current, optional };
}

function describeParam(name: string, schema: unknown): ParamRecord {
  const { inner, optional } = unwrap(schema);
  const kind = (inner as { _def?: { type?: string } })?._def?.type ?? "unknown";
  const values = (inner as { options?: unknown }).options;
  return {
    name,
    kind,
    optional,
    description: (schema as { description?: string }).description ?? null,
    values: Array.isArray(values) ? values.map((value) => String(value)) : null,
  };
}

/**
 * The discriminator is the field an agent picks a behaviour with. `op` is the
 * whitepaper's convention (section 7.1); gd_editor_set_main_screen and friends
 * enumerate on `name`, so a single enum field with no `op` counts too.
 */
function discriminator(params: ParamRecord[]): string[] {
  const op = params.find((param) => param.name === "op");
  if (op?.values) return op.values;
  const enums = params.filter((param) => param.values && !param.optional);
  if (enums.length === 1 && enums[0]?.values) return enums[0].values;
  return [];
}

export function collectToolSurface(flags: SurfaceFlags = MAXIMAL_FLAGS): ToolRecord[] {
  const records: ToolRecord[] = [];
  const server = {
    registerTool(
      name: string,
      config: { description?: string; inputSchema?: Record<string, unknown>; annotations?: Record<string, unknown> },
    ) {
      const params = Object.entries(config.inputSchema ?? {}).map(([key, schema]) => describeParam(key, schema));
      records.push({
        name,
        group: TOOL_GROUP_BY_NAME[name] ?? "core",
        description: config.description ?? "",
        annotations: config.annotations ?? {},
        params,
        ops: discriminator(params),
      });
      return { remove() {} };
    },
  } as unknown as McpServer;

  registerTools(server, {} as unknown as BridgeManager, {} as unknown as EventRing, {
    ...flags,
    godot: new GodotResolver(null),
    projectPath: null,
    runtimeDir: "",
    addonSource: null,
    timeouts: DEFAULT_TIMEOUTS,
  });
  return records.sort((a, b) => a.name.localeCompare(b.name));
}

/** Flatten to (tool, op) capability ids, the unit the audit counts in. */
export function capabilityIds(records: ToolRecord[]): string[] {
  return records.flatMap((record) =>
    record.ops.length > 0 ? record.ops.map((op) => `${record.name}.${op}`) : [record.name],
  );
}

if (import.meta.main) {
  const maximal = collectToolSurface(MAXIMAL_FLAGS);
  const defaults = collectToolSurface(DEFAULT_FLAGS);
  const defaultNames = new Set(defaults.map((record) => record.name));
  console.log(
    JSON.stringify(
      {
        maximal: { tools: maximal.length, capabilities: capabilityIds(maximal).length },
        default: { tools: defaults.length, capabilities: capabilityIds(defaults).length },
        gatedOffByDefault: maximal.filter((record) => !defaultNames.has(record.name)).map((record) => record.name),
        tools: maximal,
      },
      null,
      2,
    ),
  );
}
