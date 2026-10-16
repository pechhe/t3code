import { type ChatAttachment, PROVIDER_SEND_TURN_MAX_TOTAL_IMAGE_BYTES } from "@t3tools/contracts";
import type { ProviderAdapterV2VideoFrame } from "@t3tools/provider-core/server/ProviderAdapter";
import { videoMimeType } from "@t3tools/shared/video";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Option from "effect/Option";
import * as Semaphore from "effect/Semaphore";

import {
  parseAttachmentUuid,
  parseThreadSegmentFromAttachmentId,
  PENDING_ATTACHMENT_THREAD_SEGMENT,
  resolveAttachmentPath,
} from "../attachmentStore.ts";
import * as ServerConfig from "../config.ts";
import * as ProcessRunner from "../processRunner.ts";
import { pickFrameTimes } from "./frameTimes.ts";

export class FfmpegUnavailable extends Schema.TaggedError<FfmpegUnavailable>()(
  "FfmpegUnavailable",
  {},
) {
  override get message() {
    return "ffmpeg is unavailable on the server.";
  }
}

export class NotASampleableVideo extends Schema.TaggedError<NotASampleableVideo>()(
  "NotASampleableVideo",
  { attachmentId: Schema.String },
) {
  override get message() {
    return "The attachment is not a stored video that frames can be sampled from.";
  }
}

export class VideoAttachmentNotInThread extends Schema.TaggedError<VideoAttachmentNotInThread>()(
  "VideoAttachmentNotInThread",
  { attachmentId: Schema.String },
) {
  override get message() {
    return "The attachment is not in this thread.";
  }
}

/** `durationMs` is present when the range was checked against the probed video. */
export class VideoRangeInvalid extends Schema.TaggedError<VideoRangeInvalid>()(
  "VideoRangeInvalid",
  { attachmentId: Schema.String, durationMs: Schema.optional(Schema.Number) },
) {
  override get message() {
    return this.durationMs === undefined
      ? "The range must be finite, non-negative and end at or after its start."
      : `The range starts past the end of the video (${Math.floor(this.durationMs)} ms long).`;
  }
}

/** An operational failure; `stage` is diagnostic only and never drives callers. */
export class VideoFramesError extends Schema.TaggedError<VideoFramesError>()("VideoFramesError", {
  attachmentId: Schema.String,
  stage: Schema.Literals(["probe", "extract", "cache"]),
  cause: Schema.Defect(),
}) {
  override get message() {
    return `Video frame sampling failed during ${this.stage}.`;
  }
}

type FramesForVideoError =
  | FfmpegUnavailable
  | NotASampleableVideo
  | VideoRangeInvalid
  | VideoFramesError;

type VideoInput = {
  readonly attachment: ChatAttachment;
  readonly range?: { readonly startMs: number; readonly endMs: number };
  readonly maxFrames: number;
};

export class VideoFrames extends Context.Service<
  VideoFrames,
  {
    readonly available: Effect.Effect<boolean>;
    readonly framesForVideo: (
      input: VideoInput,
    ) => Effect.Effect<ReadonlyArray<ProviderAdapterV2VideoFrame>, FramesForVideoError>;
    /** Frames over a range of a video found among one thread's attachments. */
    readonly framesForThreadVideo: (input: {
      readonly threadAttachments: ReadonlyArray<ChatAttachment>;
      readonly attachmentId: string;
      readonly range: { readonly startMs: number; readonly endMs: number };
      readonly maxFrames: number;
    }) => Effect.Effect<
      { readonly videoName: string; readonly frames: ReadonlyArray<ProviderAdapterV2VideoFrame> },
      FramesForVideoError | VideoAttachmentNotInThread
    >;
    readonly framesForMessage: (
      attachments: ReadonlyArray<ChatAttachment>,
    ) => Effect.Effect<ReadonlyArray<ProviderAdapterV2VideoFrame>>;
  }
>()("t3/videoFrames/VideoFrames") {}

