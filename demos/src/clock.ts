/**
 * The take's clock: real time, less the waiting nobody would see.
 *
 * A flow holds on a still screen for seconds at a time — a reveal lets the
 * whole page be read, a pause lets a result sink in. Recording those holds
 * in real time is most of what made a take slow, and none of it shows: the
 * page paints nothing while it is still, and the compositor holds the last
 * frame until the next one. So a hold waits only until the page has stopped
 * painting, then *credits* the rest of its length to the clip's clock
 * instead of sleeping it. Everything stamped afterwards — the events the
 * take logs, the frames the screencast delivers — lands that much later on
 * the clip's clock, exactly as if the take had waited.
 *
 * Frames are stamped by when the browser captured them, not when they
 * arrived, so a frame painted before a credit but delivered after it keeps
 * the time it was painted at.
 */

/** Real ms, on `performance.now()`'s timeline. */
export type RealMs = number;

export class TakeClock {
  private started: RealMs = 0;
  /** Every credit so far: from real time `at` on, the clip runs `offset` ms ahead. Ascending. */
  private readonly credits: Array<{ readonly at: RealMs; readonly offset: number }> = [];

  /** Zero the clip's clock at `real`. */
  start(real: RealMs): void {
    this.started = real;
    this.credits.length = 0;
  }

  /** The total credited so far, ms. */
  get credited(): number {
    return this.credits.at(-1)?.offset ?? 0;
  }

  /** The clip's time for real time `real`: ms since the start, plus whatever was credited by then. */
  at(real: RealMs): number {
    for (let i = this.credits.length - 1; i >= 0; i--) {
      const credit = this.credits[i]!;
      if (credit.at <= real) return real - this.started + credit.offset;
    }
    return real - this.started;
  }

  /** Advance the clip's clock by `ms` at real time `real`, without waiting for it. */
  credit(ms: number, real: RealMs): void {
    if (ms <= 0) return;
    this.credits.push({ at: real, offset: this.credited + ms });
  }
}

/**
 * The real time a screencast frame was captured at, on `performance.now()`'s
 * timeline, from the frame's metadata timestamp (seconds since the epoch) —
 * or `received` when the browser gave none or one that cannot be right (in
 * the future, or older than the take).
 */
export const capturedAt = (timestamp: number | undefined, received: RealMs, timeOrigin: number, started: RealMs): RealMs => {
  if (timestamp === undefined || !Number.isFinite(timestamp)) return received;
  const real = timestamp * 1000 - timeOrigin;
  return real > received || real < started - 1000 ? received : real;
};
