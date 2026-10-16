import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import { type ChatAttachment, PROVIDER_SEND_TURN_MAX_TOTAL_IMAGE_BYTES } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import { readImageDimensions } from "@t3tools/shared/imageDimensions";

import * as ServerConfig from "../config.ts";
import * as ProcessRunner from "../processRunner.ts";
import * as VideoFrames from "./VideoFrames.ts";
import * as ResourceCleanup from "../orchestration-v2/ResourceCleanupService.ts";
import * as TerminalManager from "../terminal/Manager.ts";
import * as PreviewManager from "../preview/Manager.ts";

const video = (i = 0): ChatAttachment => ({
  type: "file",
  id: `thread-00000000-0000-4000-8000-${String(i).padStart(12, "0")}-mp4`,
  name: "clip.mp4",
  mimeType: "video/mp4",
  sizeBytes: 10,
});
const output = (stdout = "", code = 0): ProcessRunner.ProcessRunOutput => ({
  stdout,
  stderr: "",
  code: ChildProcessSpawner.ExitCode(code),
  timedOut: false,
  stdoutTruncated: false,
  stderrTruncated: false,
  stdoutInvalidUtf8: false,
  stderrInvalidUtf8: false,
});

function harness(
  options: {
    missing?: boolean;
    missingProbe?: boolean;
    bytes?: number;
    failVideo?: boolean;
    failDetect?: boolean;
    changesMs?: number[];
  } = {},
) {
  const calls: ProcessRunner.ProcessRunInput[] = [];
  const runner = Layer.effect(
    ProcessRunner.ProcessRunner,
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      return ProcessRunner.ProcessRunner.of({
        run: (input) =>
          Effect.gen(function* () {
            calls.push(input);
            if (input.args[0] === "-version")
              return output(
                "",
                options.missing || (options.missingProbe && input.command === "ffprobe") ? 1 : 0,
              );
            if (input.command === "ffprobe")
              return output(
                '{"streams":[{"duration":"11.04","avg_frame_rate":"25/1"}],"format":{}}',
              );
            if (options.failVideo) return output("", 1);
            if (input.args.includes("-hide_banner") && options.failDetect) return output("", 1);
            if (input.args.includes("-hide_banner"))
              return {
                ...output(),
                stderr: (options.changesMs ?? [0])
                  .map((ms) => `[Parsed_showinfo_2 @ 0x1] n:   0 pts: 0 pts_time:${ms / 1000}`)
                  .join("\n"),
              };
            yield* fs
              .writeFile(input.args.at(-1)!, new Uint8Array(options.bytes ?? 8))
              .pipe(Effect.orDie);
            return output();
          }),
      });
    }),
  );
  const layer = VideoFrames.layer.pipe(
    Layer.provide(runner),
    Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "video-frames-test-" })),
    Layer.provideMerge(NodeServices.layer),
  );
  return { calls, layer };
}

it.effect(
  "samples first, last and evenly spaced frames, and reuses a complete cache without spawning",
  () => {
    const h = harness();
    return Effect.gen(function* () {
      const service = yield* VideoFrames.VideoFrames;
      const frames = yield* service.framesForVideo({ attachment: video(), maxFrames: 99 });
      expect(frames.map((f) => f.timestampMs)).toEqual(
        Array.from({ length: 12 }, (_, i) => i * 1000),
      );
      const calls = h.calls.length;
      expect(yield* service.framesForVideo({ attachment: video(), maxFrames: 12 })).toEqual(frames);
      expect(h.calls).toHaveLength(calls);
      const range = yield* service.framesForVideo({
        attachment: video(),
        range: { startMs: 2000, endMs: 6000 },
        maxFrames: 3,
      });
      expect(range.map((f) => f.timestampMs)).toEqual([2000, 4000, 6000]);
    }).pipe(Effect.provide(h.layer));
  },
);

