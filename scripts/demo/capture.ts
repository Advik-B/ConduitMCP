// Screen recording for the demo: an ffmpeg x11grab capture of the display the
// editor is rendering to, with two caption overlays and a chapter index.
//
// The captions are drawtext filters reading text files with reload=1, so the
// scenario can change what the overlay says mid-recording without restarting
// the encoder. Each write goes to a sibling file and is renamed into place,
// because ffmpeg re-reads the file on every frame and would otherwise be able
// to observe a half-written line.

import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

/** A named span of the recording, in seconds from the start of the capture. */
export interface Chapter {
  title: string;
  start: number;
  end: number;
  /** Whether this chapter is cut into the short looping GIF. */
  highlight: boolean;
  /** Where the GIF should start cutting from, if the chapter opens with setup
   * worth skipping (a game booting, a script being written before it is shown).
   * Defaults to the chapter start. */
  highlightStart?: number;
}

export interface RecorderOptions {
  display: string;
  width: number;
  height: number;
  /** Where the raw capture is written. */
  output: string;
  /** Scratch directory for the caption files. */
  workDir: string;
  fps?: number;
}

const FONT = "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf";
const FONT_MONO = "/usr/share/fonts/truetype/dejavu/DejaVuSansMono.ttf";

/** Caption strips padded around the capture, in pixels. */
const TOP_STRIP = 52;
const BOTTOM_STRIP = 44;

export class Recorder {
  private proc: Bun.Subprocess<"pipe", "ignore", "inherit"> | null = null;
  private startedAt = 0;
  private readonly chapters: Chapter[] = [];
  private open: Chapter | null = null;
  private readonly chapterFile: string;
  private readonly callFile: string;

  constructor(private readonly options: RecorderOptions) {
    mkdirSync(options.workDir, { recursive: true });
    this.chapterFile = join(options.workDir, "chapter.txt");
    this.callFile = join(options.workDir, "call.txt");
  }

  async start(): Promise<void> {
    // drawtext refuses to load a missing textfile, so both exist before ffmpeg
    // does. A single space renders as nothing but keeps the filter happy.
    writeFileSync(this.chapterFile, " ");
    writeFileSync(this.callFile, " ");

    const { display, width, height, output, fps = 30 } = this.options;
    const args = [
      "-hide_banner",
      "-loglevel", "warning",
      "-f", "x11grab",
      "-draw_mouse", "0",
      "-framerate", String(fps),
      "-video_size", `${width}x${height}`,
      "-i", display,
      "-vf", this.filterChain(),
      "-c:v", "libx264",
      "-preset", "veryfast",
      "-crf", "20",
      "-pix_fmt", "yuv420p",
      "-movflags", "+faststart",
      "-y", output,
    ];
    this.proc = Bun.spawn(["ffmpeg", ...args], { stdin: "pipe", stdout: "ignore", stderr: "inherit" });
    // Chapter offsets are cut against ffmpeg's own timeline, which starts at its
    // first captured frame, so the clock has to start at spawn. Waiting first
    // and starting it afterwards would shift every offset by the wait.
    this.startedAt = Date.now();
    // x11grab takes a moment to produce its first frame; starting the scenario
    // before then would clip the opening chapter.
    await sleep(1_500);
  }

  /** Open a chapter, closing the previous one. */
  chapter(title: string, highlight = false): void {
    this.endChapter();
    this.open = { title, start: this.elapsed(), end: 0, highlight };
    this.write(this.chapterFile, title);
    this.write(this.callFile, " ");
  }

  endChapter(): void {
    if (this.open) {
      this.open.end = this.elapsed();
      this.chapters.push(this.open);
      this.open = null;
    }
  }

  /** Mark where the current chapter gets interesting, for the GIF cut. */
  highlightFrom(): void {
    if (this.open) {
      this.open.highlightStart = this.elapsed();
    }
  }

  /** Set the lower caption, normally the MCP tool call about to be made. */
  caption(text: string): void {
    this.write(this.callFile, text);
  }

  async stop(): Promise<Chapter[]> {
    this.endChapter();
    const proc = this.proc;
    this.proc = null;
    if (!proc) {
      return this.chapters;
    }
    // 'q' asks ffmpeg to finish the file cleanly; a signal would leave the
    // moov atom unwritten and the mp4 unplayable.
    proc.stdin.write("q");
    proc.stdin.flush();
    proc.stdin.end();
    const timeout = sleep(15_000).then(() => "timeout" as const);
    if ((await Promise.race([proc.exited, timeout])) === "timeout") {
      proc.kill();
      await proc.exited;
    }
    return this.chapters;
  }

  kill(): void {
    this.proc?.kill();
    this.proc = null;
  }

  private elapsed(): number {
    return (Date.now() - this.startedAt) / 1000;
  }

  private write(path: string, text: string): void {
    const tmp = `${path}.next`;
    writeFileSync(tmp, `${text.length > 0 ? text : " "}\n`);
    renameSync(tmp, path);
  }

  /**
   * The captions live in strips padded above and below the capture rather than
   * drawn over it, so nothing covers the editor: not the menu bar, not the main
   * screen tabs, not the bottom panel the last chapter is about.
   */
  private filterChain(): string {
    const { width, height } = this.options;
    const text = (file: string, font: string, size: number, y: string, color: string) =>
      `drawtext=fontfile=${font}:textfile=${file}:reload=1:fontsize=${size}:fontcolor=${color}:x=30:y=${y}`;
    return [
      `pad=width=${width}:height=${height + TOP_STRIP + BOTTOM_STRIP}:x=0:y=${TOP_STRIP}:color=0x0d0d11`,
      text(this.chapterFile, FONT, 27, String(Math.round((TOP_STRIP - 27) / 2)), "white"),
      // drawtext exposes the input frame height as h, not ih.
      text(this.callFile, FONT_MONO, 19, `h-${BOTTOM_STRIP - Math.round((BOTTOM_STRIP - 19) / 2)}`, "0x8fc9f5"),
    ].join(",");
  }
}

/** Fail early with an actionable message rather than mid-take. */
export function requireFfmpeg(): void {
  if (Bun.spawnSync(["which", "ffmpeg"]).exitCode !== 0) {
    throw new Error("ffmpeg not found; install it (apt install ffmpeg) to record the demo");
  }
}
