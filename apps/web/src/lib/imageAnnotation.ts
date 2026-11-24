/**
 * Screenshot annotation for composer images. The model receives one image with
 * marks drawn on it and an `image-annotation` context record with the user's notes
 * and positions as fractions (0–1) of the image width and height.
 */

import { fitImageAttachmentSize } from "@t3tools/client-runtime/image-attachment-size";
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

export interface ComputedImageMarkBadge {
  readonly x: number;
  readonly y: number;
  readonly radius: number;
  readonly stroke: number;
  readonly halo: number;
}

function pointRadius(badgeRadius: number): number {
  return Math.max(7, Math.round(badgeRadius * 0.6));
}

export function computeImageMarkBadges(
  marks: ReadonlyArray<ImageAnnotationMark | ImageMark>,
  width: number,
  height: number,
): ComputedImageMarkBadge[] {
  const longEdge = Math.max(width, height);
  const shortEdge = Math.min(width, height);
  const radius = Math.max(
    10,
    Math.min(Math.round(longEdge * 0.013), Math.round(shortEdge * 0.055)),
  );
  const stroke = Math.max(2.5, Math.round(radius * 0.22));
  const halo = Math.max(1.5, stroke * 0.6);
  const inset = radius + 2;
  const minX = Math.min(inset, width / 2);
  const minY = Math.min(inset, height / 2);
  const clampX = (x: number) => clamp(x, minX, width - minX);
  const clampY = (y: number) => clamp(y, minY, height - minY);
  const badges = marks.map((mark) => {
    const x = mark.x * width;
    const y = mark.y * height;
    let badgeX: number;
    let badgeY: number;
    switch (mark.kind) {
      case "box": {
        const gap = radius + stroke + halo + 2;
        badgeX = x + radius;
        badgeY = y - gap - radius < 0 ? y + mark.height * height + gap : y - gap;
        break;
      }
      case "arrow": {
        const angle = Math.atan2(mark.toY * height - y, mark.toX * width - x);
        badgeX = x - Math.cos(angle) * (radius + 6);
        badgeY = y - Math.sin(angle) * (radius + 6);
        break;
      }
      case "point": {
        const offset = (pointRadius(radius) + radius + stroke + halo) * Math.SQRT1_2;
        badgeX = x + (x + offset > width - minX ? -offset : offset);
        badgeY = y + (y - offset < minY ? offset : -offset);
        break;
      }
    }
    return { x: clampX(badgeX), y: clampY(badgeY), radius, stroke, halo };
  });

  const separation = radius * 2.25;
  for (let pass = 0; pass < 6; pass += 1) {
    let moved = false;
    for (const [index, a] of badges.entries()) {
      for (let other = index + 1; other < badges.length; other += 1) {
        const b = badges[other]!;
        const dx = b.x - a.x;
        const dy = b.y - a.y;
        const distance = Math.hypot(dx, dy);
        if (distance >= separation) continue;
        const angle = distance > 0 ? Math.atan2(dy, dx) : width >= height ? 0 : Math.PI / 2;
        const ux = Math.cos(angle);
        const uy = Math.sin(angle);
        const gap = separation - distance;
        const oldX = a.x;
        const oldY = a.y;
        const oldBX = b.x;
        const oldBY = b.y;
        a.x = clampX(oldX - (ux * gap) / 2);
        a.y = clampY(oldY - (uy * gap) / 2);
        // Give the other badge any movement that the edge blocked.
        const remainder = gap - (oldX - a.x) * ux - (oldY - a.y) * uy;
        b.x = clampX(oldBX + ux * remainder);
        b.y = clampY(oldBY + uy * remainder);
        const shortfall = Math.max(
          0,
          gap - (oldX - a.x + b.x - oldBX) * ux - (oldY - a.y + b.y - oldBY) * uy,
        );
        a.x = clampX(a.x - ux * shortfall);
        a.y = clampY(a.y - uy * shortfall);
        moved ||= a.x !== oldX || a.y !== oldY || b.x !== oldBX || b.y !== oldBY;
      }
    }
    if (!moved) break;
  }
  return badges;
}

