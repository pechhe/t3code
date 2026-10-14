import { expect, it } from "@effect/vitest";
import type { AgentPolicySnapshot, ServerProvider } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Resolver from "./AgentRoleResolver.ts";
import {
  snapshot,
  provider,
  request,
  codex,
  claude,
  codexModel,
  claudeModel,
} from "./agentPolicy.testkit.ts";

type Input = Parameters<Resolver.AgentRoleResolver["Service"]["resolve"]>[0];
const input = (overrides: Partial<Input> = {}): Input => ({
  snapshot: snapshot(),
  request: request(),
  providers: [codex, claude],
  ceiling: "full-access",
  ...overrides,
});
const resolve = (value: Input) =>
  Effect.gen(function* () {
    const service = yield* Resolver.AgentRoleResolver;
    return yield* service.resolve(value);
  });
const refusal = (value: Input) => resolve(value).pipe(Effect.flip);

it.layer(Resolver.layer)("AgentRoleResolver", (it) => {
  it.effect("selects a workhorse with explicit medium and deliberate high effort", () =>
    Effect.gen(function* () {
      expect(yield* resolve(input())).toEqual({
        instanceId: codex.instanceId,
        model: codexModel,
        options: [{ id: "reasoning", value: "medium" }],
      });
      expect(yield* resolve(input({ request: request({ demanding: true }) }))).toEqual({
        instanceId: codex.instanceId,
        model: codexModel,
        options: [{ id: "reasoning", value: "high" }],
      });
      const lowOnly = provider("codex", "codex-low", [codexModel], ["low"]);
      expect((yield* refusal(input({ providers: [lowOnly] }))).reason).toBe("no-eligible-model");
      const mediumOnly = provider("codex", "codex-medium", [codexModel], ["medium"]);
      expect(
        (yield* refusal(input({ providers: [mediumOnly], request: request({ demanding: true }) })))
          .reason,
      ).toBe("no-eligible-model");
    }),
  );

  it.effect("keeps roles inside their pools and rejects UI implementation classification", () =>
    Effect.gen(function* () {
      expect(
        (yield* refusal(
          input({ providers: [provider("codex", "advisor-only", ["gpt-astra-test"])] }),
        )).reason,
      ).toBe("no-eligible-model");
      expect((yield* refusal(input({ request: request({ taskClass: "ui" }) }))).reason).toBe(
        "classification",
      );
    }),
  );

  it.effect("prefers an independent reviewer model over the author's current account", () =>
    Effect.gen(function* () {
      const value = yield* resolve(
        input({
          request: request({
            role: "reviewer",
            sourceRevision: "reviewed-commit",
            authorModel: codexModel,
          }),
          currentInstanceId: codex.instanceId,
        }),
      );
      expect(value.model).toBe(claudeModel);
      expect(value.instanceId).toBe(claude.instanceId);
      expect(value.options).toEqual([{ id: "effort", value: "medium" }]);
    }),
  );

  it.effect("requires a pinned source revision for review", () =>
    Effect.gen(function* () {
      expect((yield* refusal(input({ request: request({ role: "reviewer" }) }))).reason).toBe(
        "source-pin-required",
      );
    }),
  );

  it.effect("rejects forbidden experimental selections and incompatible options", () =>
    Effect.gen(function* () {
      const base = input({
        request: request({ role: "reviewer", sourceRevision: "reviewed-commit" }),
      });
      expect(
        (yield* refusal({
          ...base,
          selection: {
            instanceId: codex.instanceId,
            model: "gpt-astra-test",
            options: [{ id: "reasoning", value: "medium" }],
          },
        })).reason,
      ).toBe("selection-denied");
      for (const options of [
        undefined,
        [{ id: "reasoning", value: "high" }],
        [
          { id: "reasoning", value: "medium" },
          { id: "fastMode", value: true },
        ],
      ]) {
        expect(
          (yield* refusal({
            ...base,
            selection: {
              instanceId: codex.instanceId,
              model: codexModel,
              ...(options === undefined ? {} : { options }),
            },
          })).reason,
        ).toBe("unsupported-options");
      }
      expect(
        yield* resolve({
          ...base,
          selection: {
            instanceId: codex.instanceId,
            model: codexModel,
            options: [{ id: "reasoning", value: "medium" }],
          },
        }),
      ).toEqual({
        instanceId: codex.instanceId,
        model: codexModel,
        options: [{ id: "reasoning", value: "medium" }],
      });
    }),
  );

  it.effect(
    "falls back only to an eligible authenticated account without replacing an assignment",
    () =>
      Effect.gen(function* () {
        const unavailable: ServerProvider = { ...codex, availability: "unavailable" };
        const base = input({
          request: request({ role: "reviewer", sourceRevision: "reviewed-commit" }),
          providers: [unavailable, claude],
          currentInstanceId: codex.instanceId,
        });
        expect((yield* resolve(base)).instanceId).toBe(claude.instanceId);
        expect(
          (yield* refusal({
            ...base,
            selection: {
              instanceId: codex.instanceId,
              model: codexModel,
              options: [{ id: "reasoning", value: "medium" }],
            },
          })).reason,
        ).toBe("selection-denied");
        for (const unusable of [
          unavailable,
          { ...codex, installed: false },
          { ...codex, enabled: false },
          { ...codex, status: "error" as const },
          { ...codex, auth: { status: "unauthenticated" as const } },
          { ...codex, auth: { status: "unknown" as const } },
        ]) {
          expect((yield* refusal(input({ providers: [unusable] }))).reason).toBe(
            "no-eligible-model",
          );
        }
        expect((yield* refusal(input({ providers: [] }))).reason).toBe("no-eligible-model");
      }),
  );

  it.effect(
    "restricts mixed/UI review to Sonnet and refuses an experimental Codex assignment",
    () =>
      Effect.gen(function* () {
        for (const taskClass of ["ui", "mixed"] as const) {
          const base = input({
            request: request({ role: "reviewer", sourceRevision: "reviewed-commit", taskClass }),
            currentInstanceId: codex.instanceId,
          });
          expect((yield* resolve(base)).model).toBe(claudeModel);
          expect((yield* refusal({ ...base, providers: [codex] })).reason).toBe(
            "no-eligible-model",
          );
          expect(
            (yield* refusal({
              ...base,
              selection: {
                instanceId: codex.instanceId,
                model: codexModel,
                options: [{ id: "reasoning", value: "medium" }],
              },
            })).reason,
          ).toBe("selection-denied");
        }
      }),
  );

  it.effect("enforces actual UI model identity even when policy aliases are misleading", () =>
    Effect.gen(function* () {
      const original = snapshot();
      const policy: AgentPolicySnapshot = {
        ...original,
        manifest: {
          ...original.manifest,
          models: {
            ...original.manifest.models,
            sonnet: { driverKind: codex.driver, model: codexModel, effortOption: "reasoning" },
          },
        },
      };
      const base = input({
        snapshot: policy,
        request: request({ role: "reviewer", sourceRevision: "reviewed-commit", taskClass: "ui" }),
      });
      expect((yield* refusal(base)).reason).toBe("no-eligible-model");
      const disguised = provider("claudeAgent", "disguised-openai", [codexModel]);
      const disguisedPolicy: AgentPolicySnapshot = {
        ...policy,
        manifest: {
          ...policy.manifest,
          models: {
            ...policy.manifest.models,
            sonnet: { driverKind: disguised.driver, model: codexModel, effortOption: "effort" },
          },
        },
      };
      expect(
        (yield* refusal({ ...base, snapshot: disguisedPolicy, providers: [disguised] })).reason,
      ).toBe("no-eligible-model");
    }),
  );

  it.effect("permits read-only Claude but explicitly refuses Claude source writes", () =>
    Effect.gen(function* () {
      const base = input({ providers: [claude] });
      expect((yield* resolve({ ...base, request: request({ readOnly: true }) })).model).toBe(
        claudeModel,
      );
      expect((yield* refusal(base)).reason).toBe("no-eligible-model");
      expect((yield* refusal(input({ ceiling: "approval-required" }))).reason).toBe(
        "unsupported-permissions",
      );
      expect(
        (yield* resolve(
          input({ ceiling: "approval-required", request: request({ readOnly: true }) }),
        )).model,
      ).toBe(claudeModel);
    }),
  );

  it.effect("fails closed for browser and UI-verifier without an enforceable Phi route", () =>
    Effect.gen(function* () {
      for (const role of ["browser", "ui-verifier"] as const) {
        expect(
          (yield* refusal(input({ request: request({ role, taskClass: "ui" }) }))).reason,
        ).toBe("unsupported-tools");
      }
    }),
  );
});
