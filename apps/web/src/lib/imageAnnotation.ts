/**
 * Screenshot annotation for composer images. The model receives one image with numbered
 * marks drawn on it, and an `image-annotation` context record that pairs each number with
 * the user's note and its position as fractions (0–1) of the image width and height.
 */

import {
  type ImageAnnotationMark,
  type ImageAnnotationSize,
  PROVIDER_SEND_TURN_MAX_IMAGE_BYTES,
} from "@t3tools/contracts";

import { prepareImageForAttachment } from "./imageCompression";
import { randomUUID } from "./utils";

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

/** Magenta reads against almost any screenshot, where green vanishes into success states. */
const ANNOTATION_MARK_COLOR = "#f0249b";

/** Marks a user left without a note are dropped rather than sent as bare numbers. */
export function notedMarks(marks: ReadonlyArray<ImageMark>): ImageMark[] {
  return marks.filter((mark) => mark.note.trim().length > 0);
}

function fraction(value: number): number {
  return Math.min(1, Math.max(0, value));
}

/** The wire form of a mark: no editor id, a trimmed note, positions held inside the image. */
export function toAnnotationMark(mark: ImageMark): ImageAnnotationMark {
  const note = mark.note.trim();
  switch (mark.kind) {
    case "point":
      return { kind: "point", note, x: fraction(mark.x), y: fraction(mark.y) };
    case "box":
      return {
        kind: "box",
        note,
        x: fraction(mark.x),
        y: fraction(mark.y),
        width: fraction(mark.width),
        height: fraction(mark.height),
      };
    case "arrow":
      return {
        kind: "arrow",
        note,
        x: fraction(mark.x),
        y: fraction(mark.y),
        toX: fraction(mark.toX),
        toY: fraction(mark.toY),
      };
  }
}

/** Editable marks from stored ones, with fresh editor ids. */
export function fromAnnotationMarks(marks: ReadonlyArray<ImageAnnotationMark>): ImageMark[] {
  return marks.map((mark) => ({ ...mark, id: randomUUID() }));
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

/**
 * Draws the marks at the image's natural size. Mark sizes follow the long edge, so a tall
 * phone screenshot a provider scales down still carries readable numbers.
 */
export function drawImageMarks(
  context: CanvasRenderingContext2D,
  marks: ReadonlyArray<ImageAnnotationMark>,
  width: number,
  height: number,
): void {
  const badge = Math.max(14, Math.round(Math.max(width, height) * 0.013));
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
      // No fill, and the strokes sit outside the edge, so the boxed pixels stay untouched.
      const halo = Math.max(2, stroke * 0.6);
      const ring = stroke / 2;
      context.lineWidth = stroke + halo;
      context.strokeStyle = "rgba(255,255,255,0.9)";
      context.strokeRect(
        x - ring - halo / 2,
        y - ring - halo / 2,
        boxWidth + stroke + halo,
        boxHeight + stroke + halo,
      );
      context.lineWidth = stroke;
      context.strokeStyle = ANNOTATION_MARK_COLOR;
      context.strokeRect(x - ring, y - ring, boxWidth + stroke, boxHeight + stroke);
      // The badge sits just above the top-left corner, or below the box when there is no room,
      // so it never covers what the box points at.
      const gap = badge + stroke + halo;
      placeBadge(x + badge, y - gap - badge >= 0 ? y - gap : y + boxHeight + gap, label);
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
    // A hollow ring, so the pixel being pointed at stays visible in its middle.
    const radius = Math.max(7, Math.round(badge * 0.6));
    context.lineWidth = stroke + Math.max(2, stroke * 0.6);
    context.strokeStyle = "rgba(255,255,255,0.92)";
    context.beginPath();
    context.arc(x, y, radius, 0, Math.PI * 2);
    context.stroke();
    context.lineWidth = stroke;
    context.strokeStyle = ANNOTATION_MARK_COLOR;
    context.beginPath();
    context.arc(x, y, radius, 0, Math.PI * 2);
    context.stroke();
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
async function flattenAnnotatedImage(
  source: File,
  marks: ReadonlyArray<ImageAnnotationMark>,
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

/**
 * The marked copy of `original` that is uploaded and sent, within the provider image limit,
 * with its pixel size after any downscaling: the size the agent's positions refer to.
 */
export async function markedImageFile(
  original: File,
  marks: ReadonlyArray<ImageAnnotationMark>,
): Promise<{ file: File; size: ImageAnnotationSize }> {
  const prepared = await prepareImageForAttachment(
    await flattenAnnotatedImage(original, marks),
    PROVIDER_SEND_TURN_MAX_IMAGE_BYTES,
  );
  if (!prepared.ok) throw new Error(prepared.reason);
  const bitmap = await createImageBitmap(prepared.file);
  const size = { width: bitmap.width, height: bitmap.height };
  bitmap.close();
  return { file: prepared.file, size };
}
