import { describe, expect, it } from "vite-plus/test";

import type { ImageMark } from "~/lib/imageAnnotation";

import {
  arrowGeometry,
  commitMarks,
  createHistory,
  effectiveTool,
  hitHandle,
  hitMark,
  initialLayout,
  layoutAfterAdd,
  leaderLine,
  moveArrowEnd,
  moveMark,
  placeCallouts,
  redoMarks,
  resizeBox,
  setMarkNote,
  undoMarks,
} from "./imageAnnotator.logic";

const box: ImageMark = {
  id: "b",
  kind: "box",
  x: 0.25,
  y: 0.25,
  width: 0.25,
  height: 0.25,
  note: "",
};
const point: ImageMark = { id: "p", kind: "point", x: 0.8, y: 0.8, note: "" };
const arrow: ImageMark = { id: "a", kind: "arrow", x: 0.1, y: 0.9, toX: 0.5, toY: 0.9, note: "" };

describe("effective tool and layout", () => {
  it("flips the tool while the modifier is held", () => {
    expect(effectiveTool("mark", false)).toBe("mark");
    expect(effectiveTool("mark", true)).toBe("arrow");
    expect(effectiveTool("arrow", true)).toBe("mark");
  });

  it("starts on the rail from four marks and switches there on the fourth add unless pinned", () => {
    expect(initialLayout(3)).toBe("callouts");
    expect(initialLayout(4)).toBe("rail");
    expect(layoutAfterAdd("callouts", 3, false)).toBe("callouts");
    expect(layoutAfterAdd("callouts", 4, false)).toBe("rail");
    expect(layoutAfterAdd("callouts", 4, true)).toBe("callouts");
  });
});

describe("history", () => {
  it("undoes and redoes structural changes", () => {
    const added = commitMarks(createHistory([]), [box]);
    const moved = commitMarks(added, [moveMark(box, 0.1, 0)]);
    expect(undoMarks(moved).marks).toEqual([box]);
    expect(undoMarks(undoMarks(moved)).marks).toEqual([]);
    expect(redoMarks(undoMarks(moved)).marks).toEqual(moved.marks);
    expect(undoMarks(createHistory([])).marks).toEqual([]);
    expect(redoMarks(moved)).toBe(moved);
  });

  it("drops redo history on a new change and keeps notes through undo", () => {
    const added = commitMarks(createHistory([]), [box]);
    const noted = setMarkNote(added, "b", "fix");
    const cleared = commitMarks(noted, []);
    expect(undoMarks(cleared).marks[0]?.note).toBe("fix");
    expect(undoMarks(undoMarks(setMarkNote(cleared, "b", "later"))).marks).toEqual([]);
    expect(undoMarks(setMarkNote(cleared, "b", "later")).marks[0]?.note).toBe("later");
    expect(commitMarks(undoMarks(cleared), [point]).future).toEqual([]);
  });
});

describe("direct manipulation", () => {
  it("moves a mark without leaving the image or changing its shape", () => {
    expect(moveMark(box, 5, -5)).toMatchObject({ x: 0.75, y: 0, width: 0.25, height: 0.25 });
    expect(moveMark(arrow, -5, 0.5)).toMatchObject({ x: 0, toX: 0.4, y: 1, toY: 1 });
    expect(moveMark(point, 0.125, -0.125)).toMatchObject({ x: 0.925, y: 0.675 });
  });

  it("resizes a box from a corner and flips past the opposite corner", () => {
    expect(resizeBox(box, "se", { x: 0.75, y: 0.5 })).toMatchObject({
      x: 0.25,
      y: 0.25,
      width: 0.5,
      height: 0.25,
    });
    const flipped = resizeBox(box, "nw", { x: 0.75, y: 0.75 });
    expect(flipped).toMatchObject({ x: 0.5, y: 0.5, width: 0.25, height: 0.25 });
    expect(resizeBox(box, "se", { x: 2, y: -1 })).toMatchObject({
      width: 0.75,
      y: 0,
      height: 0.25,
    });
  });

  it("moves one arrow end", () => {
    expect(moveArrowEnd(arrow, "to", { x: 0.7, y: 0.4 })).toMatchObject({
      x: 0.1,
      toX: 0.7,
      toY: 0.4,
    });
    expect(moveArrowEnd(arrow, "from", { x: 0.3, y: 0.3 })).toMatchObject({
      x: 0.3,
      y: 0.3,
      toX: 0.5,
    });
  });

  it("hits boxes inside and on the border, points, arrow shafts and handles", () => {
    const marks = [box, point, arrow];
    expect(hitMark(marks, { x: 30, y: 30 }, 100, 100)?.id).toBe("b");
    expect(hitMark(marks, { x: 21, y: 30 }, 100, 100)?.id).toBe("b");
    expect(hitMark(marks, { x: 82, y: 78 }, 100, 100)?.id).toBe("p");
    expect(hitMark(marks, { x: 30, y: 92 }, 100, 100)?.id).toBe("a");
    expect(hitMark(marks, { x: 60, y: 50 }, 100, 100)).toBeNull();
    expect(hitHandle(box, { x: 50, y: 50 }, 100, 100)).toBe("se");
    expect(hitHandle(arrow, { x: 10, y: 90 }, 100, 100)).toBe("from");
    expect(hitHandle(point, { x: 80, y: 80 }, 100, 100)).toBeNull();
  });
});

describe("arrow geometry", () => {
  it("ends the shaft inside a head that points at the tip", () => {
    const geometry = arrowGeometry({ ...arrow, x: 0, y: 0.5, toX: 1, toY: 0.5 }, 100, 100);
    expect(geometry.x2).toBeLessThan(100);
    expect(geometry.x2).toBeGreaterThan(85);
    expect(geometry.head.startsWith("100,50 ")).toBe(true);
  });
});

describe("callout placement", () => {
  it("puts cards for a wide strip in the margin, above and below, clear of the image", () => {
    const strip: ImageMark[] = [
      { ...box, id: "1", x: 0.1 },
      { ...box, id: "2", x: 0.12 },
      { ...box, id: "3", x: 0.14 },
    ];
    const placed = placeCallouts(strip, 1000, 200);
    const rects = strip.map((mark) => placed.get(mark.id)!);
    expect(rects[0]!.top).toBeGreaterThanOrEqual(200);
    expect(rects[1]!.top + rects[1]!.height).toBeLessThanOrEqual(0);
    expect(rects[2]!.left).toBeGreaterThan(rects[0]!.left + 200);
    for (const rect of rects) expect(rect.left).toBeGreaterThanOrEqual(0);
  });

  it("places cards beside marks without covering them or each other", () => {
    const marks: ImageMark[] = [
      { ...box, id: "1", x: 0.1, y: 0.1 },
      { ...box, id: "2", x: 0.12, y: 0.1 },
      { ...point, id: "3", x: 0.9, y: 0.95 },
    ];
    const placed = placeCallouts(marks, 800, 600);
    const [first, second, third] = marks.map((mark) => placed.get(mark.id)!);
    expect(first!.top).toBeGreaterThanOrEqual(0.3 * 600);
    expect(
      second!.top >= first!.top + first!.height || second!.left >= first!.left + first!.width,
    ).toBe(true);
    expect(third!.top + third!.height).toBeLessThanOrEqual(600);
    expect(third!.left + third!.width).toBeLessThanOrEqual(800);
  });

  it("joins a mark to the nearest edge of its card", () => {
    const line = leaderLine(box, { left: 100, top: 600, width: 224, height: 58 }, 1000, 1000);
    expect(line).toEqual({ x1: 250, y1: 500, x2: 250, y2: 600 });
  });
});
