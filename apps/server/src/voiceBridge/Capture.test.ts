import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { captureFrontWindow, captureSkipBundleIds, FLUIDVOICE_BUNDLE_ID } from "./Capture.ts";

it.effect("skips FluidVoice's own window, so the capture is the page behind it", () =>
  Effect.sync(() => {
    assert.strictEqual(FLUIDVOICE_BUNDLE_ID, "com.FluidApp.app");
    assert.strictEqual(captureSkipBundleIds(), FLUIDVOICE_BUNDLE_ID);
  }),
);

it.effect("captures nothing off macOS", () =>
  Effect.gen(function* () {
    if (process.platform === "darwin") return;
    const captured = yield* Effect.promise(() => captureFrontWindow("/tmp/t3-voice-bridge-test.png"));
    assert.isNull(captured);
  }),
);