export const ffmpegAvailable = Effect.gen(function* () {
  const runner = yield* ProcessRunner.ProcessRunner;
  const env = yield* HostProcess.Environment;
  return yield* runner
    .run({
      command: "ffmpeg",
      args: ["-version"],
      env,
      timeout: "5 seconds",
      maxOutputBytes: 16384,
    })
    .pipe(
      Effect.map((result) => result.code === 0),
      Effect.orElseSucceed(() => false),
    );
});

const Manifest = Schema.Array(
  Schema.Struct({
    timestampMs: Schema.Number,
    sizeBytes: Schema.Number,
    changed: Schema.optionalKey(Schema.Boolean),
  }),
);
const Changes = Schema.Array(Schema.Number);
const Probe = Schema.Struct({
  streams: Schema.Array(
    Schema.Struct({
      avg_frame_rate: Schema.optionalKey(Schema.String),
      duration: Schema.optionalKey(Schema.String),
    }),
  ),
  format: Schema.Struct({ duration: Schema.optionalKey(Schema.String) }),
});
const decodeManifest = Schema.decodeEffect(Schema.fromJsonString(Manifest));
const encodeManifest = Schema.encodeEffect(Schema.fromJsonString(Manifest));
const decodeChanges = Schema.decodeEffect(Schema.fromJsonString(Changes));
const encodeChanges = Schema.encodeEffect(Schema.fromJsonString(Changes));
const decodeProbe = Schema.decodeEffect(Schema.fromJsonString(Probe));
const isVideoFramesError = Schema.is(VideoFramesError);

const MAX_RANGE_CACHES_PER_VIDEO = 8;
// Finding changes decodes every frame, so longer videos keep even spacing instead of
// stalling the turn that carries them. Recordings stop at 60 seconds.
const MAX_CHANGE_DETECTION_MS = 120_000;
// A dot-prefixed name keeps pruneRangeCaches away from it.
const CHANGES_FILE = ".changes.json";
const SHOWINFO_PTS_TIME = /Parsed_showinfo.*\spts_time:([0-9.]+)/;

function evenly<T>(items: ReadonlyArray<T>, count: number): Array<T> {
  if (count <= 0) return [];
  if (items.length <= count) return [...items];
  if (count === 1) return [items[0]!];
  return Array.from(
    { length: count },
    (_, i) => items[Math.round((i * (items.length - 1)) / (count - 1))]!,
  );
}

