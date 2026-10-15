import { describe, expect, it } from "vite-plus/test";

import { buildAnnotationBrief, notedMarks, replaceAnnotationBrief } from "./imageAnnotation";

describe("buildAnnotationBrief", () => {
  it("numbers each mark with its note and normalized position", () => {
    const brief = buildAnnotationBrief("[@shot.png](image_1)", [
      { id: "a", kind: "point", x: 0.62, y: 0.31, note: " button is misaligned " },
      { id: "b", kind: "box", x: 0.1, y: 0.55, width: 0.3, height: 0.15, note: "text clipped" },
      { id: "c", kind: "arrow", x: 0.1, y: 0.2, toX: 0.4, toY: 0.5, note: "move it here" },
    ]);
    expect(brief?.split("\n")).toEqual([
      expect.stringMatching(/^\[@shot\.png\]\(image_1\) annotations\. The numbered marks/),
      "1. button is misaligned [point x=0.620 y=0.310]",
      "2. text clipped [box x=0.100 y=0.550 w=0.300 h=0.150]",
      "3. move it here [arrow from x=0.100 y=0.200 to x=0.400 y=0.500]",
    ]);
  });

  it("has nothing to say without marks", () => {
    expect(buildAnnotationBrief("chip", [])).toBeNull();
  });
});

describe("notedMarks", () => {
  it("drops marks the user left without a note", () => {
    const marks = notedMarks([
      { id: "a", kind: "point", x: 0, y: 0, note: "  " },
      { id: "b", kind: "point", x: 0, y: 0, note: "keep" },
    ]);
    expect(marks.map((mark) => mark.id)).toEqual(["b"]);
  });
});

describe("replaceAnnotationBrief", () => {
  it("appends the first brief as its own paragraph", () => {
    expect(replaceAnnotationBrief("Fix these ", null, "brief")).toBe("Fix these\n\nbrief");
    expect(replaceAnnotationBrief("", null, "brief")).toBe("brief");
  });

  it("rewrites an earlier brief where it sits", () => {
    expect(replaceAnnotationBrief("a\n\nold\n\nb", "old", "new")).toBe("a\n\nnew\n\nb");
  });

  it("removes the brief when every mark is cleared", () => {
    expect(replaceAnnotationBrief("a\n\nold\n\nb", "old", null)).toBe("a\n\nb");
  });

  it("appends again when the user deleted the earlier brief", () => {
    expect(replaceAnnotationBrief("a", "old", "new")).toBe("a\n\nnew");
  });
});
