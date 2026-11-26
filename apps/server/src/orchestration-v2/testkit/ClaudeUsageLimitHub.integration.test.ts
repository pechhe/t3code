import { assert, describe, it } from "@effect/vitest";
import {
  ProviderDriverKind,
  type ServerProvider,
  UsageLimitSourceId,
  type UsageLimitSourceSnapshot,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { ClaudeOrchestratorReplayHarness } from "../Adapters/ClaudeAdapterV2.testkit.ts";
import * as UsageLimitSources from "../../usage/UsageLimitSources.ts";
import { claudeUsageLimitFailure } from "./fixtures/usage_limit/claude_output.ts";
import { findReplayFixture, runReplayFixture } from "./ProviderReplayFixtures.ts";

describe("Claude usage limit through a hub", () => {
  it.effect("takes the reset of the hub accounts that serve the model the hub refused", () =>
    Effect.gen(function* () {
      const fixture = findReplayFixture("usage_limit")!;
      const driver = fixture.providers[0]!;
      const endpoint = "http://127.0.0.1:18319";
      const account = (id: string, model: string, usedPercent: number, resetsAt: string) => ({
        id,
        driver: ProviderDriverKind.make("claudeAgent"),
        models: [model],
        usageLimits: {
          checkedAt: resetsAt,
          windows: [
            { id: "five_hour", kind: "session" as const, label: "Session", usedPercent, resetsAt },
          ],
        },
      });
      const hub = (id: string, origin: string, accounts: ReadonlyArray<object>) =>
        ({
          id: UsageLimitSourceId.make(id),
          kind: "cliproxy",
          label: id,
          origin,
          checkedAt: "",
          accounts,
        }) as UsageLimitSourceSnapshot;
      yield* runReplayFixture({
        fixtureName: fixture.name,
        buildInput: fixture.buildInput,
        driver: {
          ...driver,
          assertOutput: (result, transcript) => {
            const failure = claudeUsageLimitFailure(result, transcript);
            assert.equal(failure.class, "usage_limit");
            assert.equal(failure.resetAt, "2033-05-19T07:20:00.000Z");
          },
        },
        harness: ClaudeOrchestratorReplayHarness,
        providerInstances: {
          getInstance: () =>
            Effect.succeed({
              snapshot: {
                getSnapshot: Effect.succeed({
                  auth: { status: "unknown", type: "customEndpoint", endpoint },
                } as ServerProvider),
              },
            } as never),
        },
      }).pipe(
        Effect.provide(
          UsageLimitSources.layerResetFallback.pipe(
            Layer.provide(
              Layer.mock(UsageLimitSources.UsageLimitSources)({
                current: Effect.succeed([
                  hub("home", endpoint, [
                    account("sonnet", driver.modelSelection.model, 100, "2033-05-19T07:20:00.000Z"),
                    // regression: #30778 an account the hub does not route the model to has no say
                    account("opus", "claude-opus-4-8", 10, "2033-05-19T05:00:00.000Z"),
                  ]),
                  hub("elsewhere", "http://127.0.0.1:9999", [
                    account("other", driver.modelSelection.model, 100, "2033-05-18T00:00:00.000Z"),
                  ]),
                ]),
                refresh: Effect.void,
              }),
            ),
          ),
        ),
      );
    }),
  );
});
