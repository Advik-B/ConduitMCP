// Turn the raw capture into the two artifacts the README carries: the full
// take as an mp4, and a short looping GIF cut from the chapters flagged as
// highlights.
//
// GitHub renders a committed GIF inline in a README but does not give a
// relative mp4 a player, so the GIF is what a reader actually sees on the page
// and the mp4 is the full-quality download. That makes GIF size a real
// constraint, hence the budget loop: encode, measure, step the scale and frame
// rate down, repeat until it fits.

import { rmSync, statSync } from "node:fs";
import { join } from "node:path";

import type { Chapter } from "./capture.ts";

const GIF_BUDGET_BYTES = 8 * 1024 * 1024;

/** Scale and frame rate ladder, tried in order until the GIF fits the budget. */
const GIF_STEPS = [
  { width: 900, fps: 12 },
  { width: 800, fps: 12 },
  { width: 800, fps: 10 },
  { width: 720, fps: 10 },
  { width: 640, fps: 10 },
  { width: 640, fps: 8 },
];

/** Seconds of each highlight chapter to keep in the GIF. */
const GIF_CHAPTER_SECONDS = 4.5;

async function ffmpeg(args: string[]): Promise<void> {
  const proc = Bun.spawn(["ffmpeg", "-hide_banner", "-loglevel", "error", "-y", ...args], {
    stdout: "ignore",
    stderr: "inherit",
  });
  const code = await proc.exited;
  if (code !== 0) {
    throw new Error(`ffmpeg failed (${code}): ${args.join(" ")}`);
  }
}

export async function probeDuration(path: string): Promise<number> {
  const proc = Bun.spawn(
    ["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", path],
    { stdout: "pipe", stderr: "ignore" },
  );
  const out = await new Response(proc.stdout).text();
  await proc.exited;
  return Number.parseFloat(out.trim());
}

/** Transcode the raw capture to the committed mp4: 1280x720, web-friendly. */
export async function writeMp4(raw: string, dest: string): Promise<void> {
  await ffmpeg([
    "-i", raw,
    "-vf", "scale=1280:-2:flags=lanczos",
    "-c:v", "libx264",
    "-preset", "slow",
    "-crf", "26",
    "-pix_fmt", "yuv420p",
    "-movflags", "+faststart",
    "-an",
    dest,
  ]);
}

/**
 * Build the looping GIF from the highlight chapters. Each contributes a few
 * seconds from the point the scenario marked as its payoff, so the reel keeps
 * moving instead of dwelling on setup or on whatever a chapter ended on.
 */
export async function writeGif(raw: string, dest: string, chapters: Chapter[], workDir: string): Promise<void> {
  const clips = chapters
    .filter((c) => c.highlight && c.end > c.start)
    .map((c) => {
      const start = c.highlightStart ?? c.start;
      return { start, duration: Math.min(GIF_CHAPTER_SECONDS, c.end - start) };
    })
    .filter((c) => c.duration >= 1);
  if (clips.length === 0) {
    throw new Error("no highlight chapters long enough to build a GIF from");
  }

  const palette = join(workDir, "palette.png");
  for (const step of GIF_STEPS) {
    const select = clips
      .map((c) => `between(t,${c.start.toFixed(2)},${(c.start + c.duration).toFixed(2)})`)
      .join("+");
    // select keeps only the highlight windows; setpts restamps the survivors
    // into one continuous timeline so the GIF has no frozen gaps.
    const base = `select='${select}',setpts=N/FRAME_RATE/TB,fps=${step.fps},scale=${step.width}:-2:flags=lanczos`;

    await ffmpeg(["-i", raw, "-vf", `${base},palettegen=max_colors=192:stats_mode=diff`, palette]);
    await ffmpeg([
      "-i", raw,
      "-i", palette,
      "-lavfi", `${base}[x];[x][1:v]paletteuse=dither=bayer:bayer_scale=4:diff_mode=rectangle`,
      "-loop", "0",
      dest,
    ]);

    const size = statSync(dest).size;
    console.log(`  gif ${step.width}px @ ${step.fps} fps: ${(size / 1024 / 1024).toFixed(1)} MB`);
    if (size <= GIF_BUDGET_BYTES) {
      rmSync(palette, { force: true });
      return;
    }
  }
  rmSync(palette, { force: true });
  const size = statSync(dest).size;
  console.warn(`  gif still ${(size / 1024 / 1024).toFixed(1)} MB at the smallest step; keeping it`);
}
