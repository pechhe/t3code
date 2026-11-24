import type { ImageMark } from "~/lib/imageAnnotation";

export type Tool = "mark" | "arrow";
export type AnnotatorLayout = "callouts" | "rail";
type BoxHandle = "nw" | "ne" | "sw" | "se";
type ArrowHandle = "from" | "to";
export type Handle = BoxHandle | ArrowHandle;
export interface Point {
  x: number;
  y: number;
}
export interface Rect {
  left: number;
  top: number;
  width: number;
  height: number;
}

/** A press that travels less than this many pixels is a click, which drops a point. */
export const CLICK_TOLERANCE_PX = 7;
/** Marks at or past this count switch the editor to the side rail unless the user chose. */
const AUTO_RAIL_MARK_COUNT = 4;
/** Images wider than this ratio put their callouts in the stage margin, clear of the strip. */
const WIDE_ASPECT = 2.2;
const CALLOUT_WIDTH = 224;
const CALLOUT_HEIGHT = 58;
const CALLOUT_GAP = 12;
const HANDLE_HIT_PX = 10;
const POINT_HIT_PX = 14;
const ARROW_HIT_PX = 8;
const BOX_HIT_PX = 5;

export function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

/** Holding ⌘/Ctrl flips the tool for as long as it is held. */
export function effectiveTool(base: Tool, modifierHeld: boolean): Tool {
  if (!modifierHeld) return base;
  return base === "mark" ? "arrow" : "mark";
}

export function initialLayout(markCount: number): AnnotatorLayout {
  return markCount >= AUTO_RAIL_MARK_COUNT ? "rail" : "callouts";
}

/** Adding the fourth mark moves the notes to the rail, unless the user picked a layout. */
export function layoutAfterAdd(
  current: AnnotatorLayout,
  markCount: number,
  userPinned: boolean,
): AnnotatorLayout {
  return !userPinned && markCount >= AUTO_RAIL_MARK_COUNT ? "rail" : current;
}

interface MarkHistory {
  readonly marks: ReadonlyArray<ImageMark>;
  readonly past: ReadonlyArray<ReadonlyArray<ImageMark>>;
  readonly future: ReadonlyArray<ReadonlyArray<ImageMark>>;
}

export function createHistory(marks: ReadonlyArray<ImageMark>): MarkHistory {
  return { marks, past: [], future: [] };
}

/** Records a structural change (add, move, resize, delete, clear) as one undo step. */
export function commitMarks(history: MarkHistory, marks: ReadonlyArray<ImageMark>): MarkHistory {
  return { marks, past: [...history.past, history.marks], future: [] };
}

export function undoMarks(history: MarkHistory): MarkHistory {
  const previous = history.past.at(-1);
  if (!previous) return history;
  return {
    marks: previous,
    past: history.past.slice(0, -1),
    future: [history.marks, ...history.future],
  };
}

export function redoMarks(history: MarkHistory): MarkHistory {
  const next = history.future[0];
  if (!next) return history;
  return {
    marks: next,
    past: [...history.past, history.marks],
    future: history.future.slice(1),
  };
}

/** Note text is not an undo step; it follows the mark through every snapshot instead. */
export function setMarkNote(history: MarkHistory, id: string, note: string): MarkHistory {
  const patch = (marks: ReadonlyArray<ImageMark>) =>
    marks.map((mark) => (mark.id === id ? { ...mark, note } : mark));
  return {
    marks: patch(history.marks),
    past: history.past.map(patch),
    future: history.future.map(patch),
  };
}

function bounds(mark: ImageMark): { minX: number; maxX: number; minY: number; maxY: number } {
  switch (mark.kind) {
    case "point":
      return { minX: mark.x, maxX: mark.x, minY: mark.y, maxY: mark.y };
    case "box":
      return { minX: mark.x, maxX: mark.x + mark.width, minY: mark.y, maxY: mark.y + mark.height };
    case "arrow":
      return {
        minX: Math.min(mark.x, mark.toX),
        maxX: Math.max(mark.x, mark.toX),
        minY: Math.min(mark.y, mark.toY),
        maxY: Math.max(mark.y, mark.toY),
      };
  }
}

/** Shifts a mark by a fraction delta, stopping at the image edge without changing its shape. */
export function moveMark(mark: ImageMark, dx: number, dy: number): ImageMark {
  const { minX, maxX, minY, maxY } = bounds(mark);
  const shiftX = Math.min(1 - maxX, Math.max(-minX, dx));
  const shiftY = Math.min(1 - maxY, Math.max(-minY, dy));
  switch (mark.kind) {
    case "point":
      return { ...mark, x: mark.x + shiftX, y: mark.y + shiftY };
    case "box":
      return { ...mark, x: mark.x + shiftX, y: mark.y + shiftY };
    case "arrow":
      return {
        ...mark,
        x: mark.x + shiftX,
        y: mark.y + shiftY,
        toX: mark.toX + shiftX,
        toY: mark.toY + shiftY,
      };
  }
}

