// Detecting a Godot the broker did not start.
//
// BridgeManager knows about two kinds of editor: one bridged to our endpoint
// (isEditorConnected) and one we spawned that has not connected yet
// (getEditorProcess). Neither sees the common case: the human already had the
// project open before the broker started, in an editor launched without the
// --conduit opt-in, or against a different runtime directory.
//
// That third state is not a detail. Treating it as "no editor" makes two
// expensive mistakes: launching a second editor on a project Godot expects to
// own for its session, and downloading an engine onto a machine that visibly
// already has one running. So the checks that would launch or install ask here
// first.
//
// The honest limit of this check: it matches processes by executable name, and
// the editor and a running game are the same binary. A match means "a Godot is
// running that this broker did not start", not "an editor is running". That is
// still the right signal for both decisions above, and the wording of every
// message built from it says so rather than overclaiming.

import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);

// Long enough for a loaded machine, short enough that no tool call visibly
// stalls on it. A miss is not an error; see probeGodotProcesses.
const PROBE_TIMEOUT_MS = 2_000;

export interface GodotProcess {
  pid: number;
  /** Executable name as the OS reports it. */
  name: string;
}

export interface EditorPresence {
  /** An editor bridge is connected to this broker. */
  connected: boolean;
  /** This broker spawned an editor that has not connected yet. */
  launching: boolean;
  /**
   * Godot processes this broker neither spawned nor is connected to. Empty
   * when there are none *and* when the probe could not run; probed says which.
   */
  foreign: GodotProcess[];
  /** Whether the process probe actually produced an answer. */
  probed: boolean;
}

/** Whether an executable name looks like a Godot engine binary. */
export function isGodotProcessName(name: string): boolean {
  const base = name.replace(/\.exe$/i, "");
  // Godot_v4.7.1-stable_win64, godot4, godot, Godot. Deliberately not a bare
  // substring test: "godot-conduit" or a user's "mygodottool" should not match.
  return /^godot(_v[\w.+-]*|[0-9]*)$/i.test(base) || /^Godot$/.test(base);
}

/** Exported for tests: the output shape is the part most likely to drift. */
export function parseUnix(stdout: string): GodotProcess[] {
  const found: GodotProcess[] = [];
  for (const line of stdout.split("\n")) {
    const match = line.trim().match(/^(\d+)\s+(.*)$/);
    if (!match?.[1] || !match[2]) {
      continue;
    }
    // comm is the executable name; on macOS it can be a full path.
    const name = match[2].trim().split("/").pop() ?? "";
    if (isGodotProcessName(name)) {
      found.push({ pid: Number(match[1]), name });
    }
  }
  return found;
}

/** Exported for tests: see parseUnix. */
export function parseTasklistCsv(stdout: string): GodotProcess[] {
  const found: GodotProcess[] = [];
  for (const line of stdout.split("\n")) {
    // "Image Name","PID",... with quoted fields.
    const fields = line.trim().match(/^"([^"]*)","(\d+)"/);
    if (!fields?.[1] || !fields[2]) {
      continue;
    }
    if (isGodotProcessName(fields[1])) {
      found.push({ pid: Number(fields[2]), name: fields[1] });
    }
  }
  return found;
}

/**
 * List Godot processes on this machine.
 *
 * Never throws and never rejects: a machine where the probe cannot run (no ps,
 * a locked-down container, a timeout) must not fail the tool call that asked.
 * The caller distinguishes "none found" from "could not look" through the
 * returned flag, and degrades to today's behaviour rather than guessing.
 */
export async function probeGodotProcesses(): Promise<{ processes: GodotProcess[]; probed: boolean }> {
  try {
    if (process.platform === "win32") {
      const { stdout } = await run("tasklist", ["/FO", "CSV", "/NH"], { timeout: PROBE_TIMEOUT_MS });
      return { processes: parseTasklistCsv(stdout), probed: true };
    }
    const { stdout } = await run("ps", ["-A", "-o", "pid=,comm="], { timeout: PROBE_TIMEOUT_MS });
    return { processes: parseUnix(stdout), probed: true };
  } catch {
    return { processes: [], probed: false };
  }
}

interface PresenceSource {
  isEditorConnected(): boolean;
  getEditorProcess(): { pid?: number } | null;
}

/**
 * The three states that decide whether launching or installing makes sense.
 * Processes this broker spawned are excluded, so `foreign` is only ever a Godot
 * somebody else started.
 */
export async function editorPresence(manager: PresenceSource): Promise<EditorPresence> {
  const connected = manager.isEditorConnected();
  const ours = manager.getEditorProcess();
  const { processes, probed } = await probeGodotProcesses();
  const ourPid = ours?.pid;
  return {
    connected,
    launching: ours != null,
    foreign: processes.filter((proc) => proc.pid !== ourPid),
    probed,
  };
}

/**
 * The sentence to put in front of a human when a Godot is running that we did
 * not start, or null when there is nothing to say.
 */
export function foreignEditorAdvice(presence: EditorPresence): string | null {
  if (presence.connected || presence.foreign.length === 0) {
    return null;
  }
  const names = [...new Set(presence.foreign.map((proc) => proc.name))].join(", ");
  return (
    `a Godot process is already running that this broker did not start (${names}). ` +
    "If that is the editor for this project, it was opened without the Conduit opt-in: " +
    "close it and relaunch with --conduit, or set CONDUIT_ENABLE, and the broker will attach to it. " +
    "Opening a second editor on the same project is not safe."
  );
}
