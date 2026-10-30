/**
 * A take: one run of a flow through Brainz Cloud, in a real browser, logged.
 *
 * The flow speaks in intentions — go here, click that, type this — and the
 * take does each one the way a hand would: the pointer glides to the target
 * on an ease (the real mouse follows the same path, so hover states light
 * up as it passes), presses, and the moment is logged against the take's
 * clock. Meanwhile a CDP screencast delivers every frame the page paints,
 * stamped on the same clock. The log and the frames are the whole record;
 * `compose.ts` renders the clip from them afterwards, at 60fps, with the
 * cursor and the camera drawn in.
 */
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { chromium, type Browser, type CDPSession, type Locator, type Page } from "playwright";
import { TakeClock, capturedAt } from "./clock.js";
import { DEVICE_SCALE, VIEWPORT } from "./layout.js";
import { moveDuration, type FrameRef, type Point, type TakeEvent } from "./timeline.js";

/** What a take leaves on disk for the compositor. */
export interface TakeLog {
  readonly viewport: { readonly width: number; readonly height: number };
  readonly deviceScale: number;
  /** Where the cursor rests before its first move. */
  readonly initial: Point;
  readonly events: ReadonlyArray<TakeEvent>;
  readonly frames: ReadonlyArray<FrameRef>;
  /** Total length, ms. */
  readonly duration: number;
}

export interface TakeOptions {
  /** Directory the frames and log are written to. */
  readonly dir: string;
  /** The app's origin on the demo stack (`stack.ts`). */
  readonly origin: string;
  /** The demo account's session (`tenant.ts`), set on the browser before anything loads. */
  readonly cookies: ReadonlyArray<{ readonly name: string; readonly value: string }>;
  readonly headless?: boolean;
  /**
   * Sit through every hold in real time instead of crediting the still part
   * of it to the clock (`clock.ts`). The clip comes out the same; only the
   * take is slower. For a flow whose screen moves where it should be still.
   */
  readonly realTime?: boolean;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Per-keystroke delay when typing, ms: a confident typist. */
const KEY_MS = 55;

/** How long the page must go without painting before a hold counts it still, ms. */
const STILL_MS = 200;

/** Between keystrokes a repaint lands within a frame or two: still sooner. */
const KEY_STILL_MS = 40;

/** Real pointer moves in a credited glide: enough to pass over what it would light up on the way. */
const GLIDE_STEPS = 6;

export class Take {
  private readonly events: TakeEvent[] = [];
  private readonly frames: FrameRef[] = [];
  private cursor: Point;
  /** Where the cursor stood when the clock started: the clip's first cursor position. */
  private initial: Point;
  private readonly clock = new TakeClock();
  /** When the last screencast frame was captured, real ms. */
  private lastPaint = 0;
  private recording = false;
  private cdp: CDPSession | null = null;
  private frameWrites: Promise<void>[] = [];

  private constructor(
    readonly page: Page,
    private readonly browser: Browser,
    private readonly options: TakeOptions,
  ) {
    this.cursor = { x: VIEWPORT.width / 2, y: VIEWPORT.height / 2 };
    this.initial = this.cursor;
  }

  static async open(options: TakeOptions): Promise<Take> {
    await mkdir(join(options.dir, "frames"), { recursive: true });
    const browser = await chromium.launch({ headless: options.headless ?? true });
    const context = await browser.newContext({
      viewport: { ...VIEWPORT },
      deviceScaleFactor: DEVICE_SCALE,
      colorScheme: "dark",
      locale: "en-AU",
      timezoneId: "Australia/Melbourne",
      reducedMotion: "no-preference",
    });
    const page = await context.newPage();
    const take = new Take(page, browser, options);
    await page.mouse.move(take.cursor.x, take.cursor.y);
    return take;
  }

  /** The clock every event and frame is stamped on: ms since `begin()`, holds credited in full. */
  private now(): number {
    return this.clock.at(performance.now());
  }

  /**
   * Let `ms` pass on the take's clock. Before `begin()`, or with `realTime`,
   * that is a sleep. While recording it waits only until the page has gone
   * `still` ms without painting (or the hold is over, if it never does) and
   * credits the rest to the clock: the frame on screen is the one the clip
   * holds either way.
   */
  private async hold(ms: number, still = STILL_MS): Promise<void> {
    if (!this.recording || this.options.realTime === true) {
      await sleep(ms);
      return;
    }
    const start = performance.now();
    const deadline = start + ms;
    for (;;) {
      const now = performance.now();
      if (now >= deadline) return;
      if (now - Math.max(start, this.lastPaint) >= still) break;
      await sleep(Math.min(16, deadline - now));
    }
    const now = performance.now();
    this.clock.credit(deadline - now, now);
  }