/** Drags one corner of a box to a point; the opposite corner stays put and the box may flip. */
export function resizeBox(mark: ImageMark, handle: BoxHandle, to: Point): ImageMark {
  if (mark.kind !== "box") return mark;
  const anchorX = handle === "nw" || handle === "sw" ? mark.x + mark.width : mark.x;
  const anchorY = handle === "nw" || handle === "ne" ? mark.y + mark.height : mark.y;
  const x = clamp01(to.x);
  const y = clamp01(to.y);
  return {
    ...mark,
    x: Math.min(anchorX, x),
    y: Math.min(anchorY, y),
    width: Math.abs(anchorX - x),
    height: Math.abs(anchorY - y),
  };
}

export function moveArrowEnd(mark: ImageMark, handle: ArrowHandle, to: Point): ImageMark {
  if (mark.kind !== "arrow") return mark;
  const x = clamp01(to.x);
  const y = clamp01(to.y);
  return handle === "from" ? { ...mark, x, y } : { ...mark, toX: x, toY: y };
}

export function boxFromCorners(start: Point, end: Point) {
  return {
    x: Math.min(start.x, end.x),
    y: Math.min(start.y, end.y),
    width: Math.abs(end.x - start.x),
    height: Math.abs(end.y - start.y),
  };
}

export function handlePositions(mark: ImageMark): Array<{ handle: Handle; x: number; y: number }> {
  if (mark.kind === "box") {
    return [
      { handle: "nw", x: mark.x, y: mark.y },
      { handle: "ne", x: mark.x + mark.width, y: mark.y },
      { handle: "sw", x: mark.x, y: mark.y + mark.height },
      { handle: "se", x: mark.x + mark.width, y: mark.y + mark.height },
    ];
  }
  if (mark.kind === "arrow") {
    return [
      { handle: "from", x: mark.x, y: mark.y },
      { handle: "to", x: mark.toX, y: mark.toY },
    ];
  }
  return [];
}

function distanceToSegment(p: Point, a: Point, b: Point): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const lengthSquared = dx * dx + dy * dy;
  const t =
    lengthSquared === 0
      ? 0
      : Math.min(1, Math.max(0, ((p.x - a.x) * dx + (p.y - a.y) * dy) / lengthSquared));
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}

/** The selected mark's handle under a pixel point, if any. */
export function hitHandle(
  mark: ImageMark | undefined,
  at: Point,
  width: number,
  height: number,
): Handle | null {
  if (!mark) return null;
  for (const position of handlePositions(mark)) {
    if (Math.hypot(position.x * width - at.x, position.y * height - at.y) <= HANDLE_HIT_PX) {
      return position.handle;
    }
  }
  return null;
}

/** The topmost mark under a pixel point: a box anywhere inside or on its border, a point's ring, an arrow's shaft. */
export function hitMark(
  marks: ReadonlyArray<ImageMark>,
  at: Point,
  width: number,
  height: number,
): ImageMark | null {
  for (const mark of marks.toReversed()) {
    const x = mark.x * width;
    const y = mark.y * height;
    if (mark.kind === "point") {
      if (Math.hypot(x - at.x, y - at.y) <= POINT_HIT_PX) return mark;
    } else if (mark.kind === "arrow") {
      const end = { x: mark.toX * width, y: mark.toY * height };
      if (distanceToSegment(at, { x, y }, end) <= ARROW_HIT_PX) return mark;
    } else if (
      at.x >= x - BOX_HIT_PX &&
      at.x <= x + mark.width * width + BOX_HIT_PX &&
      at.y >= y - BOX_HIT_PX &&
      at.y <= y + mark.height * height + BOX_HIT_PX
    ) {
      return mark;
    }
  }
  return null;
}

/** The pixel rectangle a mark occupies, padded for its stroke. */
function markRect(mark: ImageMark, width: number, height: number): Rect {
  const { minX, maxX, minY, maxY } = bounds(mark);
  const pad = mark.kind === "point" ? 12 : 4;
  return {
    left: minX * width - pad,
    top: minY * height - pad,
    width: (maxX - minX) * width + pad * 2,
    height: (maxY - minY) * height + pad * 2,
  };
}

function overlaps(a: Rect, b: Rect, gap = 0): boolean {
  return (
    a.left < b.left + b.width + gap &&
    b.left < a.left + a.width + gap &&
    a.top < b.top + b.height + gap &&
    b.top < a.top + a.height + gap
  );
}

function clampLeft(left: number, imageWidth: number): number {
  return Math.min(Math.max(0, imageWidth - CALLOUT_WIDTH), Math.max(0, left));
}

/**
 * Where each mark's note card sits, in pixels from the image's top-left. Wide strips put
 * cards in the stage margin above and below so none of the strip is covered; other images
 * put each card beside its mark, off the mark itself, nudged clear of earlier cards.
 */
