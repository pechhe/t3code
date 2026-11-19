import {
  videoFrameParts,
  videoFramesWithinByteBudget,
} from "@t3tools/provider-core/server/attachmentPrompt";
import type { ProviderAdapterV2VideoFrame } from "@t3tools/provider-core/server/ProviderAdapter";
import type * as EffectAcpSchema from "effect-acp/compat";

/**
 * The labelled frames an image-capable ACP prompt carries, resampled to fit what the prompt's
 * images leave of the runtime's attachment byte limit.
 */
export function acpVideoFrameBlocks(
  frames: ReadonlyArray<{ frame: ProviderAdapterV2VideoFrame; bytes: Uint8Array }>,
  byteLimit: number | undefined,
  blocks: ReadonlyArray<EffectAcpSchema.ContentBlock>,
): Array<EffectAcpSchema.ContentBlock> {
  if (frames.length === 0) return [];
  const imageBytes = blocks.reduce(
    (sum, block) => sum + (block.type === "image" ? Buffer.byteLength(block.data, "base64") : 0),
    0,
  );
  return videoFrameParts<EffectAcpSchema.ContentBlock>(
    byteLimit === undefined ? frames : videoFramesWithinByteBudget(frames, byteLimit - imageBytes),
    (text) => ({ type: "text", text }),
    (data) => ({ type: "image", data, mimeType: "image/jpeg" }),
  );
}