it.effect("rejects a range that starts past the end of the video without extracting", () => {
  const h = harness();
  return Effect.gen(function* () {
    const service = yield* VideoFrames.VideoFrames;
    const error = yield* service
      .framesForVideo({
        attachment: video(),
        range: { startMs: 999_999, endMs: 999_999 },
        maxFrames: 3,
      })
      .pipe(Effect.flip);
    expect(error).toMatchObject({ _tag: "VideoRangeInvalid", durationMs: 11040 });
    expect(h.calls.some((call) => call.command === "ffmpeg" && call.args[0] !== "-version")).toBe(
      false,
    );
  }).pipe(Effect.provide(h.layer));
});

it.effect("finds a thread's video and refuses one from elsewhere", () => {
  const h = harness();
  return Effect.gen(function* () {
    const service = yield* VideoFrames.VideoFrames;
    const range = { startMs: 0, endMs: 2000 };
    const found = yield* service.framesForThreadVideo({
      threadAttachments: [video(1), video()],
      attachmentId: video().id,
      range,
      maxFrames: 2,
    });
    expect(found.videoName).toBe("clip.mp4");
    expect(found.frames.map((f) => f.timestampMs)).toEqual([0, 2000]);
    const elsewhere = yield* service
      .framesForThreadVideo({
        threadAttachments: [video(1)],
        attachmentId: video().id,
        range,
        maxFrames: 2,
      })
      .pipe(Effect.flip);
    expect(elsewhere._tag).toBe("VideoAttachmentNotInThread");
    const backwards = yield* service
      .framesForVideo({ attachment: video(), range: { startMs: 2000, endMs: 1000 }, maxFrames: 2 })
      .pipe(Effect.flip);
    expect(backwards._tag).toBe("VideoRangeInvalid");
  }).pipe(Effect.provide(h.layer));
});

it.effect("keeps only the most recent ranged caches per video, and always the full set", () => {
  const h = harness();
  return Effect.gen(function* () {
    const service = yield* VideoFrames.VideoFrames;
    const config = yield* ServerConfig.ServerConfig;
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    yield* service.framesForVideo({ attachment: video(), maxFrames: 2 });
    for (let i = 0; i < 10; i++) {
      yield* service.framesForVideo({
        attachment: video(),
        range: { startMs: i * 100, endMs: i * 100 + 50 },
        maxFrames: 2,
      });
    }
    const names = yield* fs.readDirectory(
      path.join(config.attachmentsDir, "video-frames", video().id),
    );
    expect(names.filter((name) => name.startsWith("full-"))).toHaveLength(1);
    expect(names.filter((name) => !name.startsWith("full-") && !name.startsWith("."))).toHaveLength(
      8,
    );
    expect(names).toContain("900-950-2");
  }).pipe(Effect.provide(h.layer));
});

it.effect("shares 36 frames evenly among videos and retains endpoints", () => {
  const h = harness();
  return Effect.gen(function* () {
    const service = yield* VideoFrames.VideoFrames;
    const frames = yield* service.framesForMessage(Array.from({ length: 5 }, (_, i) => video(i)));
    expect(frames).toHaveLength(36);
    for (let i = 0; i < 5; i++) {
      const group = frames.filter((f) => f.videoAttachmentId === video(i).id);
      expect(group).toHaveLength(i === 0 ? 8 : 7);
      expect(group[0]?.timestampMs).toBe(0);
      expect(group.at(-1)?.timestampMs).toBe(11000);
    }
  }).pipe(Effect.provide(h.layer));
});

it.effect("regenerates an incomplete cache and removes it through attachment cleanup", () => {
  const h = harness();
  return Effect.gen(function* () {
    const service = yield* VideoFrames.VideoFrames;
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const config = yield* ServerConfig.ServerConfig;
    const frames = yield* service.framesForVideo({ attachment: video(), maxFrames: 3 });
    yield* fs.remove(frames[1]!.path);
    const before = h.calls.length;
    const regenerated = yield* service.framesForVideo({ attachment: video(), maxFrames: 3 });
    expect(h.calls.length).toBeGreaterThan(before);
    expect(yield* fs.exists(regenerated[1]!.path)).toBe(true);
    const cleanup = yield* ResourceCleanup.ResourceCleanupService;
    yield* cleanup.cleanupAttachments([video().id]);
    expect(yield* fs.exists(path.join(config.attachmentsDir, "video-frames", video().id))).toBe(
      false,
    );
  }).pipe(
    Effect.provide(
      ResourceCleanup.layer.pipe(
        Layer.provide(
          Layer.mergeAll(
            Layer.mock(TerminalManager.TerminalManager)({}),
            Layer.mock(PreviewManager.PreviewManager)({}),
          ),
        ),
        Layer.provideMerge(h.layer),
      ),
    ),
  );
});

