import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { beforeEach, expect, it, vi } from "vite-plus/test";

import { useComposerDraftStore } from "~/composerDraftStore";
import type {
  ComposerScreenRecordingOutcome,
  ComposerScreenRecordingState,
} from "./composerScreenRecording";

const finish = vi.hoisted(() => ({
  current: null as ((outcome: ComposerScreenRecordingOutcome) => void) | null,
  report: null as ((state: ComposerScreenRecordingState) => void) | null,
}));
vi.mock("./composerScreenRecording", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./composerScreenRecording")>()),
  browserComposerScreenRecorderHost: () => ({}),
  createComposerScreenRecorder: (
    _host: unknown,
    onState: (state: ComposerScreenRecordingState) => void,
  ) => ({
    start: () => {
      finish.report = onState;
      return new Promise<ComposerScreenRecordingOutcome>((resolve) => {
        finish.current = resolve;
      });
    },
    pause: () => undefined,
    resume: () => undefined,
    stop: () => undefined,
    discard: () => undefined,
  }),
}));

const { screenRecordingControls, startScreenRecording } = await import("./screenRecordingSession");

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

const recordAndFinish = async (stopFirst: boolean) => {
  const open = vi.fn();
  useComposerDraftStore.getState().setPrompt(started, "Look at this glitch");
  const recording = startScreenRecording({ target: started, title: "Glitch", open }, 1_000_000);
  if (stopFirst) screenRecordingControls.stop();
  finish.current?.({
    type: "recorded",
    file: new File(["frames"], "Screen recording.webm", { type: "video/webm" }),
  });
  await recording;
  return open;
};

it("opens the recording's thread when the user presses Stop", async () => {
  expect(await recordAndFinish(true)).toHaveBeenCalledOnce();
});

it("stays put when the time limit ends the recording", async () => {
  expect(await recordAndFinish(false)).not.toHaveBeenCalled();
});

it("dictates only while the recording is running", async () => {
  const setDictation = vi.fn((_active: boolean) => Promise.resolve());
  vi.stubGlobal("window", { desktopBridge: { setDictation } });
  const recording = startScreenRecording(
    { target: started, title: "Glitch", open: vi.fn() },
    1_000_000,
  );
  const running = {
    phase: "recording",
    startedAt: 0,
    elapsedMs: 0,
    resumedAt: 0,
    source: null,
    canChangeSource: false,
  } as const;
  finish.report?.(running);
  finish.report?.({ ...running, resumedAt: null });
  finish.report?.(running);
  finish.report?.({ phase: "finishing" });
  finish.current?.({ type: "failed", error: new Error("stopped") });
  await recording;
  await vi.waitFor(() => expect(setDictation).toHaveBeenCalledTimes(4));
  expect(setDictation.mock.calls.map(([active]) => active)).toEqual([true, false, true, false]);
});
