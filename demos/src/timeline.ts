/**
 * The motion of a clip, derived from what the take logged.
 *
 * A take records three things against one clock: the page frames the
 * browser painted, where the cursor was sent and when it arrived, and the
 * moments something happened (a click, a keystroke, a deliberate reveal).
 * Everything smooth is computed here, per output frame, from that log:
 * the cursor glides between its keyframes on an ease-in-out, a click grows a
 * ripple, and the camera zooms toward the work the way Screen Studio does —
 * in on a click, panning to the next one, and staying close through the
 * scrolls and waits of a step until the take reveals the whole screen — so a
 * 60fps render never depends on how often the page repainted.
 */

export interface Point {
  readonly x: number;
  readonly y: number;
}

/** A cursor keyframe: the cursor is at `to` by `t`, having left `from` at `t - duration`. */
export interface CursorMove {
  readonly kind: "move";
  readonly t: number;
  readonly duration: number;
  readonly from: Point;
  readonly to: Point;
}

export interface Click {
  readonly kind: "click";
  readonly t: number;
  readonly at: Point;
}

/** Typing: keeps the camera on the field without a ripple. */
export interface Key {
  readonly kind: "key";
  readonly t: number;
  readonly at: Point;
}

/** A step's end: the take wants the whole screen seen from `t`. The only way out of a zoom. */
export interface Reveal {
  readonly kind: "reveal";
  readonly t: number;
}

export type TakeEvent = CursorMove | Click | Key | Reveal;

export const easeInOutCubic = (u: number): number =>
  u < 0.5 ? 4 * u * u * u : 1 - Math.pow(-2 * u + 2, 3) / 2;

export const easeOutCubic = (u: number): number => 1 - Math.pow(1 - u, 3);

const clamp01 = (u: number) => Math.min(1, Math.max(0, u));

const lerp = (a: number, b: number, u: number) => a + (b - a) * u;

/** How long the cursor takes to cross `distance` pixels: quick, never abrupt. */
export const moveDuration = (distance: number): number =>
  Math.min(900, Math.max(320, 260 + distance * 0.55));

/** Where the cursor is at `t`: mid-glide on its ease, or resting where it last arrived. */
export const cursorAt = (moves: ReadonlyArray<CursorMove>, t: number, initial: Point): Point => {
  let position = initial;
  for (const move of moves) {
    const start = move.t - move.duration;
    if (t < start) break;
    if (t >= move.t) {
      position = move.to;
      continue;
    }
    const u = easeInOutCubic(clamp01((t - start) / move.duration));
    return { x: lerp(move.from.x, move.to.x, u), y: lerp(move.from.y, move.to.y, u) };
  }
  return position;
};

export const RIPPLE_MS = 380;

/** The click ripples alive at `t`: radius grows, alpha fades, both on an ease-out. */
export const ripplesAt = (
  events: ReadonlyArray<TakeEvent>,
  t: number,
): ReadonlyArray<{ at: Point; radius: number; alpha: number }> =>
  events.flatMap((event) => {
    if (event.kind !== "click" || t < event.t || t > event.t + RIPPLE_MS) return [];
    const u = easeOutCubic((t - event.t) / RIPPLE_MS);
    return [{ at: event.at, radius: 6 + 26 * u, alpha: 0.55 * (1 - u) }];
  });

/** The camera: where it looks and how close. `scale` 1 is the whole viewport. */
export interface Camera {
  readonly focus: Point;
  readonly scale: number;
}

export interface CameraKeyframe extends Camera {
  readonly t: number;
}

export interface ZoomPolicy {
  /** How close a click brings the camera. */
  readonly scale: number;
  /** Ease-in ahead of the first click of a step: the camera is there when the click lands. */
  readonly zoomInMs: number;
  /** Pan ahead of a further click while zoomed. */
  readonly panMs: number;
  /** Ease-out on a reveal. */
  readonly zoomOutMs: number;
}

export const DEFAULT_ZOOM: ZoomPolicy = {
  scale: 1.8,
  zoomInMs: 520,
  panMs: 460,
  zoomOutMs: 640,
};