export function placeCallouts(
  marks: ReadonlyArray<ImageMark>,
  width: number,
  height: number,
): Map<string, Rect> {
  const placed = new Map<string, Rect>();
  const rects: Rect[] = [];
  const wide = width / height > WIDE_ASPECT;
  const size = { width: CALLOUT_WIDTH, height: CALLOUT_HEIGHT };
  if (wide) {
    const lanes: Record<"above" | "below", Rect[]> = { above: [], below: [] };
    marks.forEach((mark, index) => {
      const lane = index % 2 === 0 ? "below" : "above";
      const center = markRect(mark, width, height);
      let left = clampLeft(center.left + center.width / 2 - CALLOUT_WIDTH / 2, width);
      for (const taken of lanes[lane].toSorted((a, b) => a.left - b.left)) {
        if (left < taken.left + taken.width + 8 && taken.left < left + CALLOUT_WIDTH + 8) {
          left = taken.left + taken.width + 8;
        }
      }
      const top = lane === "below" ? height + CALLOUT_GAP : -CALLOUT_HEIGHT - CALLOUT_GAP;
      const rect = { left, top, ...size };
      lanes[lane].push(rect);
      placed.set(mark.id, rect);
    });
    return placed;
  }
  for (const mark of marks) {
    const own = markRect(mark, width, height);
    const centerX = own.left + own.width / 2;
    const candidates: Rect[] = [
      {
        left: clampLeft(centerX - CALLOUT_WIDTH / 2, width),
        top: own.top + own.height + CALLOUT_GAP,
        ...size,
      },
      {
        left: clampLeft(centerX - CALLOUT_WIDTH / 2, width),
        top: own.top - CALLOUT_HEIGHT - CALLOUT_GAP,
        ...size,
      },
      { left: own.left + own.width + CALLOUT_GAP, top: own.top, ...size },
      { left: own.left - CALLOUT_WIDTH - CALLOUT_GAP, top: own.top, ...size },
    ];
    const fits = (rect: Rect) =>
      rect.left >= 0 &&
      rect.top >= 0 &&
      rect.left + rect.width <= width &&
      rect.top + rect.height <= height;
    const free = (rect: Rect) =>
      !overlaps(rect, own) && rects.every((other) => !overlaps(rect, other, 6));
    let choice = candidates.find((rect) => fits(rect) && free(rect));
    if (!choice) {
      const fallback = candidates[0]!;
      choice = {
        ...fallback,
        top: Math.min(Math.max(0, fallback.top), Math.max(0, height - CALLOUT_HEIGHT)),
      };
      for (const other of rects) {
        if (overlaps(choice, other, 6)) {
          const below = other.top + other.height + 6;
          const top = below + CALLOUT_HEIGHT <= height ? below : other.top - CALLOUT_HEIGHT - 6;
          choice = {
            ...choice,
            top: Math.min(Math.max(0, top), Math.max(0, height - CALLOUT_HEIGHT)),
          };
        }
      }
    }
    rects.push(choice);
    placed.set(mark.id, choice);
  }
  return placed;
}

/** The pixel line joining a mark to its note card, ending on each one's nearest edge. */
export function leaderLine(
  mark: ImageMark,
  card: Rect,
  width: number,
  height: number,
): { x1: number; y1: number; x2: number; y2: number } {
  const cardCenter = { x: card.left + card.width / 2, y: card.top + card.height / 2 };
  let from: Point;
  if (mark.kind === "box") {
    const left = mark.x * width;
    const top = mark.y * height;
    from = {
      x: Math.min(left + mark.width * width, Math.max(left, cardCenter.x)),
      y: Math.min(top + mark.height * height, Math.max(top, cardCenter.y)),
    };
  } else if (mark.kind === "arrow") {
    from = { x: ((mark.x + mark.toX) / 2) * width, y: ((mark.y + mark.toY) / 2) * height };
  } else {
    from = { x: mark.x * width, y: mark.y * height };
  }
  return {
    x1: from.x,
    y1: from.y,
    x2: Math.min(card.left + card.width, Math.max(card.left, from.x)),
    y2: Math.min(card.top + card.height, Math.max(card.top, from.y)),
  };
}

/** The pixel geometry of an arrow: a shaft stopping short of its head, and the head's triangle. */
export function arrowGeometry(
  mark: Extract<ImageMark, { kind: "arrow" }>,
  width: number,
  height: number,
): { x1: number; y1: number; x2: number; y2: number; head: string } {
  const x1 = mark.x * width;
  const y1 = mark.y * height;
  const tipX = mark.toX * width;
  const tipY = mark.toY * height;
  const length = Math.hypot(tipX - x1, tipY - y1);
  const angle = Math.atan2(tipY - y1, tipX - x1);
  const headLength = Math.min(15, length * 0.7);
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  const baseX = tipX - cos * headLength;
  const baseY = tipY - sin * headLength;
  const spread = headLength * 0.5;
  const round = (value: number) => Math.round(value * 100) / 100;
  const head = [
    [tipX, tipY],
    [baseX - sin * spread, baseY + cos * spread],
    [baseX + sin * spread, baseY - cos * spread],
  ]
    .map(([x, y]) => round(x!) + "," + round(y!))
    .join(" ");
  return {
    x1,
    y1,
    x2: tipX - cos * headLength * 0.6,
    y2: tipY - sin * headLength * 0.6,
    head,
  };
}
