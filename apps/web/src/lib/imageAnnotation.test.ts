import { describe, expect, it, vi } from "vite-plus/test";

import {
  computeImageMarkBadges,
  drawImageMarks,
  markedImageFile,
  notedMarks,
  toAnnotationMark,
} from "./imageAnnotation";

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
        note: " ",
      }),
    ).toEqual({ kind: "arrow", note: "", x: 0, y: 0.5, toX: 1, toY: 0.25 });
  });
});

const point = { kind: "point", note: "", x: 0.5, y: 0.5 } as const;

describe("computeImageMarkBadges", () => {
  const badgeRadius = (width: number, height: number) =>
    computeImageMarkBadges([point], width, height)[0]!.radius;

  it("scales tall and wide screenshots equally without swamping a thin strip", () => {
    expect(badgeRadius(1170, 2532)).toBe(badgeRadius(2532, 1170));
    expect(badgeRadius(1170, 2532)).toBeGreaterThan(badgeRadius(1170, 1170));
    expect(badgeRadius(2000, 325)).toBe(18);
  });

  it("positions each kind away from its target and flips it at an edge", () => {
    const box = { kind: "box", note: "", x: 0.25, y: 0.25, width: 0.25, height: 0.25 } as const;
    const [above] = computeImageMarkBadges([box], 1000, 1000);
    const [below] = computeImageMarkBadges([{ ...box, y: 0 }], 1000, 1000);
    const [arrow] = computeImageMarkBadges(
      [{ kind: "arrow", note: "", x: 0.5, y: 0.5, toX: 0.75, toY: 0.75 }],
      1000,
      1000,
    );
    const [upRight] = computeImageMarkBadges([point], 1000, 1000);
    const [inward] = computeImageMarkBadges([{ ...point, x: 1, y: 0 }], 1000, 1000);
    expect(above!.y + above!.radius).toBeLessThan(250);
    expect(below!.y - below!.radius).toBeGreaterThan(250);
    expect(arrow!.x).toBeLessThan(500);
    expect(arrow!.y).toBeLessThan(500);
    expect(upRight!.x).toBeGreaterThan(500);
    expect(upRight!.y).toBeLessThan(500);
    expect(inward!.x + inward!.radius).toBeLessThan(1000);
    expect(inward!.y - inward!.radius).toBeGreaterThan(0);
  });

  it("separates coincident badges while staying inside the canvas", () => {
    const arrow = { kind: "arrow", note: "", x: 0, y: 0, toX: 1, toY: 0 } as const;
    const [first, second] = computeImageMarkBadges([arrow, arrow], 2000, 325);
    for (const badge of [first!, second!]) {
      expect(badge.x).toBeGreaterThanOrEqual(badge.radius + 2);
      expect(badge.y).toBeGreaterThanOrEqual(badge.radius + 2);
    }
    expect(Math.hypot(first!.x - second!.x, first!.y - second!.y)).toBeGreaterThanOrEqual(
      first!.radius * 2.25,
    );
    expect(computeImageMarkBadges([arrow], 8, 12)[0]).toMatchObject({ x: 4, y: 6 });
  });
});

describe("drawImageMarks", () => {
  it("draws a bare ring for a single mark and numbered badges for multiple marks", () => {
    const labels: string[] = [];
    const radii: number[] = [];
    const context = new Proxy(
      {},
      {
        get: (_target, key) => {
          if (key === "arc") return (_x: number, _y: number, radius: number) => radii.push(radius);
          if (key === "fillText") return (label: string) => labels.push(label);
          return () => {};
        },
        set: () => true,
      },
    ) as CanvasRenderingContext2D;
    drawImageMarks(context, [point], 1000, 1000);
    expect(labels).toEqual([]);
    expect(Math.max(...radii)).toBeLessThan(computeImageMarkBadges([point], 1000, 1000)[0]!.radius);
    drawImageMarks(context, [point, { ...point, x: 0.75 }], 1000, 1000);
    expect(labels).toEqual(["1", "2"]);
  });
});

describe("markedImageFile", () => {
  it("draws sharp marks at the fitted size without decoding the encoded PNG", async () => {
    const rasterSteps: unknown[] = [];
    const bitmap = { width: 4000, height: 3000, close: () => rasterSteps.push("close") };
    const canvas = {
      width: 0,
      height: 0,
      getContext: () => ({
        drawImage: (_image: ImageBitmap, _x: number, _y: number, width: number, height: number) =>
          rasterSteps.push(["image", width, height]),
        beginPath: () => {},
        arc: (x: number, y: number) => rasterSteps.push(["ring", x, y]),
        stroke: () => {},
      }),
      toBlob: (resolve: (blob: Blob) => void, type: string) => {
        rasterSteps.push([type, canvas.width, canvas.height]);
        resolve(new Blob(["encoded"], { type }));
      },
    };
    vi.stubGlobal("createImageBitmap", () => {
      rasterSteps.push("decode");
      return Promise.resolve(bitmap);
    });
    vi.stubGlobal("document", { createElement: () => canvas });
    try {
      const source = new File(["source"], "shot.png", { type: "image/png" });
      const marked = await markedImageFile(source, [point]);
      expect(marked.size).toEqual({ width: 2000, height: 1500 });
      expect(marked.file.name).toBe("shot-annotated.png");
      expect(rasterSteps).toEqual([
        "decode",
        ["image", 2000, 1500],
        ["ring", 1000, 750],
        ["ring", 1000, 750],
        "close",
        ["image/png", 2000, 1500],
      ]);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
