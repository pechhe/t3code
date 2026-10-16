import { describe, expect, it } from "@effect/vitest";
import type { ChatAttachment } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as VideoFrames from "../../../videoFrames/VideoFrames.ts";
import { sampleThreadVideoFrames } from "./handlers.ts";

const video: ChatAttachment = {
  type: "file",
  id: "thread-1-00000000-0000-4000-8000-000000000001",
  name: "clip.mp4",
  mimeType: "video/mp4",
  sizeBytes: 1024,
};

const videoFramesLayer = (
  framesForThreadVideo: VideoFrames.VideoFrames["Service"]["framesForThreadVideo"],
) => Layer.mock(VideoFrames.VideoFrames)({ framesForThreadVideo });

const sample = (startMs = 0, endMs = 1000) =>
  sampleThreadVideoFrames([video], { attachmentId: video.id, startMs, endMs });

describe("sampleThreadVideoFrames", () => {
  it.effect("returns frame paths and timestamps for the requested range", () =>
    Effect.gen(function* () {
      const requests: Array<unknown> = [];
      const result = yield* sampleThreadVideoFrames([video], {
        attachmentId: video.id,
        startMs: 1000,
        endMs: 2000,
        maxFrames: 2,
      }).pipe(
        Effect.provide(
          videoFramesLayer((input) => {
            requests.push({ range: input.range, maxFrames: input.maxFrames });
            return Effect.succeed({
              videoName: video.name,
              frames: [1000, 2000].map((timestampMs) => ({
                videoAttachmentId: video.id,
                videoName: video.name,
                timestampMs,
                path: `/frames/${timestampMs}.jpg`,
                mimeType: "image/jpeg" as const,
                sizeBytes: 10,
              })),
            });
          }),
        ),
      );
      expect(requests).toEqual([{ range: { startMs: 1000, endMs: 2000 }, maxFrames: 2 }]);
      expect(result).toEqual({
        videoName: "clip.mp4",
        frames: [
          { timestampMs: 1000, path: "/frames/1000.jpg" },
          { timestampMs: 2000, path: "/frames/2000.jpg" },
        ],
      });
    }),
  );

  it.effect("maps each service failure to an actionable tool error", () =>
    Effect.gen(function* () {
      const failWith = (error: Parameters<typeof Effect.fail>[0]) =>
        sample().pipe(
          Effect.flip,
          Effect.provide(videoFramesLayer(() => Effect.fail(error as never))),
        );
      const outside = yield* failWith(
        new VideoFrames.VideoAttachmentNotInThread({ attachmentId: video.id }),
      );
      expect(outside).toMatchObject({ code: "invalid_request" });
      expect(outside.message).toContain("not in your thread");
      const pastEnd = yield* failWith(
        new VideoFrames.VideoRangeInvalid({ attachmentId: video.id, durationMs: 11_040 }),
      );
      expect(pastEnd).toMatchObject({ code: "invalid_request" });
      expect(pastEnd.message).toContain("past the end of the video (11040 ms long)");
      const missing = yield* failWith(new VideoFrames.FfmpegUnavailable({}));
      expect(missing.message).toContain("ffmpeg is not installed");
    }),
  );
});
