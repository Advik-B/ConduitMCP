// Command-line parsing for the broker (whitepaper section 15).
//
// Two rules shape everything here.
//
// First, no option carries a Commander default value. `program.opts()` cannot
// distinguish a default from a passed argument, so a default would make the
// corresponding environment variable dead on arrival. Every option is left
// undefined when absent and the precedence chain lives in one place,
// resolveConfig in index.ts: `opts.x ?? env ?? fallback`.
//
// Second, booleans are three-state. `--enable-pixel-tools` yields undefined
// when absent, true when passed, and (where a negation is declared) false, so
// `opts.x ?? envFlag(...)` preserves the environment fallback while an explicit
// `--no-x` still wins over it.

import { Command, CommanderError, InvalidArgumentError, Option } from "commander";

import { TOOL_GROUPS } from "./tool-registry.ts";

export interface CliOptions {
  project?: string;
  runtimeDir?: string;
  sock?: string;
  tcp?: boolean;
  godot?: string;
  autoInstall?: boolean;
  addonSource?: string;
  enablePixelTools?: boolean;
  enableEditorEval?: boolean;
  disableEval?: boolean;
  timeoutMs?: number;
  evalTimeoutMs?: number;
  exportTimeoutMs?: number;
  auditLog?: string;
  auditMaxBytes?: number;
  toolGroups?: string;
  installGodot?: boolean;
  godotVersion?: string;
  godotMono?: boolean;
  engineDir?: string;
  engineSource?: string;
  autoInstallGodot?: boolean;
}

export { CommanderError };

/** Reject a value that is not a positive integer, naming the flag that got it. */
function positiveInt(flag: string): (value: string) => number {
  return (value: string) => {
    const parsed = Number(value);
    if (!Number.isInteger(parsed) || parsed <= 0) {
      throw new InvalidArgumentError(`${flag} expects a positive integer, got "${value}"`);
    }
    return parsed;
  };
}

/**
 * Build the parser. Exported so tests can inspect the option set without
 * parsing, and so the help text has exactly one definition.
 */
export function buildProgram(version: string): Command {
  const program = new Command();
  program
    .name("conduit-mcp-server")
    .description(
      "MCP stdio server giving an AI agent native control of the Godot editor and running game. " +
        "Command-line options override the matching CONDUIT_ environment variables.",
    )
    .version(version, "-v, --version", "print the broker version")
    .helpOption("-h, --help", "show this help");

  program
    // Deliberately not using Commander's .env(): it would resolve the variable
    // into opts, hiding precedence from resolveConfig, and its truthiness rule
    // for booleans contradicts envFlag, where CONDUIT_X=0 means off.
    .addOption(new Option("--project <path>", "Godot project directory to attach to"))
    .addOption(new Option("--runtime-dir <path>", "directory holding the IPC endpoints (default: system temp)"))
    .addOption(new Option("--sock <path>", "explicit editor endpoint, used verbatim, bypassing the project hash"))
    .addOption(new Option("--tcp", "use a loopback TCP endpoint instead of a socket or named pipe"))
    .addOption(new Option("--no-tcp", "force the socket or named pipe transport"))
    .addOption(new Option("--godot <path>", "engine binary for gd_editor_launch (found automatically otherwise)"))
    .addOption(new Option("--auto-install", "install the addon if the project has none"))
    .addOption(new Option("--no-auto-install", "never install the addon automatically"))
    .addOption(new Option("--addon-source <src>", "addon zip, directory, or URL instead of the GitHub release"))
    .addOption(new Option("--enable-pixel-tools", "register the tier-3 editor mouse tools"))
    .addOption(new Option("--enable-editor-eval", "register gd_editor_eval, GDScript in the editor process"))
    .addOption(new Option("--disable-eval", "drop the eval class: game and editor eval, networking, project tools"))
    .addOption(new Option("--timeout-ms <n>", "ordinary tool timeout in ms").argParser(positiveInt("--timeout-ms")))
    .addOption(
      new Option("--eval-timeout-ms <n>", "timeout for await-capable and eval-class tools in ms").argParser(
        positiveInt("--eval-timeout-ms"),
      ),
    )
    .addOption(
      new Option("--export-timeout-ms <n>", "timeout for project export in ms").argParser(positiveInt("--export-timeout-ms")),
    )
    .addOption(new Option("--audit-log <path|off>", "append a JSONL record of every tool call to this file"))
    .addOption(
      new Option("--audit-max-bytes <n>", "rotate the audit log past this size").argParser(positiveInt("--audit-max-bytes")),
    )
    .addOption(new Option("--tool-groups <list>", "comma list of tool groups to keep, or -group entries to drop"))
    // Deliberately a boolean with the tag on a separate option rather than
    // "--install-godot [version]". An optional-argument option lands in
    // checkMissingValues' takesValue set, which would reject the correct
    // "--install-godot --engine-dir /x" as a missing value. The separate flag is
    // also what the unattended install path needs, which cannot pass a
    // positional at all.
    .addOption(new Option("--install-godot", "download and install the Godot engine, then exit"))
    .addOption(new Option("--godot-version <tag>", 'engine release to install, for example "4.7.1-stable" (default: latest)'))
    .addOption(new Option("--godot-mono", "install the .NET/C# engine build instead of the standard one"))
    .addOption(new Option("--engine-dir <path>", "where installed engines live (default: ~/.conduit/engines)"))
    .addOption(new Option("--engine-source <path|url>", "engine zip or directory to install from instead of downloading"))
    .addOption(new Option("--auto-install-godot", "install an engine automatically when none is found"))
    .addOption(new Option("--no-auto-install-godot", "never install an engine automatically"));

  program.addHelpText(
    "after",
    () =>
      "\nTool groups (--tool-groups), keeping a list or dropping -entries:\n" +
      `  ${TOOL_GROUPS.join(", ")}\n` +
      "  core (ping, status, events, session, addon, engine) is always registered.\n" +
      "\nEvery option has a CONDUIT_ environment variable equivalent; the option wins.\n" +
      "Full reference: https://github.com/Advik-B/ConduitMCP/blob/master/docs/environment.md\n",
  );

  // Nothing but MCP protocol frames may reach stdout (whitepaper section 7.1),
  // and that includes help and version output: an MCP client is reading stdout
  // as a transport, not as a terminal.
  program.configureOutput({
    writeOut: (str) => process.stderr.write(str),
    writeErr: (str) => process.stderr.write(str),
  });

  // Errors and --help/--version become exceptions so the caller decides how the
  // process ends; see runCli.
  program.exitOverride();
  return program;
}

