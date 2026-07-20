// Direct-socket flood client for the phase 1 live proof. Talks the raw bridge
// protocol (not MCP) so it measures the command queue itself rather than MCP
// stdio throughput. Reuses the broker's BridgeClient for framing and id
// correlation.

import { BridgeClient, BridgeError } from "../../broker/src/ipc-client.ts";

export interface FloodResult {
  sent: number;
  accepted: number;
  busy: number;
  otherErrors: number;
  frames: number[];
  deltasMs: number[];
}

interface PingResult {
  pong: boolean;
  frame: number;
  last_delta_ms: number;
}

// Fire `count` pings as fast as possible over one connection. The bridge's
// bounded inbound queue rejects the overflow as `busy`, proving backpressure
// over the real socket while accepted pings still round-trip with correct ids.
export async function floodPing(client: BridgeClient, count: number): Promise<FloodResult> {
  const inFlight: Array<Promise<void>> = [];
  const frames: number[] = [];
  const deltasMs: number[] = [];
  let accepted = 0;
  let busy = 0;
  let otherErrors = 0;

  for (let i = 0; i < count; i++) {
    const promise = client
      .request("gd_ping", {}, 30_000)
      .then((result) => {
        const ping = result as PingResult;
        accepted++;
        frames.push(ping.frame);
        deltasMs.push(ping.last_delta_ms);
      })
      .catch((error: unknown) => {
        if (error instanceof BridgeError && error.code === "busy") {
          busy++;
        } else {
          otherErrors++;
        }
      });
    inFlight.push(promise);
  }

  await Promise.all(inFlight);
  return { sent: count, accepted, busy, otherErrors, frames, deltasMs };
}

export interface WaitFramesResult {
  waited_frames: number;
  submitted_frame: number;
  completed_frame: number;
}

export async function waitFrames(client: BridgeClient, frames: number): Promise<WaitFramesResult> {
  const result = await client.request("gd_wait_frames", { frames }, 120_000);
  return result as WaitFramesResult;
}

export function summarize(values: number[]): { min: number; median: number; max: number } {
  if (values.length === 0) {
    return { min: 0, median: 0, max: 0 };
  }
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return {
    min: sorted[0]!,
    median: sorted[mid]!,
    max: sorted[sorted.length - 1]!,
  };
}