const make = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const config = yield* ServerConfig.ServerConfig;
  const runner = yield* ProcessRunner.ProcessRunner;
  const env = yield* HostProcess.Environment;
  const available = yield* Effect.cached(
    ffmpegAvailable.pipe(
      Effect.provideService(ProcessRunner.ProcessRunner, runner),
      Effect.provideService(HostProcess.Environment, env),
    ),
  );
  // Per video, so one slow extraction never delays other threads' turns.
  const locks = new Map<string, Semaphore.Semaphore>();
  const lockFor = (attachmentId: string) => {
    let lock = locks.get(attachmentId);
    if (lock === undefined) {
      lock = Semaphore.makeUnsafe(1);
      locks.set(attachmentId, lock);
    }
    return lock;
  };
  const run = Effect.fn("VideoFrames.run")(function* (
    attachmentId: string,
    stage: "probe" | "extract",
    command: string,
    args: ReadonlyArray<string>,
  ) {
    const result = yield* runner
      .run({ command, args, env, timeout: "60 seconds", maxOutputBytes: 65536 })
      .pipe(Effect.mapError((cause) => new VideoFramesError({ attachmentId, stage, cause })));
    if (result.code !== 0)
      return yield* new VideoFramesError({ attachmentId, stage, cause: result.code });
    return result.stdout;
  });
  // mpdecimate drops frames that match their predecessor, so the frames showinfo sees are
  // the moments the screen changed. The first frame is always kept and is no change.
  const detectChanges = Effect.fn("VideoFrames.detectChanges")(function* (
    attachmentId: string,
    source: string,
    root: string,
  ) {
    const cachePath = path.join(root, CHANGES_FILE);
    const cached = yield* fs.readFileString(cachePath).pipe(
      Effect.flatMap(decodeChanges),
      Effect.orElseSucceed(() => undefined),
    );
    if (cached) return cached;
    const result = yield* runner.run({
      command: "ffmpeg",
      args: [
        "-nostdin",
        "-hide_banner",
        "-v",
        "info",
        "-i",
        source,
        "-an",
        "-map",
        "0:v:0",
        "-vf",
        "scale=w='min(960,iw)':h=-2,mpdecimate=hi=512:lo=192:frac=0.1,showinfo=checksum=0",
        "-fps_mode",
        "passthrough",
        "-f",
        "null",
        "-",
      ],
      env,
      timeout: "60 seconds",
      maxOutputBytes: 4 * 1024 * 1024,
    });
    if (result.code !== 0 || result.stderrTruncated)
      return yield* new VideoFramesError({ attachmentId, stage: "extract", cause: result.code });
    const changesMs = result.stderr
      .split("\n")
      .flatMap((line) => {
        const seconds = SHOWINFO_PTS_TIME.exec(line)?.[1];
        return seconds === undefined ? [] : [Math.floor(Number(seconds) * 1000)];
      })
      .slice(1);
    yield* fs.makeDirectory(root, { recursive: true });
    yield* fs.writeFileString(cachePath, yield* encodeChanges(changesMs));
    return changesMs;
  });
  // Ranged requests are agent-driven, so keep only the most recent few per video; the
  // full-video set always stays. Every variant is regenerable.
  const pruneRangeCaches = Effect.fn("VideoFrames.pruneRangeCaches")(function* (root: string) {
    const names = yield* fs.readDirectory(root);
    const ranged = yield* Effect.forEach(
      names.filter((name) => !name.startsWith("full-") && !name.startsWith(".")),
      (name) =>
        fs.stat(path.join(root, name)).pipe(
          Effect.map((stat) => ({
            name,
            modifiedMs: Option.match(stat.mtime, {
              onNone: () => 0,
              onSome: (date) => date.getTime(),
            }),
          })),
        ),
    );
    const stale = ranged
      .sort((a, b) => b.modifiedMs - a.modifiedMs)
      .slice(MAX_RANGE_CACHES_PER_VIDEO - 1);
    yield* Effect.forEach(
      stale,
      ({ name }) => fs.remove(path.join(root, name), { recursive: true, force: true }),
      { discard: true },
    );
  });
  const sample = Effect.fn("VideoFrames.sample")(function* (input: VideoInput) {
    const { attachment } = input;
    const count = Math.min(12, Math.max(0, Math.floor(input.maxFrames)));
    if (count === 0) return [];
    const source = resolveAttachmentPath({ attachmentsDir: config.attachmentsDir, attachment });
    if (
      attachment.type !== "file" ||
      videoMimeType(attachment) === null ||
      !parseAttachmentUuid(attachment.id) ||
      parseThreadSegmentFromAttachmentId(attachment.id) === PENDING_ATTACHMENT_THREAD_SEGMENT ||
      !source ||
      !Number.isFinite(count)
    ) {
      return yield* new NotASampleableVideo({ attachmentId: attachment.id });
    }
    if (
      input.range &&
      (!Number.isFinite(input.range.startMs) ||
        !Number.isFinite(input.range.endMs) ||
        input.range.startMs < 0 ||
        input.range.endMs < input.range.startMs)
    ) {
      return yield* new VideoRangeInvalid({ attachmentId: attachment.id });
    }
    if (!(yield* available)) return yield* new FfmpegUnavailable({});
    const root = path.join(config.attachmentsDir, "video-frames", attachment.id);
    const variant = input.range ? `${input.range.startMs}-${input.range.endMs}` : "full";
    const destination = path.join(root, `${variant}-${count}`);
    const cached = Effect.gen(function* () {
      const manifest = yield* fs.readFileString(path.join(destination, "manifest.json"));
      const entries = yield* decodeManifest(manifest);
      if (entries.length !== count) return yield* Effect.fail("incomplete");
      return yield* Effect.forEach(entries, (entry, i) =>
        Effect.gen(function* () {
          const framePath = path.join(destination, `${i}.jpg`);
          const stat = yield* fs.stat(framePath);
          if (Number(stat.size) !== entry.sizeBytes || entry.sizeBytes <= 0)
            return yield* Effect.fail("incomplete");
          return {
            videoAttachmentId: attachment.id,
            videoName: attachment.name,
            timestampMs: entry.timestampMs,
            ...(entry.changed ? { changed: true } : {}),
            path: framePath,
            mimeType: "image/jpeg" as const,
            sizeBytes: entry.sizeBytes,
          };
        }),
      );
    });
    const existing = yield* cached.pipe(Effect.orElseSucceed(() => undefined));
    if (existing) return existing;
    yield* fs
      .remove(destination, { recursive: true, force: true })
      .pipe(
        Effect.mapError(
          (cause) => new VideoFramesError({ attachmentId: attachment.id, stage: "cache", cause }),
        ),
      );
    const probeText = yield* run(attachment.id, "probe", "ffprobe", [
      "-v",
      "error",
      "-select_streams",
      "v:0",
      "-show_entries",
      "stream=duration,avg_frame_rate:format=duration",
      "-of",
      "json",
      source,
    ]);
    const probe = yield* decodeProbe(probeText).pipe(
      Effect.mapError(
        (cause) => new VideoFramesError({ attachmentId: attachment.id, stage: "probe", cause }),
      ),
    );
    const durationMs = Number(probe.streams[0]?.duration ?? probe.format.duration) * 1000;
    const rate = probe.streams[0]?.avg_frame_rate?.split("/").map(Number);
    const fps = rate && rate[1] ? rate[0]! / rate[1] : 25;
    if (!Number.isFinite(durationMs) || durationMs <= 0)
      return yield* new VideoFramesError({
        attachmentId: attachment.id,
        stage: "probe",
        cause: null,
      });
    if (input.range && input.range.startMs >= durationMs)
      return yield* new VideoRangeInvalid({ attachmentId: attachment.id, durationMs });
    const lastMs = Math.max(0, durationMs - 1000 / (Number.isFinite(fps) && fps > 0 ? fps : 25));
    const startMs = Math.min(input.range?.startMs ?? 0, lastMs);
    const endMs = Math.max(startMs, Math.min(input.range?.endMs ?? lastMs, lastMs));
    return yield* Effect.gen(function* () {
      yield* fs.makeDirectory(root, { recursive: true });
      if (input.range) yield* pruneRangeCaches(root);
      const temp = yield* Effect.acquireRelease(
        fs.makeTempDirectory({ directory: root, prefix: ".frames-" }),
        (directory) => fs.remove(directory, { recursive: true, force: true }).pipe(Effect.ignore),
      );
      // Detection is an aid: when it fails the frames are simply evenly spaced.
      const changesMs =
        durationMs <= MAX_CHANGE_DETECTION_MS
          ? yield* detectChanges(attachment.id, source, root).pipe(
              Effect.catch((cause) =>
                Effect.logWarning("Sampling video frames without change detection", {
                  attachmentId: attachment.id,
                  cause,
                }).pipe(Effect.as([] as ReadonlyArray<number>)),
              ),
            )
          : [];
      const entries = yield* Effect.forEach(
        pickFrameTimes({ startMs, endMs, count, changesMs }),
        ({ timestampMs, changed }, i) =>
          Effect.gen(function* () {
            const output = path.join(temp, `${i}.jpg`);
            // Reverse only the scaled final second so variable-rate videos retain their actual last frame.
            const lastFrame = count >= 2 && i === count - 1 && endMs === lastMs;
            const seek = lastFrame ? ["-sseof", "-1"] : ["-ss", String(timestampMs / 1000)];
            const scale =
              "scale=w='min(1280,iw)':h='min(1280,ih)':force_original_aspect_ratio=decrease";
            yield* run(attachment.id, "extract", "ffmpeg", [
              "-nostdin",
              "-v",
              "error",
              ...seek,
              "-i",
              source,
              "-map",
              "0:v:0",
              "-frames:v",
              "1",
              "-vf",
              lastFrame ? `${scale},reverse` : scale,
              "-q:v",
              "3",
              "-y",
              output,
            ]);
            const stat = yield* fs.stat(output);
            if (Number(stat.size) <= 0) return yield* Effect.fail("empty frame");
            return { timestampMs, sizeBytes: Number(stat.size), ...(changed ? { changed } : {}) };
          }),
      );
      yield* fs.writeFileString(path.join(temp, "manifest.json"), yield* encodeManifest(entries));
      // Another caller may have published the same immutable cache while we extracted.
      yield* fs.rename(temp, destination).pipe(
        Effect.catch((cause) =>
          cached.pipe(
            Effect.asVoid,
            Effect.mapError(() => cause),
          ),
        ),
      );
      return yield* cached;
    }).pipe(
      Effect.scoped,
      Effect.mapError((cause) =>
        isVideoFramesError(cause)
          ? cause
          : new VideoFramesError({ attachmentId: attachment.id, stage: "cache", cause }),
      ),
    );
  });
  const framesForVideo = (input: VideoInput) =>
    lockFor(input.attachment.id).withPermits(1)(sample(input));
  return VideoFrames.of({
    available,
    framesForVideo,
    framesForThreadVideo: Effect.fn("VideoFrames.framesForThreadVideo")(function* (input) {
      const attachment = input.threadAttachments.find(
        (candidate) => candidate.id === input.attachmentId,
      );
      if (attachment === undefined)
        return yield* new VideoAttachmentNotInThread({ attachmentId: input.attachmentId });
      const frames = yield* framesForVideo({
        attachment,
        range: input.range,
        maxFrames: input.maxFrames,
      });
      return { videoName: attachment.name, frames };
    }),
    framesForMessage: Effect.fn("VideoFrames.framesForMessage")(function* (attachments) {
      const budget = Math.max(
        0,
        PROVIDER_SEND_TURN_MAX_TOTAL_IMAGE_BYTES -
          attachments.reduce((sum, a) => sum + (a.type === "image" ? a.sizeBytes : 0), 0),
      );
      if (budget === 0) return [];
      const videos = attachments.filter((a) => a.type === "file" && videoMimeType(a) !== null);
      const groups = yield* Effect.forEach(videos, (attachment, i) =>
        framesForVideo({
          attachment,
          maxFrames: Math.min(
            12,
            Math.floor(36 / videos.length) + (i < 36 % videos.length ? 1 : 0),
          ),
        }).pipe(
          Effect.catchTags({
            FfmpegUnavailable: () => Effect.succeed([]),
            NotASampleableVideo: () => Effect.succeed([]),
            VideoRangeInvalid: () => Effect.succeed([]),
            VideoFramesError: (error) =>
              Effect.logWarning("Omitting video frames", {
                attachmentId: attachment.id,
                stage: error.stage,
              }).pipe(Effect.as([])),
          }),
        ),
      );
      const counts = groups.map((group) => group.length);
      let selected = groups;
      while (selected.flat().reduce((sum, frame) => sum + frame.sizeBytes, 0) > budget) {
        const largestCount = Math.max(...counts);
        if (largestCount === 0) break;
        const index = counts.findIndex((count) => count === largestCount);
        counts[index]! -= 1;
        selected = groups.map((group, i) => evenly(group, counts[i]!));
      }
      return selected.flat();
    }),
  });
});

export const layer = Layer.effect(VideoFrames, make);

/** One shared value so every consumer in a server build gets the same instance, lock and probe. */
export const layerLive = layer.pipe(Layer.provide(ProcessRunner.layer));
