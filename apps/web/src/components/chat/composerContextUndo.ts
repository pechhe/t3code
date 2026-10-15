import type { PreviewAnnotationPayload } from "@t3tools/contracts";

import type {
  ComposerFileAttachment,
  ComposerImageAnnotation,
  ComposerImageAttachment,
} from "../../composerDraftStore";
import {
  fileContextReference,
  imageAnnotationContextReference,
  previewAnnotationContextId,
} from "../../lib/composerContextRecords";

interface RetainedPreviewAnnotation {
  annotation: PreviewAnnotationPayload;
  image: ComposerImageAttachment | undefined;
}

/** An image's notes with the marked file they were drawn into, kept so undo can put both back. */
export interface RetainedImageAnnotation {
  imageId: string;
  file: File;
  annotation: ComposerImageAnnotation;
}

export interface RetainedAttachmentContextPayloads {
  files: Map<string, ComposerFileAttachment>;
  previewAnnotations: Map<string, RetainedPreviewAnnotation>;
  imageAnnotations: Map<string, RetainedImageAnnotation>;
}

export function reconcileAttachmentContextReferences(input: {
  referencedContextIds: ReadonlySet<string>;
  files: ReadonlyArray<ComposerFileAttachment>;
  images: ReadonlyArray<ComposerImageAttachment>;
  previewAnnotations: ReadonlyArray<PreviewAnnotationPayload>;
  retained: RetainedAttachmentContextPayloads;
}): {
  filesToRemove: string[];
  filesToRestore: ComposerFileAttachment[];
  annotationIdsToRemove: string[];
  annotationsToRestore: RetainedPreviewAnnotation[];
  /** Images whose notes chip left the text; they go back to their unmarked original. */
  imageAnnotationsToRemove: RetainedImageAnnotation[];
  imageAnnotationsToRestore: RetainedImageAnnotation[];
} {
  const liveFileContextIds = new Set<string>(
    input.files.map((file) => fileContextReference(file).contextId),
  );
  const filesToRemove: string[] = [];
  for (const file of input.files) {
    const contextId = fileContextReference(file).contextId;
    if (input.referencedContextIds.has(contextId)) continue;
    input.retained.files.set(contextId, file);
    filesToRemove.push(file.id);
  }
  const filesToRestore = [...input.referencedContextIds].flatMap((contextId) => {
    if (liveFileContextIds.has(contextId)) return [];
    const file = input.retained.files.get(contextId);
    return file ? [file] : [];
  });

  const imagesById = new Map(input.images.map((image) => [image.id, image]));
  const liveAnnotationContextIds = new Set<string>(
    input.previewAnnotations.map((annotation) => previewAnnotationContextId(annotation.id)),
  );
  const annotationIdsToRemove: string[] = [];
  for (const annotation of input.previewAnnotations) {
    const contextId = previewAnnotationContextId(annotation.id);
    if (input.referencedContextIds.has(contextId)) continue;
    input.retained.previewAnnotations.set(contextId, {
      annotation,
      image: imagesById.get(annotation.id),
    });
    annotationIdsToRemove.push(annotation.id);
  }
  const annotationsToRestore = [...input.referencedContextIds].flatMap((contextId) => {
    if (liveAnnotationContextIds.has(contextId)) return [];
    const retained = input.retained.previewAnnotations.get(contextId);
    return retained ? [retained] : [];
  });

  const imageAnnotationsToRemove: RetainedImageAnnotation[] = [];
  for (const image of input.images) {
    if (!image.annotation) continue;
    const contextId = imageAnnotationContextReference(image).contextId;
    if (input.referencedContextIds.has(contextId)) continue;
    const retained = { imageId: image.id, file: image.file, annotation: image.annotation };
    input.retained.imageAnnotations.set(contextId, retained);
    imageAnnotationsToRemove.push(retained);
  }
  // Only an image still in the draft and still unmarked takes its notes back.
  const imageAnnotationsToRestore = input.images.flatMap((image) => {
    if (image.annotation) return [];
    const contextId = imageAnnotationContextReference(image).contextId;
    if (!input.referencedContextIds.has(contextId)) return [];
    const retained = input.retained.imageAnnotations.get(contextId);
    return retained ? [retained] : [];
  });

  return {
    filesToRemove,
    filesToRestore,
    annotationIdsToRemove,
    annotationsToRestore,
    imageAnnotationsToRemove,
    imageAnnotationsToRestore,
  };
}