export function drawImageMarks(
  context: CanvasRenderingContext2D,
  marks: ReadonlyArray<ImageAnnotationMark>,
  width: number,
  height: number,
): void {
  const badges = computeImageMarkBadges(marks, width, height);
  marks.forEach((mark, index) => {
    const { radius, stroke, halo } = badges[index]!;
    const x = mark.x * width;
    const y = mark.y * height;
    if (mark.kind === "box") {
      const boxWidth = mark.width * width;
      const boxHeight = mark.height * height;
      // No fill, and the strokes sit outside the edge, so the boxed pixels stay untouched.
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
      return;
    }
    if (mark.kind === "arrow") {
      const toX = mark.toX * width;
      const toY = mark.toY * height;
      const angle = Math.atan2(toY - y, toX - x);
      const head = radius * 1.25;
      context.lineCap = "round";
      context.lineWidth = stroke + halo;
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
      return;
    }
    // A hollow ring, so the pixel being pointed at stays visible in its middle.
    const ring = pointRadius(radius);
    context.lineWidth = stroke + halo;
    context.strokeStyle = "rgba(255,255,255,0.92)";
    context.beginPath();
    context.arc(x, y, ring, 0, Math.PI * 2);
    context.stroke();
    context.lineWidth = stroke;
    context.strokeStyle = ANNOTATION_MARK_COLOR;
    context.beginPath();
    context.arc(x, y, ring, 0, Math.PI * 2);
    context.stroke();
  });
  if (marks.length > 1) {
    badges.forEach(({ x, y, radius }, index) =>
      drawBadge(context, x, y, radius, String(index + 1)),
    );
  }
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

async function flattenAnnotatedImage(
  source: File,
  marks: ReadonlyArray<ImageAnnotationMark>,
): Promise<{ file: File; size: ImageAnnotationSize }> {
  const canvas = document.createElement("canvas");
  const bitmap = typeof createImageBitmap === "function" ? await createImageBitmap(source) : null;
  let size: ImageAnnotationSize;
  try {
    const image = bitmap ?? (await loadImage(source));
    const naturalSize =
      "naturalWidth" in image
        ? { width: image.naturalWidth, height: image.naturalHeight }
        : { width: image.width, height: image.height };
    size = fitImageAttachmentSize(naturalSize) ?? naturalSize;
    canvas.width = size.width;
    canvas.height = size.height;
    const context = canvas.getContext("2d");
    if (!context) throw new Error("Canvas is unavailable.");
    context.imageSmoothingQuality = "high";
    context.drawImage(image, 0, 0, size.width, size.height);
    drawImageMarks(context, marks, size.width, size.height);
  } finally {
    bitmap?.close();
  }
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/png"));
  if (!blob) throw new Error("The annotated image could not be encoded.");
  const baseName = (source.name || "image").replace(/\.[^.]+$/, "");
  return { file: new File([blob], `${baseName}-annotated.png`, { type: "image/png" }), size };
}

/**
 * The marked copy of `original` that is uploaded and sent, within the provider image limit,
 * with its pixel size after any downscaling: the size the agent's positions refer to.
 */
export async function markedImageFile(
  original: File,
  marks: ReadonlyArray<ImageAnnotationMark>,
): Promise<{ file: File; size: ImageAnnotationSize }> {
  const marked = await flattenAnnotatedImage(original, marks);
  if (marked.file.size <= PROVIDER_SEND_TURN_MAX_IMAGE_BYTES) return marked;
  const prepared = await prepareImageForAttachment(marked.file, PROVIDER_SEND_TURN_MAX_IMAGE_BYTES);
  if (!prepared.ok) throw new Error(prepared.reason);
  return { file: prepared.file, size: prepared.imageSize ?? marked.size };
}
