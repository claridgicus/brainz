/**
 * The render: a take's frames and log become a 60fps clip.
 *
 * For every sixtieth of a second the compositor asks the timeline three
 * questions — which page frame is showing, where the cursor is, where the
 * camera looks — and paints the answer onto a canvas: backdrop (or not), the
 * page cropped to the camera's view and scaled into the window, the click
 * ripples, the cursor. The raw pixels stream into ffmpeg, which writes an
 * H.264 MP4 the browsers all play. One take renders both variants.
 *
 * A render can be one span of the clip's frames (`from`/`to`), so a long
 * clip renders as segments side by side on every core and `concatenate`
 * joins them without re-encoding: each segment opens on a keyframe with the
 * same encoder settings, so the joined stream is the one a single render
 * would have written.
 */
import { execFileSync, spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createCanvas, loadImage, type Image, type SKRSContext2D } from "@napi-rs/canvas";
import { CANVAS, magnification, project, windowRadius, windowRect, type Rect, type Variant } from "./layout.js";
import type { TakeLog } from "./take.js";
import {
  cameraAt,
  cameraKeyframes,
  cursorAt,
  frameAt,
  ripplesAt,
  viewRect,
  type CursorMove,
} from "./timeline.js";

export const FPS = 60;

/** A beat of stillness at either end, so the clip does not start or stop mid-motion. */
const LEAD_MS = 600;
const TAIL_MS = 1200;

export interface ComposeOptions {
  /** The take's directory: `take.json` and `frames/`. */
  readonly dir: string;
  readonly variant: Variant;
  readonly output: string;
  /**
   * A still for `<video poster>`. The marketing cut's is taken once the
   * first zoom is over; the bleed cut's is its very first frame — the whole
   * app at rest, before the camera moves — since a page that plays the bleed
   * cut shows the poster where the video's first frame will appear. WebP, at
   * {@link POSTER_QUALITY}: the home page's first paint is one of these, and
   * a JPEG of the same screen was two and a half times the size.
   */
  readonly poster?: string;
  readonly ffmpeg?: string;
  /** Progress, one line per second of clip. */
  readonly onProgress?: (seconds: number, total: number) => void;
  /** The first output frame to render (default 0) and the one after the last (default the clip's end). */
  readonly from?: number;
  readonly to?: number;
  /** Encoder threads: a few each when many renders share the machine (default: ffmpeg's choice). */
  readonly threads?: number;
}

/** How long a take's clip runs, in output frames: the take plus its lead and tail. */
export const frameCountOf = (log: Pick<TakeLog, "duration">): number =>
  Math.ceil(((log.duration + LEAD_MS + TAIL_MS) / 1000) * FPS);

/**
 * Join segments rendered by {@link compose} (in order, each with its length
 * in output frames) into one MP4, without re-encoding. Each segment's length
 * is stated, not read from the file, so the next one starts on its own frame
 * even when the last starts and ends on one held frame. Synchronous for the
 * same reason the renders are children.
 */
export const concatenate = (
  segments: ReadonlyArray<{ readonly file: string; readonly frames: number }>,
  output: string,
  listFile: string,
  ffmpeg = "ffmpeg",
): void => {
  const lines = segments.flatMap(({ file, frames }) => [`file '${file.replaceAll("'", "'\\''")}'`, `duration ${(frames / FPS).toFixed(6)}`]);
  writeFileSync(listFile, "ffconcat version 1.0\n" + lines.join("\n") + "\n");
  execFileSync(
    ffmpeg,
    ["-hide_banner", "-loglevel", "error", "-y", "-f", "concat", "-safe", "0", "-i", listFile, "-c", "copy", "-movflags", "+faststart", output],
    { stdio: ["ignore", "inherit", "inherit"] },
  );
};

const roundedRect = (ctx: SKRSContext2D, rect: Rect, radius: number) => {
  const { x, y, width, height } = rect;
  ctx.beginPath();
  ctx.moveTo(x + radius, y);
  ctx.arcTo(x + width, y, x + width, y + height, radius);
  ctx.arcTo(x + width, y + height, x, y + height, radius);
  ctx.arcTo(x, y + height, x, y, radius);
  ctx.arcTo(x, y, x + width, y, radius);
  ctx.closePath();
};

const paintBackdrop = (ctx: SKRSContext2D) => {
  const gradient = ctx.createLinearGradient(0, 0, CANVAS.width, CANVAS.height);
  // Brainz's dark violet, so the app's own dark chrome sits on its kin.
  gradient.addColorStop(0, "#1b1530");
  gradient.addColorStop(0.5, "#2a1f4a");
  gradient.addColorStop(1, "#3a1d3a");
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, CANVAS.width, CANVAS.height);
};

