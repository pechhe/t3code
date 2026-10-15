import { describe, expect, it } from "vite-plus/test";

import { drawImageMarks, notedMarks, toAnnotationMark } from "./imageAnnotation";

describe("notedMarks", () => {
  it("drops marks without a note", () => {
    const marks = notedMarks([
      { id: "a", kind: "point", x: 0.1, y: 0.1, note: "  " },
      { id: "b", kind: "point", x: 0.2, y: 0.2, note: "keep" },
    ]);
    expect(marks.map((mark) => mark.id)).toEqual(["b"]);
  });
});

describe("toAnnotationMark", () => {
  it("trims the note and holds positions inside the image", () => {
    expect(
      toAnnotationMark({
        id: "a",
        kind: "arrow",
        x: -0.01,
        y: 0.5,
        toX: 1.02,
        toY: 0.25,
        note: " x ",
      }),
    ).toEqual({ kind: "arrow", note: "x", x: 0, y: 0.5, toX: 1, toY: 0.25 });
  });
});

describe("drawImageMarks", () => {
  /** The radius of the numbered badge drawn for one point mark. */
  const badgeRadius = (width: number, height: number) => {
    const radii: number[] = [];
    const context = new Proxy(
      {},
      {
        get: (_target, key) =>
          key === "arc" ? (_x: number, _y: number, radius: number) => radii.push(radius) : () => {},
        set: () => true,
      },
    ) as CanvasRenderingContext2D;
    drawImageMarks(context, [{ kind: "point", note: "n", x: 0.5, y: 0.5 }], width, height);
    return Math.max(...radii);
  };

  it("sizes badges from the long edge, so tall screenshots read like wide ones", () => {
    expect(badgeRadius(1170, 2532)).toBe(badgeRadius(2532, 1170));
    expect(badgeRadius(1170, 2532)).toBeGreaterThan(badgeRadius(1170, 1170));
  });
});