  /**
   * Enter as the demo account (its session cookie, set before the first
   * load), land on `path`, and stand ready: nothing is logged yet.
   */
  async enter(path = "/dashboard"): Promise<void> {
    await this.page.context().addCookies(
      this.options.cookies.map((cookie) => ({ ...cookie, url: this.options.origin })),
    );
    await this.page.goto(`${this.options.origin}${path}`, { waitUntil: "networkidle" });
    await this.settle();
  }

  /**
   * Show a page the flow writes itself (a title or end card) instead of
   * one the app serves: still part of the clip once `begin()` has run.
   */
  async card(html: string): Promise<void> {
    await this.page.setContent(html, { waitUntil: "load" });
    await this.settle();
  }

  /** Start the clock and the screencast: from here on, everything is in the clip. */
  async begin(): Promise<void> {
    this.cdp = await this.page.context().newCDPSession(this.page);
    const started = performance.now();
    this.clock.start(started);
    this.initial = this.cursor;
    this.recording = true;
    this.cdp.on("Page.screencastFrame", (frame) => {
      const captured = capturedAt(frame.metadata.timestamp, performance.now(), performance.timeOrigin, started);
      this.lastPaint = Math.max(this.lastPaint, captured);
      // Never before the frame ahead of it: the compositor looks frames up in order.
      const t = Math.max(0, Math.round(this.clock.at(captured)), this.frames.at(-1)?.t ?? 0);
      const file = `frames/${String(this.frames.length).padStart(5, "0")}.jpg`;
      this.frames.push({ t, file });
      this.frameWrites.push(
        writeFile(join(this.options.dir, file), Buffer.from(frame.data, "base64")),
      );
      void this.cdp?.send("Page.screencastFrameAck", { sessionId: frame.sessionId });
    });
    await this.cdp.send("Page.startScreencast", {
      format: "jpeg",
      quality: 88,
      maxWidth: VIEWPORT.width * DEVICE_SCALE,
      maxHeight: VIEWPORT.height * DEVICE_SCALE,
      everyNthFrame: 1,
    });
    // A first frame, whatever the page does next: nudge a repaint.
    await this.page.evaluate(() => document.body.getBoundingClientRect());
    await sleep(120);
    this.lastPaint = Math.max(this.lastPaint, performance.now());
  }

  /** How much of the take's clock was credited rather than waited, ms. */
  get skipped(): number {
    return this.clock.credited;
  }

  /** Stop the clock, write the log, close the browser. */
  async end(): Promise<TakeLog> {
    const duration = Math.round(this.now());
    this.recording = false;
    if (this.cdp !== null) {
      await this.cdp.send("Page.stopScreencast").catch(() => undefined);
      await this.cdp.detach().catch(() => undefined);
    }
    await Promise.all(this.frameWrites);
    await this.browser.close();
    const log: TakeLog = {
      viewport: { ...VIEWPORT },
      deviceScale: DEVICE_SCALE,
      initial: this.initial,
      events: this.events,
      frames: this.frames,
      duration,
    };
    await writeFile(join(this.options.dir, "take.json"), JSON.stringify(log));
    return log;
  }

  /** Wait for the page to be still: network idle and one frame settled. */
  async settle(ms = 250): Promise<void> {
    await this.page.waitForLoadState("networkidle").catch(() => undefined);
    await this.hold(ms);
  }

  /** Hold on what is showing. */
  async pause(ms: number): Promise<void> {
    await this.hold(ms);
  }

  /** Step the camera back to the whole screen and hold there. */
  async reveal(ms = 1400): Promise<void> {
    this.log({ kind: "reveal", t: this.now() });
    await this.hold(ms);
  }

  /** Navigate by URL, as a bookmark would — no click to animate. */
  async goto(path: string): Promise<void> {
    await this.page.goto(`${this.options.origin}${path}`, { waitUntil: "networkidle" });
    await this.settle();
  }

  /**
   * Glide the pointer to the element and press it. The real mouse takes the
   * same path at the same pace, so `:hover` styling shows as it would for a
   * person, and the click lands where the ripple is drawn.
   */
  async click(target: string | Locator, options: { readonly settle?: number } = {}): Promise<void> {
    const locator = this.locate(target);
    await locator.first().waitFor({ state: "visible", timeout: 20_000 });
    await locator.first().scrollIntoViewIfNeeded();
    const at = await this.centre(locator.first());
    await this.glide(at);
    await this.page.mouse.down();
    this.log({ kind: "click", t: this.now(), at });
    await this.hold(70, KEY_STILL_MS);
    await this.page.mouse.up();
    await this.settle(options.settle ?? 350);
  }

