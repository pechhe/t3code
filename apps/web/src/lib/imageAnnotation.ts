/**
 * Screenshot annotation for composer images. The model receives one image with numbered
 * marks drawn on it, and a brief in the prompt that pairs each number with the user's note
 * and its position as fractions (0–1) of the image width and height.
 */

export type ImageMark =
  | { readonly id: string; readonly kind: "point"; x: number; y: number; note: string }
  | {
      readonly id: string;
      readonly kind: "box";
      x: number;
      y: number;
      width: number;
      height: number;
      note: string;
    }
  | {
      readonly id: string;
      readonly kind: "arrow";
      x: number;
      y: number;
      toX: number;
      toY: number;
      note: string;
    };

export const ANNOTATION_MARK_COLOR = "#14ce4c";

const BRIEF_INTRO =
  "annotations. The numbered marks drawn on this image are mine, not part of the UI; positions are fractions of the image width and height.";

function fixed(value: number): string {
  return value.toFixed(3);
}

function markPosition(mark: ImageMark): string {
  switch (mark.kind) {
    case "point":
      return `point x=${fixed(mark.x)} y=${fixed(mark.y)}`;
    case "box":
      return `box x=${fixed(mark.x)} y=${fixed(mark.y)} w=${fixed(mark.width)} h=${fixed(mark.height)}`;
    case "arrow":
      return `arrow from x=${fixed(mark.x)} y=${fixed(mark.y)} to x=${fixed(mark.toX)} y=${fixed(mark.toY)}`;
  }
}

/** Marks a user left without a note are dropped rather than sent as bare numbers. */
export function notedMarks(marks: ReadonlyArray<ImageMark>): ImageMark[] {
  return marks.filter((mark) => mark.note.trim().length > 0);
}

/**
 * The prompt text that explains one annotated image. `imageReference` is the inline chip
 * that names the image, so the brief stays tied to it when other images are attached.
 */
export function buildAnnotationBrief(
  imageReference: string,
  marks: ReadonlyArray<ImageMark>,
): string | null {
  if (marks.length === 0) return null;
  const lines = marks.map(
    (mark, index) => `${String(index + 1)}. ${mark.note.trim()} [${markPosition(mark)}]`,
  );
  return [`${imageReference} ${BRIEF_INTRO}`, ...lines].join("\n");
}

/** Replaces the previous brief for an image in place, or appends it on its own paragraph. */
export function replaceAnnotationBrief(
  prompt: string,
  previous: string | null,
  next: string | null,
): string {
  if (previous && prompt.includes(previous)) {
    const replaced = prompt.replace(previous, next ?? "");
    return next ? replaced : replaced.replace(/\n{3,}/g, "\n\n").trim();
  }
  if (!next) return prompt;
  const trimmed = prompt.trimEnd();
  return trimmed.length > 0 ? `${trimmed}\n\n${next}` : next;
}

