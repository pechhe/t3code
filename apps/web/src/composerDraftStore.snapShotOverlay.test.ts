import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { EnvironmentId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import { createModelSelection } from "@t3tools/shared/model";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

vi.mock("./lib/appSurface", () => ({ isSnapShotOverlaySurface: true }));

const MAIN_KEY = "t3code:composer-drafts:v1";
const OVERLAY_KEY = "t3code:snap-shot-overlay:composer-drafts:v1";
const CLAUDE = ProviderInstanceId.make("claudeAgent");
const threadRef = scopeThreadRef(EnvironmentId.make("environment-local"), ThreadId.make("t1"));

// One localStorage for the store and the read-back that confirms its saves, as in a window.
function memoryLocalStorage(): Storage {
  const items = new Map<string, string>();
  return {
    clear: () => items.clear(),
    getItem: (key) => items.get(key) ?? null,
    key: (index) => [...items.keys()][index] ?? null,
    get length() {
      return items.size;
    },
    removeItem: (key) => void items.delete(key),
    setItem: (key, value) => void items.set(key, value),
  };
}

async function loadStore() {
  vi.resetModules();
  return (await import("./composerDraftStore")).useComposerDraftStore;
}

describe("composer drafts in the SnapShot overlay", () => {
  beforeEach(() => {
    const storage = memoryLocalStorage();
    vi.stubGlobal("localStorage", storage);
    vi.stubGlobal("window", {
      localStorage: storage,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
    });
  });
  afterEach(() => vi.unstubAllGlobals());

  it("saves a capture to its own draft without touching the main window's", async () => {
    const mainDrafts = JSON.stringify({ state: { draftsByThreadKey: {} }, version: 9 });
    localStorage.setItem(MAIN_KEY, mainDrafts);
    const store = await loadStore();
    const file = new File([new Uint8Array(4).fill(1)], "capture.png", { type: "image/png" });
    const dataUrl = "data:image/png;base64,AQEBAQ==";
    store.getState().addImage(threadRef, {
      type: "image",
      id: "capture-1",
      name: file.name,
      mimeType: file.type,
      sizeBytes: file.size,
      previewUrl: dataUrl,
      file,
    });

    await store
      .getState()
      .syncPersistedAttachments(threadRef, [
        { id: "capture-1", name: file.name, mimeType: file.type, sizeBytes: file.size, dataUrl },
      ]);

    const draft = store.getState().getComposerDraft(threadRef);
    expect(draft?.persistedAttachments.map(({ id }) => id)).toEqual(["capture-1"]);
    expect(draft?.nonPersistedImageIds).toEqual([]);
    expect(localStorage.getItem(OVERLAY_KEY)).toContain("capture-1");
    expect(localStorage.getItem(MAIN_KEY)).toBe(mainDrafts);
  });

  it("starts with the main window's model choices but none of its drafts", async () => {
    const store = await loadStore();
    const sticky = createModelSelection(CLAUDE, "claude-opus-5-5");
    const mainStore = store.getState();
    mainStore.setStickyModelSelection(sticky);
    mainStore.setPrompt(threadRef, "a main-window draft");
    // Saved as the main window would have saved it.
    localStorage.clear();
    const { partializeComposerDraftStoreState } = await import("./composerDraftStore");
    localStorage.setItem(
      MAIN_KEY,
      JSON.stringify({ state: partializeComposerDraftStoreState(store.getState()), version: 9 }),
    );

    const overlayStore = await loadStore();

    expect(overlayStore.getState().stickyModelSelectionByProvider[CLAUDE]).toEqual(sticky);
    expect(overlayStore.getState().getComposerDraft(threadRef)).toBeNull();
  });
});