it.effect("drops middle frames evenly to fit the image bytes remaining", () => {
  const h = harness({ bytes: 1024 });
  return Effect.gen(function* () {
    const service = yield* VideoFrames.VideoFrames;
    const image: ChatAttachment = {
      type: "image",
      id: "image",
      name: "image.png",
      mimeType: "image/png",
      sizeBytes: PROVIDER_SEND_TURN_MAX_TOTAL_IMAGE_BYTES / 8 - 512,
    };
    const images = Array.from({ length: 8 }, (_, i) => ({ ...image, id: `image-${i}` }));
    const frames = yield* service.framesForMessage([video(), ...images]);
    expect(frames.map((f) => f.timestampMs)).toEqual([0, 4000, 7000, 11000]);
    expect(frames.reduce((sum, f) => sum + f.sizeBytes, image.sizeBytes * 8)).toBe(
      PROVIDER_SEND_TURN_MAX_TOTAL_IMAGE_BYTES,
    );
    expect(
      yield* service.framesForMessage([
        video(),
        ...images.map((a) => ({ ...a, sizeBytes: PROVIDER_SEND_TURN_MAX_TOTAL_IMAGE_BYTES / 8 })),
      ]),
    ).toEqual([]);
  }).pipe(Effect.provide(h.layer));
});

it.effect("is unavailable when ffprobe is missing even though ffmpeg runs", () => {
  const h = harness({ missingProbe: true });
  return Effect.gen(function* () {
    const service = yield* VideoFrames.VideoFrames;
    expect(yield* service.available).toBe(false);
  }).pipe(Effect.provide(h.layer));
});

it.effect("returns typed ffmpeg absence and omits frames from messages", () => {
  const h = harness({ missing: true });
  return Effect.gen(function* () {
    const service = yield* VideoFrames.VideoFrames;
    expect(
      yield* service.framesForVideo({ attachment: video(), maxFrames: 2 }).pipe(Effect.flip),
    ).toBeInstanceOf(VideoFrames.FfmpegUnavailable);
    expect(yield* service.framesForMessage([video()])).toEqual([]);
    expect(h.calls).toHaveLength(1);
  }).pipe(Effect.provide(h.layer));
});

it.effect("omits an extraction failure without failing the message", () => {
  const h = harness({ failVideo: true });
  return Effect.gen(function* () {
    const service = yield* VideoFrames.VideoFrames;
    expect(yield* service.framesForMessage([video()])).toEqual([]);
  }).pipe(Effect.provide(h.layer));
});

it.effect("spends frames on the moments the screen changed and marks them", () => {
  const h = harness({ changesMs: [0, 2000, 2233, 5000, 5066] });
  return Effect.gen(function* () {
    const service = yield* VideoFrames.VideoFrames;
    const frames = yield* service.framesForVideo({ attachment: video(), maxFrames: 12 });
    expect(frames).toHaveLength(12);
    expect(frames.filter((f) => f.changed).map((f) => f.timestampMs)).toEqual([
      2000, 2233, 5000, 5066,
    ]);
    const detections = h.calls.filter((call) => call.args.includes("-hide_banner"));
    expect(detections).toHaveLength(1);
    yield* service.framesForVideo({
      attachment: video(),
      range: { startMs: 1900, endMs: 2400 },
      maxFrames: 6,
    });
    expect(h.calls.filter((call) => call.args.includes("-hide_banner"))).toHaveLength(1);
  }).pipe(Effect.provide(h.layer));
});

