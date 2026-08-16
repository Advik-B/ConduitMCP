// Detecting a Godot editor the broker did not start.
//
// BridgeManager knows about two kinds of editor: one bridged to our endpoint
// (isEditorConnected) and one we spawned that has not connected yet
// (getEditorProcess). Neither sees the common case: the human already had the
// project open before the broker started, in an editor launched without the
// --conduit opt-in, or against a different runtime directory.
//
// That third state is not a detail. Treating it as "no editor" launches a
// second editor onto a project Godot expects to own for its session.
//
// What counts is narrower than "a Godot is running", and getting that wrong is
// expensive in the other direction: the editor and a game are the same binary,
// so a name-only match refuses to launch an editor because a game is playing,
// or because an earlier headless export has not exited yet. Both were observed.
// So the probe reads command lines and requires two things of a process before
// it will block a launch:
//
//   1. it is an editor -- Godot's editor takes --editor or -e, a game does not;
//   2. it is this project's editor -- matched on --path, when that is legible.
//
// Anything the broker itself started is excluded first, editors and games alike.

import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);

// Long enough for a loaded machine, short enough that no tool call visibly
// stalls on it. A miss is not an error; see probeGodotProcesses.
const PROBE_TIMEOUT_MS = 4_000;

export interface GodotProcess {
  pid: number;
  /** Executable name, or the best approximation the platform gives. */
  name: string;
  /** Whether the command line marks this as an editor rather than a game. */
  editor: boolean;
  /** The --path value, when the command line carried one. */
  projectPath: string | null;
}

export interface EditorPresence {
  /** An editor bridge is connected to this broker. */
  connected: boolean;
  /** This broker spawned an editor that has not connected yet. */
  launching: boolean;
  /**
   * Editors for this project that the broker neither spawned nor is connected
   * to. Empty when there are none *and* when the probe could not run; probed
   * says which.
   */
  foreign: GodotProcess[];
  /** Whether the process probe actually produced an answer. */
  probed: boolean;
}

/** Whether an executable name looks like a Godot engine binary. */
export function isGodotProcessName(name: string): boolean {
  // Linux ps truncates comm to 15 characters ("Godot_v4.7.1-st"), so this has to
  // match a prefix rather than a whole well-formed name.
  const base = name.replace(/\.exe$/i, "");
  return /^godot(_v[\w.+-]*|[0-9]*)$/i.test(base) || /^Godot(_mono)?$/.test(base);
}

/**
 * Whether a command line is an editor invocation.
 *
 * Godot opens the editor for --editor or -e, and also for -p/--project-manager,
 * which owns no project and so never conflicts. A game gets neither.
 */
export function isEditorCommandLine(args: string): boolean {
  return /(^|\s)(--editor|-e)(\s|$)/.test(args);
}

/** The --path value in a command line, or null when there is none. */
export function projectPathFromCommandLine(args: string): string | null {
  // Both "--path <dir>" and "--path=<dir>", quoted or not.
  const match = args.match(/--path[=\s]+("([^"]+)"|'([^']+)'|(\S+))/);
  return match?.[2] ?? match?.[3] ?? match?.[4] ?? null;
}

function classify(pid: number, name: string, args: string): GodotProcess {
  return { pid, name, editor: isEditorCommandLine(args), projectPath: projectPathFromCommandLine(args) };
}

/** Exported for tests: the output shape is the part most likely to drift. */
export function parseUnix(stdout: string): GodotProcess[] {
  const found: GodotProcess[] = [];
  for (const line of stdout.split("\n")) {
    const match = line.trim().match(/^(\d+)\s+(.*)$/);
    if (!match?.[1] || !match[2]) {
      continue;
    }
    const args = match[2].trim();
    // args starts with the executable, which may be a full path.
    const executable = args.split(/\s+/)[0] ?? "";
    const name = executable.split(/[/\\]/).pop() ?? "";
    if (isGodotProcessName(name)) {
      found.push(classify(Number(match[1]), name, args));
    }
  }
  return found;
}

/** Exported for tests: see parseUnix. */
export function parseWindows(stdout: string): GodotProcess[] {
  const found: GodotProcess[] = [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return found;
  }
  // ConvertTo-Json emits a bare object rather than an array for a single match.
  const rows = Array.isArray(parsed) ? parsed : [parsed];
  for (const row of rows) {
    const record = row as { ProcessId?: number; Name?: string; CommandLine?: string | null };
    if (typeof record?.ProcessId !== "number" || typeof record.Name !== "string") {
      continue;
    }
    if (!isGodotProcessName(record.Name)) {
      continue;
    }
    found.push(classify(record.ProcessId, record.Name, record.CommandLine ?? ""));
  }
  return found;
}