/**
 * Keyframes the camera passes through, from the moments in the log. A click
 * or keystroke while wide zooms in on it; while close, it pans there and
 * otherwise holds — a scroll, a page arriving, a pause all stay close — and
 * only a reveal, which the flow logs when a minor step is done, zooms back
 * out. The camera *leads* the hand: it sets off `zoomInMs` (or `panMs`)
 * before the click and is settled on the target as the click lands, so the
 * action happens in a still, close frame rather than mid-zoom. Every keyframe
 * is the camera's state *at* `t`, reached from the previous one by its own
 * ease.
 */
export const cameraKeyframes = (
  events: ReadonlyArray<TakeEvent>,
  viewport: { width: number; height: number },
  policy: ZoomPolicy = DEFAULT_ZOOM,
): ReadonlyArray<CameraKeyframe> => {
  const wide: Camera = { focus: { x: viewport.width / 2, y: viewport.height / 2 }, scale: 1 };
  const frames: CameraKeyframe[] = [{ t: 0, ...wide }];
  let close = false;
  const moments = events
    .filter((event): event is Click | Key | Reveal => event.kind !== "move")
    .sort((a, b) => a.t - b.t);
  for (const moment of moments) {
    if (moment.kind === "reveal") {
      if (close) {
        frames.push({ ...frames[frames.length - 1]!, t: moment.t });
        frames.push({ t: moment.t + policy.zoomOutMs, ...wide });
        close = false;
      }
      continue;
    }
    const target: Camera = { focus: moment.at, scale: policy.scale };
    const lead = close ? policy.panMs : policy.zoomInMs;
    let last = frames[frames.length - 1]!;
    if (moment.t < last.t) {
      // A reveal's zoom-out is still in flight: cut it short where it has got to and turn back.
      const prior = frames[frames.length - 2]!;
      const departAt = Math.max(prior.t, moment.t - lead);
      const state = cameraAt(frames, departAt);
      frames.pop();
      if (departAt > prior.t) frames.push({ t: departAt, ...state });
      frames.push({ t: moment.t, ...target });
      close = true;
      continue;
    }
    if (last.scale === target.scale && last.focus.x === target.focus.x && last.focus.y === target.focus.y) continue;
    // Set off early enough to arrive as the moment lands, but never before the camera last settled.
    const departAt = Math.max(last.t, moment.t - lead);
    if (departAt > last.t) frames.push({ ...last, t: departAt });
    frames.push({ t: moment.t, ...target });
    close = true;
  }
  return frames;
};

/** The camera at `t`, eased between the keyframes either side of it. */
export const cameraAt = (keyframes: ReadonlyArray<CameraKeyframe>, t: number): Camera => {
  const first = keyframes[0];
  if (first === undefined) return { focus: { x: 0, y: 0 }, scale: 1 };
  if (t <= first.t) return first;
  for (let i = 1; i < keyframes.length; i++) {
    const to = keyframes[i]!;
    if (t > to.t) continue;
    const from = keyframes[i - 1]!;
    const span = to.t - from.t;
    const u = span <= 0 ? 1 : easeInOutCubic(clamp01((t - from.t) / span));
    return {
      focus: { x: lerp(from.focus.x, to.focus.x, u), y: lerp(from.focus.y, to.focus.y, u) },
      scale: lerp(from.scale, to.scale, u),
    };
  }
  return keyframes[keyframes.length - 1]!;
};

/**
 * The part of the viewport the camera shows: `1/scale` of it, centred on the
 * focus but never past an edge, so a click near the corner zooms to the
 * corner rather than to a band of nothing beside it.
 */
export const viewRect = (
  camera: Camera,
  viewport: { width: number; height: number },
): { x: number; y: number; width: number; height: number } => {
  const width = viewport.width / camera.scale;
  const height = viewport.height / camera.scale;
  const x = Math.min(Math.max(0, camera.focus.x - width / 2), viewport.width - width);
  const y = Math.min(Math.max(0, camera.focus.y - height / 2), viewport.height - height);
  return { x, y, width, height };
};

/** A captured page frame: what the page looked like from `t` on. */
export interface FrameRef {
  readonly t: number;
  readonly file: string;
}

/** The page frame showing at `t`: the latest painted at or before it. */
export const frameAt = (frames: ReadonlyArray<FrameRef>, t: number): FrameRef | undefined => {
  let low = 0;
  let high = frames.length - 1;
  let found: FrameRef | undefined;
  while (low <= high) {
    const mid = (low + high) >> 1;
    const frame = frames[mid]!;
    if (frame.t <= t) {
      found = frame;
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }
  return found ?? frames[0];
};