/**
 * Reject `--project --tcp`, where a flag is swallowed as the previous option's
 * value. Commander allows it on purpose (a value may legitimately begin with a
 * dash), but for this broker it silently produced a project path of "--tcp"
 * that only failed much later as an endpoint mismatch.
 */
function checkMissingValues(program: Command, argv: string[]): void {
  const longNames = new Set<string>();
  const takesValue = new Set<string>();
  for (const option of program.options) {
    if (!option.long) {
      continue;
    }
    longNames.add(option.long);
    if (option.required || option.optional) {
      takesValue.add(option.long);
    }
  }
  for (let i = 0; i < argv.length - 1; i++) {
    const arg = argv[i];
    const next = argv[i + 1];
    if (arg && next && takesValue.has(arg) && longNames.has(next)) {
      // A plain Error, not InvalidArgumentError: that one subclasses
      // CommanderError, and runCli treats those as already-reported.
      throw new Error(`${arg} expects a value, but was followed by the option ${next}`);
    }
  }
}

/**
 * Parse broker arguments. `argv` is the user's arguments only, without the
 * runtime and script entries.
 */
export function parseCli(argv: string[], version: string): CliOptions {
  const program = buildProgram(version);
  checkMissingValues(program, argv);
  program.parse(argv, { from: "user" });
  return program.opts<CliOptions>();
}

/**
 * The transport settings are the broker-and-bridge contract, not broker-only
 * configuration, so their flags are written back into the environment rather
 * than carried in Config alone. Three consumers need them there: endpoint.ts
 * reads CONDUIT_TCP at call time (including from tests/evals/harness.ts, which
 * imports those functions directly), gd_editor_launch forwards
 * CONDUIT_RUNTIME_DIR into the editor it spawns, and the Rust bridge reads all
 * three itself out of the environment it inherits.
 */
export function applyTransportEnv(options: CliOptions, env: NodeJS.ProcessEnv = process.env): void {
  if (options.runtimeDir !== undefined) {
    env.CONDUIT_RUNTIME_DIR = options.runtimeDir;
  }
  if (options.sock !== undefined) {
    env.CONDUIT_SOCK = options.sock;
  }
  if (options.tcp !== undefined) {
    env.CONDUIT_TCP = options.tcp ? "1" : "0";
  }
}

/** Outcome of parsing: options to run with, or an exit code to stop on. */
export type CliResult = { kind: "run"; options: CliOptions } | { kind: "exit"; code: number };

/**
 * Parse `process.argv`, turning Commander's help, version, and error exits into
 * a value the caller acts on. Commander consumes the first two argv entries,
 * which matches both `bun broker/src/index.ts` and a `bun build --compile`
 * binary, where argv[1] repeats the executable path.
 */
export function runCli(argv: string[], version: string): CliResult {
  try {
    return { kind: "run", options: parseCli(argv.slice(2), version) };
  } catch (error) {
    if (error instanceof CommanderError) {
      // Help and version already wrote their output through configureOutput.
      return { kind: "exit", code: error.exitCode };
    }
    process.stderr.write(`conduit-broker: ${error instanceof Error ? error.message : String(error)}\n`);
    return { kind: "exit", code: 1 };
  }
}
