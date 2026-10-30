/**
 * Where the page sits on the canvas.
 *
 * Two renders come from one take. `backdrop` is the marketing cut: the app
 * as a rounded, shadowed window on a soft gradient, a margin of canvas
 * around it. `bleed` is the docs cut: the app edge to edge. Both are 16:9
 * at 1920×1080 from a 16:9 viewport, so nothing is cropped in either — the
 * camera's zoom is the only crop, and it is the same in both.
 */

export type Variant = "backdrop" | "bleed";

export interface Rect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export interface Canvas {
  readonly width: number;
  readonly height: number;
}

export const CANVAS: Canvas = { width: 1920, height: 1080 };

/** The viewport a take records at: 16:9, the dashboard's comfortable desktop width. */
export const VIEWPORT = { width: 1600, height: 900 } as const;

/** Pixels per CSS pixel the browser renders at, so a 1.8× zoom stays crisp. */
export const DEVICE_SCALE = 2;

/** The window the page is drawn into, per variant. */
export const windowRect = (variant: Variant, canvas: Canvas = CANVAS): Rect => {
  if (variant === "bleed") return { x: 0, y: 0, width: canvas.width, height: canvas.height };
  const margin = Math.round(canvas.height * 0.075);
  const height = canvas.height - margin * 2;
  const width = Math.round((height * VIEWPORT.width) / VIEWPORT.height);
  return { x: Math.round((canvas.width - width) / 2), y: margin, width, height };
};

/** Corner radius of the window: only the backdrop cut has corners to round. */
export const windowRadius = (variant: Variant): number => (variant === "bleed" ? 0 : 14);

/**
 * A point in viewport CSS pixels, as it lands on the canvas when the camera
 * shows `view` (a sub-rectangle of the viewport) inside `window`.
 */
export const project = (
  point: { x: number; y: number },
  view: Rect,
  window: Rect,
): { x: number; y: number } => ({
  x: window.x + ((point.x - view.x) / view.width) * window.width,
  y: window.y + ((point.y - view.y) / view.height) * window.height,
});

/** How much bigger one viewport pixel is on the canvas right now. */
export const magnification = (view: Rect, window: Rect): number => window.width / view.width;