  /** Click a field, then type into it at a person's pace. */
  async type(target: string | Locator, text: string): Promise<void> {
    await this.click(target, { settle: 120 });
    for (const char of text) {
      await this.page.keyboard.type(char);
      this.log({ kind: "key", t: this.now(), at: this.cursor });
      await this.hold(KEY_MS + Math.round(Math.random() * 30), KEY_STILL_MS);
    }
    await this.hold(200);
  }

  /** Clear a field and type a fresh value. */
  async fill(target: string | Locator, text: string): Promise<void> {
    await this.click(target, { settle: 120 });
    await this.page.keyboard.press("ControlOrMeta+a");
    // Clear it now: `type` presses the field again, and that press would
    // collapse the selection, leaving the old value in front of the new.
    await this.page.keyboard.press("Backspace");
    await this.type(target, text);
  }

  /** Choose an option in a native select: the popup itself does not paint into a screencast. */
  async select(target: string | Locator, option: { label: string } | { value: string }): Promise<void> {
    await this.click(target, { settle: 150 });
    await this.page.keyboard.press("Escape");
    await this.locate(target).first().selectOption(option);
    this.log({ kind: "key", t: this.now(), at: this.cursor });
    await this.settle(300);
  }

  /** Move the pointer over something without pressing. */
  async hover(target: string | Locator): Promise<void> {
    const locator = this.locate(target).first();
    await locator.waitFor({ state: "visible", timeout: 20_000 });
    await locator.scrollIntoViewIfNeeded();
    await this.glide(await this.centre(locator));
    await this.hold(250);
  }

  /** Glide the pointer to a spot on the page, out of the way of what is shown. */
  async moveTo(point: Point): Promise<void> {
    await this.glide(point);
    await this.hold(150);
  }

  /** Scroll the page so the element sits in view, smoothly. */
  async scrollTo(target: string | Locator): Promise<void> {
    const locator = this.locate(target).first();
    await locator.waitFor({ state: "attached", timeout: 20_000 });
    await locator.evaluate((el) => el.scrollIntoView({ behavior: "smooth", block: "center" }));
    await this.hold(700);
  }

  /** Wait until something is on screen (a result landing, a page arriving). */
  async waitFor(target: string | Locator, timeout = 30_000): Promise<void> {
    await this.locate(target).first().waitFor({ state: "visible", timeout });
    await this.settle();
  }

  /** Put a file on a file input: the OS dialog cannot be shown, so the pick is instant. */
  async attach(target: string | Locator, path: string): Promise<void> {
    const locator = this.locate(target).first();
    await this.hover(locator);
    this.log({ kind: "click", t: this.now(), at: this.cursor });
    await locator.setInputFiles(path);
    await this.settle(400);
  }

  private locate(target: string | Locator): Locator {
    return typeof target === "string" ? this.page.locator(target) : target;
  }

  private async centre(locator: Locator): Promise<Point> {
    const box = await locator.boundingBox();
    if (box === null) throw new Error("target has no box on screen");
    return { x: Math.round(box.x + box.width / 2), y: Math.round(box.y + box.height / 2) };
  }

  /**
   * The glide: real mouse and log agree on the path, the pace, and the
   * arrival. The pace is the clock's — while recording, each step is
   * credited rather than slept (`clock.ts`), since the cursor the clip shows
   * is drawn from the log and the real one only has to pass over what it
   * would light up.
   */
  private async glide(to: Point): Promise<void> {
    const from = this.cursor;
    const distance = Math.hypot(to.x - from.x, to.y - from.y);
    if (distance < 1) return;
    const duration = moveDuration(distance);
    const startedAt = this.now();
    const credit = this.recording && this.options.realTime !== true;
    // Each real move waits on the browser (a frame, near enough), so a credited glide takes only a few.
    const steps = credit ? GLIDE_STEPS : Math.max(2, Math.round(duration / 16));
    for (let i = 1; i <= steps; i++) {
      const u = i / steps;
      const eased = u < 0.5 ? 4 * u * u * u : 1 - Math.pow(-2 * u + 2, 3) / 2;
      await this.page.mouse.move(from.x + (to.x - from.x) * eased, from.y + (to.y - from.y) * eased);
      const wait = startedAt + duration * u - this.now();
      if (wait <= 0) continue;
      if (credit) this.clock.credit(wait, performance.now());
      else await sleep(wait);
    }
    this.cursor = to;
    this.log({ kind: "move", t: this.now(), duration, from, to });
  }

  private log(event: TakeEvent): void {
    if (this.recording) this.events.push(event);
  }
}
