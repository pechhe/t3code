import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { beforeEach, expect, it, vi } from "vite-plus/test";

import { useComposerDraftStore } from "~/composerDraftStore";
import type { ComposerScreenRecordingOutcome } from "./composerScreenRecording";

const finish = vi.hoisted(() => ({
  current: null as ((outcome: ComposerScreenRecordingOutcome) => void) | null,
}));
vi.mock("./composerScreenRecording", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./composerScreenRecording")>()),
  browserComposerScreenRecorderHost: () => ({}),
  createComposerScreenRecorder: () => ({
    start: () =>
      new Promise<ComposerScreenRecordingOutcome>((resolve) => {
        finish.current = resolve;
      }),
    pause: () => undefined,
    resume: () => undefined,
    stop: () => undefined,
    discard: () => undefined,
  }),
}));

const { startScreenRecording } = await import("./screenRecordingSession");

const environmentId = EnvironmentId.make("environment-1");
const started = { environmentId, threadId: ThreadId.make("thread-started") };
const visited = { environmentId, threadId: ThreadId.make("thread-visited") };

beforeEach(() => {
  vi.stubGlobal("window", {});
  useComposerDraftStore.setState({ draftsByThreadKey: {}, draftThreadsByThreadKey: {} });
});

it("attaches the recording to the thread it started in, not the one open when it stops", async () => {
  const store = useComposerDraftStore.getState();
  store.setPrompt(started, "Look at this glitch");
  const recording = startScreenRecording(
    { target: started, title: "Glitch", open: () => undefined },
    1_000_000,
  );
  // The user moves to another thread and works there while recording.
  store.setPrompt(visited, "Unrelated draft");
  finish.current?.({
    type: "recorded",
    file: new File(["frames"], "Screen recording.webm", { type: "video/webm;codecs=vp9" }),
  });
  await recording;

  const draft = store.getComposerDraft(started);
  expect(draft?.files.map((file) => [file.name, file.mimeType])).toEqual([
    ["Screen recording.webm", "video/webm"],
  ]);
  expect(draft?.prompt).toContain("Look at this glitch");
  expect(draft?.prompt.length).toBeGreaterThan("Look at this glitch".length);
  expect(store.getComposerDraft(visited)?.files ?? []).toEqual([]);
  expect(store.getComposerDraft(visited)?.prompt).toBe("Unrelated draft");
});