const paintWindowShadow = (ctx: SKRSContext2D, rect: Rect, radius: number) => {
  ctx.save();
  ctx.shadowColor = "rgba(0, 0, 0, 0.55)";
  ctx.shadowBlur = 60;
  ctx.shadowOffsetY = 24;
  ctx.fillStyle = "#0e0e11";
  roundedRect(ctx, rect, radius);
  ctx.fill();
  ctx.restore();
};

/** A pointer arrow, drawn in canvas pixels with its tip at (0, 0). */
const paintCursor = (ctx: SKRSContext2D, at: { x: number; y: number }, size: number) => {
  ctx.save();
  ctx.translate(at.x, at.y);
  ctx.scale(size / 20, size / 20);
  ctx.beginPath();
  ctx.moveTo(0, 0);
  ctx.lineTo(0, 17);
  ctx.lineTo(4.4, 13.2);
  ctx.lineTo(7.3, 19.5);
  ctx.lineTo(10.2, 18.2);
  ctx.lineTo(7.4, 12);
  ctx.lineTo(12.6, 12);
  ctx.closePath();
  // A light arrow with a dark rim: the app is dark, so the usual black arrow would vanish.
  ctx.fillStyle = "#ffffff";
  ctx.strokeStyle = "#111111";
  ctx.lineWidth = 1.6;
  ctx.lineJoin = "round";
  ctx.shadowColor = "rgba(0,0,0,0.35)";
  ctx.shadowBlur = 3;
  ctx.shadowOffsetY = 1;
  ctx.fill();
  ctx.shadowColor = "transparent";
  ctx.stroke();
  ctx.restore();
};

/** The posters' WebP quality: clean on text, under half the old JPEG's size. */
const POSTER_QUALITY = 82;

/** A frame image cache: consecutive output frames mostly share one page frame. */
const frameLoader = (dir: string) => {
  let last: { file: string; image: Image } | null = null;
  return async (file: string): Promise<Image> => {
    if (last !== null && last.file === file) return last.image;
    const image = await loadImage(await readFile(join(dir, file)));
    last = { file, image };
    return image;
  };
};