it.effect("falls back to even spacing when change detection fails", () => {
  const h = harness({ failDetect: true });
  return Effect.gen(function* () {
    const service = yield* VideoFrames.VideoFrames;
    const frames = yield* service.framesForVideo({ attachment: video(), maxFrames: 12 });
    expect(frames.map((f) => f.timestampMs)).toEqual(
      Array.from({ length: 12 }, (_, i) => i * 1000),
    );
    expect(frames.some((f) => f.changed)).toBe(false);
  }).pipe(Effect.provide(h.layer));
});

it.effect("extracts real JPEGs from a generated fixture when ffmpeg is installed", () =>
  Effect.gen(function* () {
    const runner = yield* ProcessRunner.ProcessRunner;
    const present = yield* VideoFrames.ffmpegAvailable;
    if (!present) {
      yield* Effect.logWarning("Skipping real video fixture: ffmpeg is absent from PATH");
      return;
    }
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const config = yield* ServerConfig.ServerConfig;
    const attachment = video();
    const source = path.join(config.attachmentsDir, `${attachment.id}.mp4`);
    const generated = yield* runner.run({
      command: "ffmpeg",
      args: [
        "-nostdin",
        "-v",
        "error",
        "-f",
        "lavfi",
        "-i",
        "color=c=red:s=1600x900:r=10:d=1",
        "-c:v",
        "mpeg4",
        "-y",
        source,
      ],
    });
    expect(generated.code).toBe(0);
    const service = yield* VideoFrames.VideoFrames;
    const frames = yield* service.framesForVideo({ attachment, maxFrames: 3 });
    expect(frames).toHaveLength(3);
    for (const frame of frames) {
      const bytes = yield* fs.readFile(frame.path);
      expect(Array.from(bytes.slice(0, 2))).toEqual([255, 216]);
      expect(readImageDimensions(bytes)).toEqual({ width: 1280, height: 720 });
      expect(frame.sizeBytes).toBeGreaterThan(0);
    }
  }).pipe(
    Effect.provide(
      VideoFrames.layer.pipe(
        Layer.provideMerge(ProcessRunner.layer),
        Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "video-frames-real-" })),
        Layer.provideMerge(NodeServices.layer),
      ),
    ),
  ),
);

it.effect("finds a 200 ms toast and a one-frame flicker in a real still recording", () =>
  Effect.gen(function* () {
    const runner = yield* ProcessRunner.ProcessRunner;
    if (!(yield* VideoFrames.ffmpegAvailable)) return;
    const path = yield* Path.Path;
    const config = yield* ServerConfig.ServerConfig;
    const attachment = video(1);
    const source = path.join(config.attachmentsDir, `${attachment.id}.mp4`);
    const generated = yield* runner.run({
      command: "ffmpeg",
      args: [
        "-nostdin",
        "-v",
        "error",
        "-f",
        "lavfi",
        "-i",
        "color=c=0x203040:s=1280x720:r=30:d=8",
        "-vf",
        "drawbox=x=900:y=40:w=300:h=60:color=red:t=fill:enable='between(t,2.0,2.2)',drawbox=x=100:y=600:w=80:h=40:color=white:t=fill:enable='between(t,5.0,5.034)'",
        "-c:v",
        "libx264",
        "-pix_fmt",
        "yuv420p",
        "-y",
        source,
      ],
    });
    expect(generated.code).toBe(0);
    const service = yield* VideoFrames.VideoFrames;
    const frames = yield* service.framesForVideo({ attachment, maxFrames: 12 });
    const changed = frames.filter((frame) => frame.changed).map((frame) => frame.timestampMs);
    expect(changed.some((ms) => Math.abs(ms - 2000) < 70)).toBe(true);
    expect(changed.some((ms) => Math.abs(ms - 5000) < 70)).toBe(true);
  }).pipe(
    Effect.provide(
      VideoFrames.layer.pipe(
        Layer.provideMerge(ProcessRunner.layer),
        Layer.provideMerge(
          ServerConfig.layerTest(process.cwd(), { prefix: "video-frames-toast-" }),
        ),
        Layer.provideMerge(NodeServices.layer),
      ),
    ),
  ),
);
