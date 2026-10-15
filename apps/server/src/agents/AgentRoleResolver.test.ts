import { expect, it } from "@effect/vitest";
import {
  type AgentPolicySnapshot,
  ProviderInstanceId,
  type ServerProvider,
} from "@t3tools/contracts";
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
  changeReview,
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
            review: changeReview,
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

  it.effect("requires a typed review scope and coherent coverage for review", () =>
    Effect.gen(function* () {
      const reviewer = (review: Partial<typeof changeReview> | undefined, extra = {}) =>
        input({
          request: request({
            role: "reviewer",
            sourceRevision: "reviewed-commit",
            ...(review === undefined ? {} : { review: { ...changeReview, ...review } }),
            ...extra,
          }),
        });
      expect((yield* refusal(reviewer(undefined))).reason).toBe("review-scope-required");
      yield* resolve(reviewer({}));
      // A change review names what it covers; unrelated interleaved commits stay out.
      expect((yield* refusal(reviewer({ includedChanges: [] }))).reason).toBe(
        "review-scope-invalid",
      );
      // A Spec review judges a specific Spec body revision.
      const spec = { scope: "spec", coverage: "partial" } as const;
      expect((yield* refusal(reviewer(spec))).reason).toBe("review-scope-invalid");
      yield* resolve(reviewer({ ...spec, specRef: "owner/repo#12", specRevision: "body-3" }));
      // A Spec review of a no-Ticket Spec has no Ticket changes to list.
      yield* resolve(
        reviewer({
          ...spec,
          includedChanges: [],
          specRef: "owner/repo#12",
          specRevision: "body-3",
        }),
      );
      // A delta covers exactly the changes since the earlier report.
      const prior = { workId: "review-1", sourceRevision: "earlier-commit" };
      yield* resolve(reviewer({ priorReview: prior, baseRevision: "earlier-commit" }));
      expect((yield* refusal(reviewer({ priorReview: prior }))).reason).toBe(
        "review-scope-invalid",
      );
      expect(
        (yield* refusal(
          reviewer({
            priorReview: { ...prior, sourceRevision: "reviewed-commit" },
            baseRevision: "reviewed-commit",
          }),
        )).reason,
      ).toBe("review-scope-invalid");
      // Review scope belongs to the reviewer role alone.
      expect((yield* refusal(input({ request: request({ review: changeReview }) }))).reason).toBe(
        "review-scope-invalid",
      );
    }),
  );

  it.effect("rejects forbidden experimental selections and incompatible options", () =>
    Effect.gen(function* () {
      const base = input({
        request: request({
          role: "reviewer",
          sourceRevision: "reviewed-commit",
          review: changeReview,
        }),
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
          request: request({
            role: "reviewer",
            sourceRevision: "reviewed-commit",
            review: changeReview,
          }),
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
            request: request({
              role: "reviewer",
              sourceRevision: "reviewed-commit",
              review: changeReview,
              taskClass,
            }),
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
        request: request({
          role: "reviewer",
          sourceRevision: "reviewed-commit",
          review: changeReview,
          taskClass: "ui",
        }),
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

  it.effect("prefers a model from a different provider than the caller's", () =>
    Effect.gen(function* () {
      const advisor = (currentInstanceId?: typeof codex.instanceId) =>
        resolve(
          input({
            request: request({ role: "advisor" }),
            ...(currentInstanceId === undefined ? {} : { currentInstanceId }),
          }),
        );
      // The pool prefers Claude's fable, so without a caller that is the choice.
      expect((yield* advisor()).instanceId).toBe(claude.instanceId);
      // A Claude caller is advised by Codex, ahead of the pool's own preference.
      expect((yield* advisor(claude.instanceId)).instanceId).toBe(codex.instanceId);
      expect((yield* advisor(codex.instanceId)).instanceId).toBe(claude.instanceId);
    }),
  );

  it.effect("ignores the caller's provider when the pool's switch is off", () =>
    Effect.gen(function* () {
      const base = snapshot();
      const off = {
        ...base,
        manifest: {
          ...base.manifest,
          pools: {
            ...base.manifest.pools,
            advisor: { ...base.manifest.pools.advisor, crossProvider: false },
          },
        },
      };
      const value = yield* resolve(
        input({
          snapshot: off,
          request: request({ role: "advisor" }),
          currentInstanceId: claude.instanceId,
        }),
      );
      expect(value.instanceId).toBe(claude.instanceId);
    }),
  );

  it.effect("keeps the caller's provider when no other provider is eligible", () =>
    Effect.gen(function* () {
      const value = yield* resolve(
        input({
          request: request({ role: "advisor" }),
          providers: [claude],
          currentInstanceId: claude.instanceId,
        }),
      );
      expect(value.instanceId).toBe(claude.instanceId);
    }),
  );

  it.effect("delegates to the member whose usage resets soonest", () =>
    Effect.gen(function* () {
      const usage = (usedPercent: number, resetsAt: string) => ({
        checkedAt: "2026-10-15T00:00:00.000Z",
        windows: [
          { id: "five_hour", kind: "session" as const, label: "Session", usedPercent, resetsAt },
        ],
      });
      const member = (id: string, usedPercent: number, resetsAt: string): ServerProvider => ({
        ...claude,
        instanceId: ProviderInstanceId.make(id),
        usageLimits: usage(usedPercent, resetsAt),
      });
      const caller = member("claude-caller", 100, "2026-10-15T01:00:00.000Z");
      const later = member("claude-later", 20, "2026-10-15T04:00:00.000Z");
      const sooner = member("claude-sooner", 60, "2026-10-15T02:00:00.000Z");
      const pool: ServerProvider = {
        ...claude,
        instanceId: ProviderInstanceId.make("claude-pool"),
        poolMembers: [caller.instanceId, later.instanceId, sooner.instanceId],
      };
      const base = input({
        request: request({
          role: "reviewer",
          sourceRevision: "reviewed-commit",
          review: changeReview,
        }),
        providers: [caller, later, sooner, pool],
        currentInstanceId: caller.instanceId,
      });
      expect((yield* resolve(base)).instanceId).toBe(sooner.instanceId);
    }),
  );
});