/**
 * List Godot processes on this machine, with enough of their command line to
 * tell an editor from a game.
 *
 * Never throws and never rejects: a machine where the probe cannot run (no ps,
 * a locked-down container, a timeout) must not fail the tool call that asked.
 * The caller distinguishes "none found" from "could not look" through the
 * returned flag, and degrades to launching rather than to refusing, because
 * refusing on no evidence is the worse failure.
 */
export async function probeGodotProcesses(): Promise<{ processes: GodotProcess[]; probed: boolean }> {
  try {
    if (process.platform === "win32") {
      // Two steps, because the precise query is the slow one. tasklist answers
      // "is any Godot running" in about 50 ms and is almost always no; only then
      // is it worth ~1.8 s of PowerShell startup to read command lines. Without
      // the second step an editor and a running game are indistinguishable.
      const listed = await run("tasklist", ["/FO", "CSV", "/NH"], { timeout: PROBE_TIMEOUT_MS });
      const anyGodot = listed.stdout
        .split("\n")
        .some((line) => isGodotProcessName(line.trim().match(/^"([^"]*)"/)?.[1] ?? ""));
      if (!anyGodot) {
        return { processes: [], probed: true };
      }
      const { stdout } = await run(
        "powershell",
        [
          "-NoProfile",
          "-NonInteractive",
          "-Command",
          "Get-CimInstance Win32_Process -Filter \"Name LIKE 'Godot%'\" | Select-Object ProcessId,Name,CommandLine | ConvertTo-Json -Compress",
        ],
        { timeout: PROBE_TIMEOUT_MS },
      );
      return { processes: parseWindows(stdout.trim() || "[]"), probed: true };
    }
    const { stdout } = await run("ps", ["-A", "-o", "pid=,args="], { timeout: PROBE_TIMEOUT_MS });
    return { processes: parseUnix(stdout), probed: true };
  } catch {
    return { processes: [], probed: false };
  }
}

interface PresenceSource {
  isEditorConnected(): boolean;
  getEditorProcess(): { pid?: number } | null;
  listGames?(): Array<{ pid: number }>;
}

/** Whether two project paths name the same directory. */
function samePath(a: string, b: string): boolean {
  const normalise = (value: string): string => path.resolve(value).replace(/[\\/]+$/, "").toLowerCase();
  return normalise(a) === normalise(b);
}

/**
 * The states that decide whether launching makes sense. `projectPath` scopes the
 * answer: an editor open on somebody else's project is not this broker's
 * problem, and blocking on it would be a false alarm the user cannot clear
 * except with force.
 */
export async function editorPresence(manager: PresenceSource, projectPath?: string | null): Promise<EditorPresence> {
  const connected = manager.isEditorConnected();
  const ours = manager.getEditorProcess();
  const { processes, probed } = await probeGodotProcesses();

  // Everything this broker started: the editor it spawned, and every game it
  // knows about. A game playing is not a reason to refuse an editor.
  const known = new Set<number>();
  if (typeof ours?.pid === "number") {
    known.add(ours.pid);
  }
  for (const game of manager.listGames?.() ?? []) {
    known.add(game.pid);
  }

  const foreign = processes.filter((proc) => {
    if (known.has(proc.pid) || !proc.editor) {
      return false;
    }
    // An editor whose project we can read and which is not ours is unrelated.
    if (proc.projectPath && projectPath && !samePath(proc.projectPath, projectPath)) {
      return false;
    }
    return true;
  });

  return { connected, launching: ours != null, foreign, probed };
}

/**
 * The sentence to put in front of a human when an editor is open that we did
 * not start, or null when there is nothing to say.
 */
export function foreignEditorAdvice(presence: EditorPresence): string | null {
  if (presence.connected || presence.foreign.length === 0) {
    return null;
  }
  const names = [...new Set(presence.foreign.map((proc) => proc.name))].join(", ");
  return (
    `a Godot editor is already running that this broker did not start (${names}). ` +
    "It was opened without the Conduit opt-in: close it and relaunch with --conduit, " +
    "or set CONDUIT_ENABLE, and the broker will attach to it. " +
    "Opening a second editor on the same project is not safe."
  );
}