function drawBadge(
  context: CanvasRenderingContext2D,
  x: number,
  y: number,
  radius: number,
  label: string,
): void {
  context.beginPath();
  context.arc(x, y, radius, 0, Math.PI * 2);
  context.fillStyle = ANNOTATION_MARK_COLOR;
  context.fill();
  context.lineWidth = Math.max(1.5, radius * 0.14);
  context.strokeStyle = "rgba(255,255,255,0.92)";
  context.stroke();
  context.fillStyle = "#fff";
  context.font = `700 ${String(Math.round(radius * 1.15))}px system-ui, sans-serif`;
  context.textAlign = "center";
  context.textBaseline = "middle";
  context.fillText(label, x, y + radius * 0.05);
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/** Draws the marks at the image's natural size; mark sizes scale with the image width. */
export function drawImageMarks(
  context: CanvasRenderingContext2D,
  marks: ReadonlyArray<ImageMark>,
  width: number,
  height: number,
): void {
  const badge = Math.max(14, Math.round(width * 0.013));
  const stroke = Math.max(3, Math.round(badge * 0.22));
  const placeBadge = (x: number, y: number, label: string) =>
    drawBadge(
      context,
      clamp(x, badge, width - badge),
      clamp(y, badge, height - badge),
      badge,
      label,
    );

  marks.forEach((mark, index) => {
    const label = String(index + 1);
    const x = mark.x * width;
    const y = mark.y * height;
    if (mark.kind === "box") {
      const boxWidth = mark.width * width;
      const boxHeight = mark.height * height;
      context.fillStyle = "rgba(20,206,76,0.10)";
      context.fillRect(x, y, boxWidth, boxHeight);
      context.lineWidth = stroke + Math.max(2, stroke * 0.6);
      context.strokeStyle = "rgba(255,255,255,0.9)";
      context.strokeRect(x, y, boxWidth, boxHeight);
      context.lineWidth = stroke;
      context.strokeStyle = ANNOTATION_MARK_COLOR;
      context.strokeRect(x, y, boxWidth, boxHeight);
      placeBadge(x, y, label);
      return;
    }
    if (mark.kind === "arrow") {
      const toX = mark.toX * width;
      const toY = mark.toY * height;
      const angle = Math.atan2(toY - y, toX - x);
      const head = badge * 1.25;
      context.lineCap = "round";
      context.lineWidth = stroke + Math.max(2, stroke * 0.6);
      context.strokeStyle = "rgba(255,255,255,0.9)";
      context.beginPath();
      context.moveTo(x, y);
      context.lineTo(toX, toY);
      context.stroke();
      context.lineWidth = stroke;
      context.strokeStyle = ANNOTATION_MARK_COLOR;
      context.beginPath();
      context.moveTo(x, y);
      context.lineTo(toX - Math.cos(angle) * head * 0.6, toY - Math.sin(angle) * head * 0.6);
      context.stroke();
      context.beginPath();
      context.moveTo(toX, toY);
      context.lineTo(
        toX - head * Math.cos(angle - Math.PI / 7),
        toY - head * Math.sin(angle - Math.PI / 7),
      );
      context.lineTo(
        toX - head * Math.cos(angle + Math.PI / 7),
        toY - head * Math.sin(angle + Math.PI / 7),
      );
      context.closePath();
      context.fillStyle = ANNOTATION_MARK_COLOR;
      context.fill();
      placeBadge(x, y, label);
      return;
    }
    const radius = Math.max(6, Math.round(badge * 0.5));
    context.beginPath();
    context.arc(x, y, radius + Math.max(1.5, stroke * 0.35), 0, Math.PI * 2);
    context.fillStyle = "rgba(255,255,255,0.92)";
    context.fill();
    context.beginPath();
    context.arc(x, y, radius, 0, Math.PI * 2);
    context.fillStyle = ANNOTATION_MARK_COLOR;
    context.fill();
    // The badge sits up and to the right of the dot, or flips inward near an edge.
    const offset = (radius + badge + stroke) * Math.SQRT1_2;
    placeBadge(x + (mark.x > 0.9 ? -offset : offset), y + (mark.y < 0.1 ? offset : -offset), label);
  });
}

function loadImage(file: Blob): Promise<HTMLImageElement> {
  const url = URL.createObjectURL(file);
  return new Promise<HTMLImageElement>((resolve, reject) => {
    const image = new Image();
    image.addEventListener("load", () => resolve(image), { once: true });
    image.addEventListener("error", () => reject(new Error("The image could not be decoded.")), {
      once: true,
    });
    image.src = url;
  }).finally(() => URL.revokeObjectURL(url));
}

/** Returns a PNG copy of `source` with the marks drawn on at full resolution. */
export async function flattenAnnotatedImage(
  source: File,
  marks: ReadonlyArray<ImageMark>,
): Promise<File> {
  const image = await loadImage(source);
  const canvas = document.createElement("canvas");
  canvas.width = image.naturalWidth;
  canvas.height = image.naturalHeight;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("Canvas is unavailable.");
  context.drawImage(image, 0, 0);
  drawImageMarks(context, marks, canvas.width, canvas.height);
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/png"));
  if (!blob) throw new Error("The annotated image could not be encoded.");
  const baseName = (source.name || "image").replace(/\.[^.]+$/, "");
  return new File([blob], `${baseName}-annotated.png`, { type: "image/png" });
}
