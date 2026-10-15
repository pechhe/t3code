import { describe, expect, it } from "vite-plus/test";

import { notedMarks, toAnnotationMark } from "./imageAnnotation";

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
