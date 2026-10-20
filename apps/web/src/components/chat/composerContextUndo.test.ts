import type { PreviewAnnotationPayload } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import type { ComposerFileAttachment, ComposerImageAttachment } from "../../composerDraftStore";
import {
  buildMessageContext,
  fileContextReference,
  imageAnnotationContextReference,
  previewAnnotationContextId,
} from "../../lib/composerContextRecords";
import {
  reconcileAttachmentContextReferences,
  type RetainedAttachmentContextPayloads,
} from "./composerContextUndo";

const binary = new File(["binary"], "context.png", { type: "image/png" });
const image = {
  type: "image",
  id: "annotation-1",
  name: "annotation.png",
  mimeType: "image/png",
  sizeBytes: binary.size,
  previewUrl: "blob:annotation",
  file: binary,
} satisfies ComposerImageAttachment;
const annotation = {
  id: "annotation-1",
  pageUrl: "https://example.com",
  pageTitle: "Example",
  comment: "Fix this",
  elements: [],
  regions: [],
  strokes: [],
  styleChanges: [],
  screenshot: {
    dataUrl: "data:image/png;base64,YmluYXJ5",
    width: 1,
    height: 1,
    cropRect: { x: 0, y: 0, width: 1, height: 1 },
  },
  createdAt: "2026-01-01T00:00:00.000Z",
} satisfies PreviewAnnotationPayload;

function retention(): RetainedAttachmentContextPayloads {
  return { files: new Map(), previewAnnotations: new Map(), imageAnnotations: new Map() };
}

describe("reconcileAttachmentContextReferences", () => {
  it("restores an annotation and its screenshot attachment after undo", () => {
    const retained = retention();
    const removed = reconcileAttachmentContextReferences({
      referencedContextIds: new Set(),
      files: [],
      images: [image],
      previewAnnotations: [annotation],
      retained,
    });
    expect(removed.annotationIdsToRemove).toEqual(["annotation-1"]);

    const restored = reconcileAttachmentContextReferences({
      referencedContextIds: new Set([previewAnnotationContextId(annotation.id)]),
      files: [],
      images: [],
      previewAnnotations: [],
      retained,
    });
    expect(restored.annotationsToRestore).toEqual([{ annotation, image }]);
    expect(restored.annotationsToRestore[0]?.annotation.screenshot?.dataUrl).toBe(
      "data:image/png;base64,YmluYXJ5",
    );
    expect(restored.annotationsToRestore[0]?.image?.file).toBe(binary);
    expect(
      buildMessageContext({
        terminalContexts: [],
        reviewComments: [],
        previewAnnotations: restored.annotationsToRestore.map((entry) => entry.annotation),
        attachments: [
          {
            attachment: restored.annotationsToRestore[0]!.image!,
            attachmentId: "uploaded-screenshot",
          },
        ],
      })?.records,
    ).toEqual([
      expect.objectContaining({
        kind: "preview-annotation",
        screenshotContextId: "image_annotation-1",
      }),
      expect.objectContaining({
        kind: "image",
        contextId: "image_annotation-1",
        attachmentId: "uploaded-screenshot",
      }),
    ]);
  });

  it("takes an image's notes off with their chip and puts them back on undo", () => {
    const original = new File(["clean"], "shot.png", { type: "image/png" });
    const marked = new File(["marked"], "shot.png", { type: "image/png" });
    const marks = [{ kind: "point", note: "this", x: 0.5, y: 0.5 }] as const;
    const annotated = {
      ...image,
      id: "shot",
      name: "shot.png",
      file: marked,
      annotation: { marks, original },
    } satisfies ComposerImageAttachment;
    const contextId = imageAnnotationContextReference(annotated).contextId;
    const retained = retention();

    const kept = reconcileAttachmentContextReferences({
      referencedContextIds: new Set([contextId]),
      files: [],
      images: [annotated],
      previewAnnotations: [],
      retained,
    });
    expect(kept.imageAnnotationsToRemove).toEqual([]);

    const removed = reconcileAttachmentContextReferences({
      referencedContextIds: new Set(),
      files: [],
      images: [annotated],
      previewAnnotations: [],
      retained,
    });
    expect(removed.imageAnnotationsToRemove).toEqual([
      { imageId: "shot", file: marked, annotation: { marks, original } },
    ]);

    // After removal the image is its unmarked original; undo brings the chip back.
    const { annotation: _annotation, ...unmarked } = annotated;
    const restored = reconcileAttachmentContextReferences({
      referencedContextIds: new Set([contextId]),
      files: [],
      images: [{ ...unmarked, file: original }],
      previewAnnotations: [],
      retained,
    });
    expect(restored.imageAnnotationsToRestore).toEqual([
      { imageId: "shot", file: marked, annotation: { marks, original } },
    ]);
  });
});
