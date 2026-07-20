// Bounded ring of lifecycle events with an incremental cursor, so both polling
// clients (gd_get_events) and push-capable clients (MCP logging notifications)
// are served the same stream (whitepaper section 7.5).

export interface RingEvent {
  seq: number;
  type: string;
  data: unknown;
  time: string;
}

export class EventRing {
  private readonly events: RingEvent[] = [];
  private seq = 0;

  constructor(
    private readonly capacity = 256,
    private readonly notify?: (event: RingEvent) => void,
  ) {}

  record(type: string, data: unknown): RingEvent {
    const event: RingEvent = { seq: ++this.seq, type, data, time: new Date().toISOString() };
    this.events.push(event);
    if (this.events.length > this.capacity) {
      this.events.shift();
    }
    this.notify?.(event);
    return event;
  }

  // Events strictly after `cursor`, plus the cursor to pass next time.
  since(cursor: number): { events: RingEvent[]; next_cursor: number } {
    const events = this.events.filter((event) => event.seq > cursor);
    return { events, next_cursor: this.seq };
  }
}
