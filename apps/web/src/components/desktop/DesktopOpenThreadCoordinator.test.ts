import {
  scopedThreadKey,
  scopeProjectRef,
  scopeThreadRef,
} from "@t3tools/client-runtime/environment";
import { EnvironmentId, ProjectId, ThreadId } from "@t3tools/contracts";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { DraftId, useComposerDraftStore } from "../../composerDraftStore";
import { useDockedDraftHeroStore } from "../../lib/draftHeroDock";
import { receiveSnapShotDraft } from "./DesktopOpenThreadCoordinator";

vi.mock("../../lib/desktopSnapShot", () => ({ dispatchSnapShotComposerFocus: vi.fn() }));

const environmentId = EnvironmentId.make("handoff-environment");
const projectRef = scopeProjectRef(environmentId, ProjectId.make("scratch-project"));
const draftId = DraftId.make("main-draft");
const threadId = ThreadId.make("main-draft-thread");
const capture = {
  id: "capture-1",
  name: "capture.png",
  mimeType: "image/png",
  sizeBytes: 4,
  dataUrl: "data:image/png;base64,AQEBAQ==",
};

function openProjectDraft() {
  useComposerDraftStore.getState().setProjectDraftThreadId(projectRef, draftId, { threadId });
  return Promise.resolve({ draftId, threadId });
}

describe("receiving the SnapShot overlay's chat in the main window", () => {
  beforeEach(() => {
    useComposerDraftStore.setState({
      draftsByThreadKey: {},
      draftThreadsByThreadKey: {},
      logicalProjectDraftThreadKeyByLogicalProjectKey: {},
    });
    useDockedDraftHeroStore.setState({ threadKeys: new Set() });
  });

  it("carries the prompt and captures into the project's draft, docked", async () => {
    await receiveSnapShotDraft(
      { projectRef, prompt: "what is this?", images: [capture] },
      openProjectDraft,
    );

    const draft = useComposerDraftStore.getState().getComposerDraft(draftId);
    expect(draft?.prompt).toBe("what is this?");
    expect(draft?.images.map(({ id }) => id)).toEqual(["capture-1"]);
    expect(
      useDockedDraftHeroStore
        .getState()
        .threadKeys.has(scopedThreadKey(scopeThreadRef(environmentId, threadId))),
    ).toBe(true);
  });

  it("keeps what the main window already drafted and does not attach a capture twice", async () => {
    await openProjectDraft();
    useComposerDraftStore.getState().setPrompt(draftId, "earlier note");
    await receiveSnapShotDraft(
      { projectRef, prompt: "what is this?", images: [capture] },
      openProjectDraft,
    );
    await receiveSnapShotDraft({ projectRef, prompt: "", images: [capture] }, openProjectDraft);

    const draft = useComposerDraftStore.getState().getComposerDraft(draftId);
    expect(draft?.prompt).toBe("earlier note\n\nwhat is this?");
    expect(draft?.images.map(({ id }) => id)).toEqual(["capture-1"]);
  });
});