export const compose = async (options: ComposeOptions): Promise<{ seconds: number }> => {
  const log = JSON.parse(await readFile(join(options.dir, "take.json"), "utf8")) as TakeLog;
  const window = windowRect(options.variant);
  const radius = windowRadius(options.variant);
  const moves = log.events.filter((event): event is CursorMove => event.kind === "move");
  const keyframes = cameraKeyframes(log.events, log.viewport);
  const load = frameLoader(options.dir);
  const frameCount = frameCountOf(log);
  const seconds = frameCount / FPS;
  const from = Math.max(0, options.from ?? 0);
  const to = Math.min(frameCount, options.to ?? frameCount);
  const firstZoomOut = keyframes.find((k, i) => i > 0 && k.scale === 1 && keyframes[i - 1]!.scale !== 1);
  const posterAt =
    options.variant === "bleed" ? -LEAD_MS : firstZoomOut === undefined ? LEAD_MS : firstZoomOut.t + LEAD_MS;

  // Inherits this process's CPU affinity: under `mheavy` (or `DEMOS_CPUS`,
  // see cli.ts) that is the job's 8-core block, so x264 never lands on the
  // desktop's cores.
  const ffmpeg = spawn(
    options.ffmpeg ?? "ffmpeg",
    [
      "-hide_banner",
      "-loglevel",
      "error",
      "-y",
      "-f",
      "rawvideo",
      "-pix_fmt",
      "rgba",
      "-s",
      `${CANVAS.width}x${CANVAS.height}`,
      "-r",
      String(FPS),
      "-i",
      "-",
      // A segment the clip goes on after drops the repeats of a held frame
      // before they are encoded — most of a clip is holds, and x264 spends
      // nearly as long on a repeat as on a change — leaving each kept frame
      // on screen until the next. Only exact repeats: `concatenate` puts the
      // next segment where it belongs, so the hold a segment ends on keeps
      // its length. The clip's last segment keeps every frame, or its final
      // hold would end on its first.
      ...(to < frameCount ? ["-vf", "mpdecimate=hi=0:lo=0:frac=0:max=0", "-fps_mode", "vfr"] : []),
      "-an",
      "-c:v",
      "libx264",
      "-preset",
      "medium",
      "-crf",
      "19",
      ...(options.threads === undefined ? [] : ["-threads", String(options.threads)]),
      "-pix_fmt",
      "yuv420p",
      "-movflags",
      "+faststart",
      options.output,
    ],
    { stdio: ["pipe", "inherit", "pipe"] },
  );
  let stderr = "";
  ffmpeg.stderr.on("data", (chunk: Buffer) => {
    stderr += chunk.toString();
  });
  const exited = new Promise<number>((resolve, reject) => {
    ffmpeg.on("error", reject);
    ffmpeg.on("close", (code) => resolve(code ?? -1));
  });
  /** Write a frame, waiting for the pipe to drain when ffmpeg is behind. */
  const write = (pixels: Buffer) =>
    new Promise<void>((resolve, reject) => {
      const ok = ffmpeg.stdin.write(pixels, (error) => {
        if (error) reject(error);
      });
      if (ok) resolve();
      else ffmpeg.stdin.once("drain", resolve);
    });

  const canvas = createCanvas(CANVAS.width, CANVAS.height);
  const ctx = canvas.getContext("2d");
  // What never moves — the backdrop and the window's shadow — painted once and copied under every frame.
  const ground = createCanvas(CANVAS.width, CANVAS.height);
  const groundCtx = ground.getContext("2d");
  if (options.variant === "backdrop") {
    paintBackdrop(groundCtx);
    paintWindowShadow(groundCtx, window, radius);
  } else {
    groundCtx.fillStyle = "#0e0e11"; // --bg
    groundCtx.fillRect(0, 0, CANVAS.width, CANVAS.height);
  }
  // A held moment repeats its pixels rather than painting them again: most of a clip is holds.
  let last: { key: string; pixels: Buffer } | null = null;
  // Only the segment the poster's moment falls in writes it (the last one, should it fall past the end).
  const posterFrame = Math.min(frameCount - 1, Math.max(0, Math.ceil(((posterAt + LEAD_MS) / 1000) * FPS)));
  let posterWritten = options.poster === undefined || posterFrame < from || posterFrame >= to;
  let lastSecond = -1;

  for (let i = from; i < to; i++) {
    const second = Math.floor(i / FPS);
    if (second !== lastSecond) {
      lastSecond = second;
      options.onProgress?.(second, Math.ceil(seconds));
    }
    const t = (i / FPS) * 1000 - LEAD_MS;
    const takeT = Math.min(Math.max(0, t), log.duration);
    const page = frameAt(log.frames, takeT);
    const camera = cameraAt(keyframes, takeT);
    const view = viewRect(camera, log.viewport);
    const cursor = cursorAt(moves, takeT, log.initial);
    const ripples = ripplesAt(log.events, takeT);
    const key =
      ripples.length > 0
        ? null
        : [page?.file, view.x, view.y, view.width, view.height, cursor.x, cursor.y].map((n) => (typeof n === "number" ? n.toFixed(2) : n)).join(" ");
    const wantsPoster = !posterWritten && options.poster !== undefined && i >= posterFrame;
    if (key !== null && last !== null && key === last.key && !wantsPoster) {
      await write(last.pixels);
      continue;
    }

    ctx.drawImage(ground, 0, 0);

    ctx.save();
    roundedRect(ctx, window, radius);
    ctx.clip();
    if (page !== undefined) {
      const image = await load(page.file);
      const sx = image.width / log.viewport.width;
      const sy = image.height / log.viewport.height;
      ctx.drawImage(
        image,
        view.x * sx,
        view.y * sy,
        view.width * sx,
        view.height * sy,
        window.x,
        window.y,
        window.width,
        window.height,
      );
    }
    const scale = magnification(view, window);
    for (const ripple of ripples) {
      const at = project(ripple.at, view, window);
      ctx.beginPath();
      ctx.arc(at.x, at.y, ripple.radius * scale, 0, Math.PI * 2);
      ctx.fillStyle = `rgba(167, 139, 250, ${ripple.alpha.toFixed(3)})`; // --accent
      ctx.fill();
    }
    ctx.restore();

    // The cursor scales gently with the zoom: bigger when close, never comic.
    paintCursor(ctx, project(cursor, view, window), 22 * (0.85 + scale * 0.35));

    const pixels = canvas.data(); // a copy: the next frame's paint cannot reach it
    await write(pixels);
    last = key === null ? null : { key, pixels };

    if (!posterWritten && options.poster !== undefined && i >= posterFrame) {
      await writeFile(options.poster, await canvas.encode("webp", POSTER_QUALITY));
      posterWritten = true;
    }
  }
  ffmpeg.stdin.end();
  const code = await exited;
  if (code !== 0) throw new Error(`ffmpeg exited ${code}: ${stderr}`);
  return { seconds };
};
