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
  it.effect("preview reports the same decision and explains unavailable accounts", () =>
    Effect.gen(function* () {
      const resolver = yield* Resolver.AgentRoleResolver;
      const value = input({
        providers: [codex, { ...claude, auth: { ...claude.auth, status: "unauthenticated" } }],
      });
      const preview = yield* resolver.preview(value);
      expect(preview.selection).toEqual(yield* resolver.resolve(value));
      expect(preview.candidates).toContainEqual(
        expect.objectContaining({ alias: "sol", reason: "selected" }),
      );
      // Claude writers are refused before account availability is considered.
      expect(preview.candidates).toContainEqual(
        expect.objectContaining({ alias: "sonnet", reason: "trusted-claude-disabled" }),
      );
      const readOnly = yield* resolver.preview({ ...value, request: request({ readOnly: true }) });
      expect(readOnly.candidates).toContainEqual(
        expect.objectContaining({ alias: "sonnet", reason: "not-signed-in" }),
      );
    }),
  );
  it.effect("reviewer provider requirements fail closed while preferences remain soft", () =>
    Effect.gen(function* () {
      const resolver = yield* Resolver.AgentRoleResolver;
      const original = snapshot();
      const policy = {
        ...original,
        manifest: {
          ...original.manifest,
          reviewer: { prefer: ["sol", "sonnet"], requireDifferentProvider: true },
        },
      };
      const value = input({
        snapshot: policy,
        request: request({
          role: "reviewer",
          sourceRevision: "candidate",
          review: changeReview,
          authorModel: codexModel,
        }),
      });
      expect((yield* resolver.resolve(value)).model).toBe(claudeModel);
      const missing = yield* resolver.preview({ ...value, providers: [codex] });
      expect(missing.refusal).toBe("no-eligible-model");
      expect(missing.candidates).toContainEqual(
        expect.objectContaining({ alias: "sol", reason: "reviewer-requires-different-provider" }),
      );
      expect(
        (yield* resolver.preview({
          ...value,
          request: { ...value.request, authorModel: "unknown" },
        })).refusal,
      ).toBe("author-provider-required");
      const custom = {
        ...original,
        manifest: {
          ...original.manifest,
          pools: {
            ...original.manifest.pools,
            workhorse: { ...original.manifest.pools.workhorse, crossProvider: false },
          },
          reviewer: { prefer: ["sonnet", "sol"], requireDifferentProvider: false },
        },
      };
      expect(
        (yield* resolver.resolve(
          input({
            snapshot: custom,
            request: request({
              role: "reviewer",
              sourceRevision: "candidate",
              review: changeReview,
            }),
          }),
        )).model,
      ).toBe(claudeModel);
    }),
  );
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
              options,
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

  it.effect(
    "admits trusted Claude writers only with opt-in, full access and an explicit requirement",
    () =>
      Effect.gen(function* () {
        const resolver = yield* Resolver.AgentRoleResolver;
        const trusted = input({
          providers: [claude],
          allowTrustedClaudeWriters: true,
          request: request({ executionRequirement: "trusted-host-allowed" }),
        });
        const admitted = yield* resolver.preview(trusted);
        expect(admitted.selection?.model).toBe(claudeModel);
        expect(admitted.executionRequirement).toBe("trusted-host-allowed");
        expect(admitted.executionBoundary).toBe("trusted-host-access");
        for (const denied of [
          { ...trusted, allowTrustedClaudeWriters: false },
          { ...trusted, ceiling: "auto" as const },
          { ...trusted, ceiling: "auto-accept-edits" as const },
          { ...trusted, ceiling: "approval-required" as const },
          { ...trusted, request: request({ executionRequirement: "sandbox-required" }) },
          { ...trusted, request: request() },
        ]) {
          expect((yield* resolver.preview(denied)).selection).toBeNull();
        }
        const codexWriter = yield* resolver.preview({ ...trusted, providers: [codex] });
        expect(codexWriter.executionBoundary).toBe("workspace-sandbox");
        const reader = yield* resolver.preview({
          ...trusted,
          request: request({ readOnly: true, executionRequirement: "sandbox-required" }),
        });
        expect(reader.executionBoundary).toBe("read-only");
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

  it.effect("honours a caller's model within the role, over the default order", () =>
    Effect.gen(function* () {
      const advisor = (selection?: Input["selection"], extra: Partial<Input> = {}) =>
        input({
          request: request({ role: "advisor" }),
          ...(selection === undefined ? {} : { selection }),
          ...extra,
        });
      // The pool prefers fable; a named model replaces that order, with the role's own effort.
      expect(yield* resolve(advisor())).toMatchObject({ model: "claude-fable-test" });
      expect(yield* resolve(advisor({ model: "gpt-astra-test" }))).toEqual({
        instanceId: codex.instanceId,
        model: "gpt-astra-test",
        options: [{ id: "reasoning", value: "medium" }],
      });
      // The named account is honoured when it offers the model.
      expect(
        (yield* resolve(advisor({ model: "claude-fable-test", instanceId: claude.instanceId })))
          .instanceId,
      ).toBe(claude.instanceId);
      // A model outside the role's pool, or on an account that lacks it, is refused.
      expect((yield* refusal(advisor({ model: claudeModel }))).reason).toBe("selection-denied");
      expect(
        (yield* refusal(advisor({ model: "gpt-astra-test", instanceId: claude.instanceId })))
          .reason,
      ).toBe("selection-denied");
      // Effort stated by the caller must still be the role's own.
      expect(
        (yield* refusal(
          advisor({
            model: "gpt-astra-test",
            options: [{ id: "reasoning", value: "high" }],
          }),
        )).reason,
      ).toBe("unsupported-options");
    }),
  );

  it.effect(
    "honours an explicit author-model review while preferring another model by default",
    () =>
      Effect.gen(function* () {
        const resolver = yield* Resolver.AgentRoleResolver;
        const review = request({
          role: "reviewer",
          sourceRevision: "reviewed-commit",
          review: changeReview,
          authorModel: codexModel,
        });
        const explicit = input({ request: review, selection: { model: codexModel } });
        const preview = yield* resolver.preview(explicit);
        expect(preview.refusal).toBeNull();
        expect(preview.selection).toEqual(yield* resolve(explicit));
        expect(preview.selection).toEqual({
          instanceId: codex.instanceId,
          model: codexModel,
          options: [{ id: "reasoning", value: "medium" }],
        });
        expect((yield* resolve(input({ request: review }))).model).toBe(claudeModel);
        expect(
          (yield* resolve(input({ request: review, selection: { model: claudeModel } }))).model,
        ).toBe(claudeModel);
        // With nothing else eligible, the author's model serves, and that resolution revalidates.
        const authorOnly = input({ request: review, providers: [codex] });
        const automatic = yield* resolve(authorOnly);
        expect(automatic.model).toBe(codexModel);
        expect(yield* resolve({ ...authorOnly, selection: automatic })).toEqual(automatic);
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
