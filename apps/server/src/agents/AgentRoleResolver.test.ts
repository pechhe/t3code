import { expect, it } from "@effect/vitest";
import {
  ProviderDriverKind,
  type AgentPolicySnapshot,
  ProviderInstanceId,
  type ServerProvider,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as TestClock from "effect/testing/TestClock";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import { makeProviderRegistryMock } from "../provider/testUtils/providerRegistryMock.ts";
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
  it.effect("a reviewer prefers another provider than the author's, without refusing", () =>
    Effect.gen(function* () {
      const original = snapshot();
      const review = (preferOtherAuthorProvider: boolean, providers = [codex, claude]) =>
        resolve(
          input({
            snapshot: {
              ...original,
              manifest: {
                ...original.manifest,
                roles: {
                  ...original.manifest.roles,
                  "ticket-reviewer": {
                    ...original.manifest.roles["ticket-reviewer"],
                    preferOtherAuthorProvider,
                  },
                },
              },
            },
            providers,
            request: request({
              role: "ticket-reviewer",
              sourceRevision: "candidate",
              review: changeReview,
              authorModel: "claude-opus-test",
            }),
          }),
        );
      // The list puts Sonnet first; a Claude author moves Codex ahead of it.
      expect((yield* review(true)).model).toBe(codexModel);
      expect((yield* review(false)).model).toBe(claudeModel);
      // With only the author's provider available, it still reviews.
      expect((yield* review(true, [claude])).model).toBe(claudeModel);
    }),
  );
  it.effect("a model's policy options ride along when the account offers them", () =>
    Effect.gen(function* () {
      const original = snapshot();
      const withFast = {
        ...original,
        manifest: {
          ...original.manifest,
          models: {
            ...original.manifest.models,
            luna: { ...original.manifest.models.luna!, options: { serviceTier: "fast" } },
          },
        },
      };
      const offering = {
        ...codex,
        models: codex.models.map((model) => ({
          ...model,
          capabilities: {
            optionDescriptors: [
              ...(model.capabilities?.optionDescriptors ?? []),
              {
                id: "serviceTier",
                label: "Service Tier",
                type: "select" as const,
                options: [
                  { id: "default", label: "Standard" },
                  { id: "fast", label: "Fast" },
                ],
              },
            ],
          },
        })),
      };
      const chore = (providers: ReadonlyArray<ServerProvider>) =>
        resolve(
          input({
            snapshot: withFast,
            providers,
            request: request({ role: "chore-worker" }),
          }),
        );
      expect((yield* chore([offering])).options).toEqual([
        { id: "reasoning", value: "medium" },
        { id: "serviceTier", value: "fast" },
      ]);
      expect((yield* chore([codex])).options).toEqual([{ id: "reasoning", value: "medium" }]);
    }),
  );
  it.effect("runs any provider's model, passing effort only when the model has one", () =>
    Effect.gen(function* () {
      const original = snapshot();
      const [effortless, effortful] = ["deepseek-v4", "kimi-k2"];
      const pi: ServerProvider = {
        ...provider("pi", "pi-test", []),
        models: [
          {
            slug: effortless,
            name: "DeepSeek V4.1 Flash",
            isCustom: false,
            capabilities: { optionDescriptors: [] },
          },
          {
            slug: effortful,
            name: "Kimi K2",
            isCustom: false,
            capabilities: {
              optionDescriptors: [
                {
                  id: "thinking",
                  label: "Thinking",
                  type: "select" as const,
                  options: [
                    { id: "low", label: "Low" },
                    { id: "medium", label: "Medium" },
                  ],
                },
              ],
            },
          },
        ],
      };
      const policy: AgentPolicySnapshot = {
        ...original,
        manifest: {
          ...original.manifest,
          models: {
            ...original.manifest.models,
            deepseek: { driverKind: ProviderDriverKind.make("pi"), model: effortless },
            kimi: {
              driverKind: ProviderDriverKind.make("pi"),
              model: effortful,
              effortOption: "thinking",
            },
          },
          lists: {
            ...original.manifest.lists,
            workhorse: [{ model: "deepseek" }, { model: "kimi", effort: "medium" }],
          },
        },
      };
      const base = input({ snapshot: policy, providers: [pi] });
      expect(yield* resolve(base)).toEqual({
        instanceId: pi.instanceId,
        model: effortless,
      });
      const kimiOnly = { ...pi, models: pi.models.filter((model) => model.slug === effortful) };
      expect(yield* resolve({ ...base, providers: [kimiOnly] })).toEqual({
        instanceId: pi.instanceId,
        model: effortful,
        options: [{ id: "thinking", value: "medium" }],
      });
      // An effort the model does not offer is still refused.
      const tooHigh = {
        ...policy,
        manifest: {
          ...policy.manifest,
          lists: {
            ...policy.manifest.lists,
            workhorse: [{ model: "deepseek" }, { model: "kimi", effort: "high" }],
          },
        },
      };
      expect((yield* refusal({ ...base, snapshot: tooHigh, providers: [kimiOnly] })).reason).toBe(
        "no-eligible-model",
      );
      // A caller cannot attach an effort to a model that has none.
      expect(
        (yield* refusal({
          ...base,
          selection: {
            instanceId: pi.instanceId,
            model: effortless,
            options: [{ id: "thinking", value: "low" }],
          },
        })).reason,
      ).toBe("unsupported-options");
      // A read-only role may now run on a provider that does not enforce it natively.
      expect(
        (yield* resolve({
          ...base,
          request: request({
            role: "ticket-reviewer",
            sourceRevision: "reviewed-commit",
            review: changeReview,
            readOnly: true,
          }),
        })).model,
      ).toBe(effortless);
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

  it.effect("keeps roles inside their lists and rejects UI implementation classification", () =>
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

  it.effect("refuses a role the policy does not configure", () =>
    Effect.gen(function* () {
      for (const role of ["researcher", "scout"] as const)
        expect((yield* refusal(input({ request: request({ role }) }))).reason).toBe(
          "role-not-configured",
        );
    }),
  );

  it.effect("prefers an independent reviewer model over the author's current account", () =>
    Effect.gen(function* () {
      const value = yield* resolve(
        input({
          request: request({
            role: "ticket-reviewer",
            sourceRevision: "reviewed-commit",
            review: changeReview,
            authorModel: codexModel,
          }),
        }),
      );
      expect(value.model).toBe(claudeModel);
      expect(value.instanceId).toBe(claude.instanceId);
      expect(value.options).toEqual([{ id: "effort", value: "medium" }]);
    }),
  );

  it.effect("requires a pinned source revision for review", () =>
    Effect.gen(function* () {
      expect(
        (yield* refusal(input({ request: request({ role: "ticket-reviewer" }) }))).reason,
      ).toBe("source-pin-required");
    }),
  );

  it.effect("requires a typed review scope and coherent coverage for review", () =>
    Effect.gen(function* () {
      const reviewer = (review: Partial<typeof changeReview> | undefined, extra = {}) =>
        input({
          request: request({
            role: "ticket-reviewer",
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
      // A Spec review judges a specific Spec body revision, and only the Spec reviewer does.
      const spec = { scope: "spec", coverage: "partial" } as const;
      const specReviewer = { role: "spec-reviewer" } as const;
      expect((yield* refusal(reviewer(spec, specReviewer))).reason).toBe("review-scope-invalid");
      const pinned = { ...spec, specRef: "owner/repo#12", specRevision: "body-3" };
      yield* resolve(reviewer(pinned, specReviewer));
      expect((yield* refusal(reviewer(pinned))).reason).toBe("review-scope-invalid");
      expect((yield* refusal(reviewer({}, specReviewer))).reason).toBe("review-scope-invalid");
      // A Spec review of a no-Ticket Spec has no Ticket changes to list.
      yield* resolve(reviewer({ ...pinned, includedChanges: [] }, specReviewer));
      // A delta covers exactly the changes since the earlier report.
      const prior = { workId: "review-1", sourceRevision: "earlier-commit" };
      yield* resolve(reviewer({ priorReview: prior, baseRevision: "earlier-commit" }));
      const staleBase = yield* refusal(reviewer({ priorReview: prior }));
      expect(staleBase.reason).toBe("review-prior-invalid");
      expect(staleBase.detail).toContain("review.priorReview.sourceRevision (earlier-commit)");
      const nothingNew = yield* refusal(
        reviewer({
          priorReview: { ...prior, sourceRevision: "reviewed-commit" },
          baseRevision: "reviewed-commit",
        }),
      );
      expect(nothingNew.reason).toBe("review-prior-invalid");
      expect(nothingNew.detail).toContain("nothing new to review");
      // Each scope problem names its field and the scope or shape the role takes.
      expect((yield* refusal(reviewer(spec, specReviewer))).detail).toContain("review.specRef");
      expect((yield* refusal(reviewer({ includedChanges: [] }))).detail).toContain(
        "review.includedChanges",
      );
      const changeOnSpec = yield* refusal(
        reviewer({ scope: "change", includedChanges: ["c"] }, specReviewer),
      );
      expect(changeOnSpec.detail).toContain(
        'review.scope "change" is not valid for spec-reviewer; use "spec"',
      );
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
          role: "ticket-reviewer",
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
            role: "ticket-reviewer",
            sourceRevision: "reviewed-commit",
            review: changeReview,
          }),
          providers: [unavailable, claude],
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

  it.effect("lets a reviewer's listed model take UI and mixed work", () =>
    Effect.gen(function* () {
      const reviews = [
        { role: "ticket-reviewer", review: changeReview },
        {
          role: "spec-reviewer",
          review: {
            ...changeReview,
            scope: "spec",
            specRef: "owner/repo#12",
            specRevision: "body-3",
          },
        },
      ] as const;
      for (const { role, review } of reviews) {
        for (const taskClass of ["ui", "mixed"] as const) {
          const base = input({
            providers: [codex],
            request: request({ role, sourceRevision: "reviewed-commit", review, taskClass }),
          });
          expect((yield* resolve(base)).model).toBe(codexModel);
          expect(
            (yield* resolve({
              ...base,
              selection: {
                instanceId: codex.instanceId,
                model: codexModel,
                options: [{ id: "reasoning", value: "medium" }],
              },
            })).model,
          ).toBe(codexModel);
        }
      }
      // UI implementation still follows ui-worker's own list, which lists no Codex model.
      const uiWork = input({
        providers: [codex],
        request: request({ role: "ui-worker", taskClass: "ui" }),
      });
      expect((yield* refusal(uiWork)).reason).toBe("no-eligible-model");
      expect(
        (yield* refusal({
          ...uiWork,
          selection: {
            instanceId: codex.instanceId,
            model: codexModel,
            options: [{ id: "reasoning", value: "medium" }],
          },
        })).reason,
      ).toBe("selection-denied");
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

  it.effect(
    "admits a Phi role only once its route is checked, refusing each cause specifically",
    () =>
      Effect.gen(function* () {
        for (const role of ["browser", "ui-verifier"] as const) {
          const base = input({
            providers: [claude],
            request: request({ role, taskClass: "ui" }),
          });
          // Unchecked callers cannot start it, whatever the default or settings say.
          expect((yield* refusal(base)).reason).toBe("unsupported-tools");
          for (const reason of [
            "browser-access-off",
            "phi-disabled",
            "phi-skill-missing",
            "phi-unreachable",
          ] as const) {
            expect((yield* refusal({ ...base, browser: { refusal: reason } })).reason).toBe(reason);
          }
          const admitted = yield* resolve({ ...base, browser: { refusal: null } });
          expect(admitted.instanceId).toBe(claude.instanceId);
        }
      }),
  );

  it.effect("follows the list order whichever provider asks", () =>
    Effect.gen(function* () {
      for (const callerModel of [undefined, claudeModel, codexModel]) {
        const value = yield* resolve(
          input({
            request: request({ role: "advisor" }),
            ...(callerModel === undefined ? {} : { callerModel }),
          }),
        );
        expect(value.model).toBe("claude-fable-test");
      }
    }),
  );

  it.effect("starts with a caller's own first choice when the role names one", () =>
    Effect.gen(function* () {
      const original = snapshot();
      const policy: AgentPolicySnapshot = {
        ...original,
        manifest: {
          ...original.manifest,
          roles: {
            ...original.manifest.roles,
            advisor: { ...original.manifest.roles.advisor, callers: { sonnet: "astra" } },
          },
        },
      };
      const advisor = (callerModel: string, providers = [codex, claude]) =>
        resolve(
          input({
            snapshot: policy,
            request: request({ role: "advisor" }),
            callerModel,
            providers,
          }),
        );
      expect((yield* advisor(claudeModel)).model).toBe("gpt-astra-test");
      expect((yield* advisor("claude-opus-test")).model).toBe("claude-fable-test");
      // An unavailable first choice falls back to the list order.
      expect((yield* advisor(claudeModel, [claude])).model).toBe("claude-fable-test");
    }),
  );

  it.effect("starts a large task with the role's large-task model at its effort", () =>
    Effect.gen(function* () {
      const value = (demanding: boolean) =>
        resolve(input({ request: request({ demanding, readOnly: true }) }));
      // The list puts Sonnet first; large work goes to Sol at high effort.
      expect(yield* value(false)).toMatchObject({
        model: claudeModel,
        options: [{ id: "effort", value: "medium" }],
      });
      expect(yield* value(true)).toEqual({
        instanceId: codex.instanceId,
        model: codexModel,
        options: [{ id: "reasoning", value: "high" }],
      });
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
      // The list prefers fable; a named model replaces that order, with the role's own effort.
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
      // A model outside the role's list, or on an account that lacks it, is refused.
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
      // The refusal names the option and value and what the role would use instead.
      const unsupported = yield* refusal(
        advisor({
          model: "gpt-astra-test",
          options: [{ id: "reasoning", value: "high" }],
        }),
      );
      expect(unsupported.detail).toContain("option reasoning=high");
      expect(unsupported.detail).toContain("which is reasoning=medium");
      // Options stated without a model are checked against the role's own selection too.
      expect(
        (yield* refusal(advisor({ options: [{ id: "fastMode", value: false }] }))).detail,
      ).toContain("option fastMode=false");
      yield* resolve(advisor({ options: [{ id: "reasoning", value: "medium" }] }));
      // An account that is not available is named, not described as merely not eligible.
      const resolver = yield* Resolver.AgentRoleResolver;
      const previewed = yield* resolver.preview(
        advisor({ model: "gpt-astra-test", options: [{ id: "reasoning", value: "high" }] }),
      );
      expect(previewed.refusal).toContain("unsupported-options: option reasoning=high");
      const missing = yield* refusal(
        advisor({ model: "claude-fable-test", instanceId: ProviderInstanceId.make("gone") }),
      );
      expect(missing.detail).toContain("provider instance gone is not available to this project");
    }),
  );

  it.effect("drops an option the caller merely echoes from its own selection", () =>
    Effect.gen(function* () {
      const advisor = (extra: Partial<Input> = {}) =>
        input({ request: request({ role: "advisor" }), ...extra });
      const roleSelection = yield* resolve(advisor());
      expect(roleSelection).toEqual({
        instanceId: claude.instanceId,
        model: "claude-fable-test",
        options: [{ id: "effort", value: "medium" }],
      });
      // Echoing the caller's own fastMode=false changes nothing: the role does not set
      // that id, so the stated option is dropped rather than refused.
      expect(
        yield* resolve(
          advisor({
            caller: { ...roleSelection, options: [{ id: "fastMode", value: false }] },
            selection: { options: [{ id: "fastMode", value: false }] },
          }),
        ),
      ).toEqual(roleSelection);
      // Only the caller's own value is inherited; a different one is refused by name.
      const refused = yield* refusal(
        advisor({
          caller: { ...roleSelection, options: [{ id: "fastMode", value: true }] },
          selection: { options: [{ id: "fastMode", value: false }] },
        }),
      );
      expect(refused.reason).toBe("unsupported-options");
      expect(refused.detail).toContain("option fastMode=false");
      expect(refused.detail).toContain("advisor");
      expect(refused.detail).toContain("claude-fable-test");
      expect(refused.detail).toContain(claude.instanceId);
      // Inheritance is for the caller's own account and model only: the same value stated for
      // another model is a real choice the role cannot honour.
      const crossModel = yield* refusal(
        advisor({
          caller: { ...roleSelection, options: [{ id: "fastMode", value: false }] },
          selection: { model: "gpt-astra-test", options: [{ id: "fastMode", value: false }] },
        }),
      );
      expect(crossModel.detail).toContain("option fastMode=false");
      expect(crossModel.detail).toContain("gpt-astra-test");
      // Every unsupported option is named, not only the first.
      const several = yield* refusal(
        advisor({
          selection: {
            options: [
              { id: "fastMode", value: false },
              { id: "speed", value: "fast" },
            ],
          },
        }),
      );
      expect(several.detail).toContain("fastMode=false, speed=fast");
      // An id the role does set is never inherited, even at the caller's own value.
      const echoedEffort = yield* refusal(
        advisor({
          caller: { ...roleSelection, options: [{ id: "reasoning", value: "high" }] },
          selection: {
            model: "gpt-astra-test",
            options: [{ id: "reasoning", value: "high" }],
          },
        }),
      );
      expect(echoedEffort.reason).toBe("unsupported-options");
      expect(echoedEffort.detail).toContain("option reasoning=high");
      // An explicit empty list leaves the role's own options in place.
      expect(
        yield* resolve(
          advisor({
            caller: { ...roleSelection, options: [{ id: "fastMode", value: false }] },
            selection: { options: [] },
          }),
        ),
      ).toEqual(roleSelection);
    }),
  );

  it.effect(
    "honours an explicit author-model review while preferring another model by default",
    () =>
      Effect.gen(function* () {
        const resolver = yield* Resolver.AgentRoleResolver;
        const review = request({
          role: "ticket-reviewer",
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
          role: "ticket-reviewer",
          sourceRevision: "reviewed-commit",
          review: changeReview,
        }),
        providers: [caller, later, sooner, pool],
      });
      expect((yield* resolve(base)).instanceId).toBe(sooner.instanceId);
    }),
  );

  it.effect("re-reads a stale near-limit first choice before a task starts on it", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(Date.parse("2026-10-15T00:10:00.000Z"));
      const reading = (usedPercent: number, checkedAt: string) => ({
        ...claude,
        usageLimits: {
          checkedAt,
          windows: [
            {
              id: "five_hour",
              kind: "session" as const,
              label: "Session",
              usedPercent,
              resetsAt: "2026-10-15T03:00:00.000Z",
            },
          ],
        },
      });
      const stale = "2026-10-15T00:00:00.000Z";
      const review = request({
        role: "ticket-reviewer",
        sourceRevision: "reviewed-commit",
        review: changeReview,
      });
      const now = "2026-10-15T00:10:00.000Z";
      const spare = (usedPercent: number) => ({
        ...reading(usedPercent, now),
        instanceId: ProviderInstanceId.make("claude-spare"),
      });
      const choose = (cached: ServerProvider, others: ReadonlyArray<ServerProvider> = []) =>
        Effect.gen(function* () {
          const reads: Array<string> = [];
          const registry = {
            ...makeProviderRegistryMock(),
            refreshInstanceUsage: (instanceId: ProviderInstanceId) =>
              Effect.sync(() => {
                reads.push(instanceId);
                return [codex, reading(100, now), spare(100)];
              }),
          };
          const selection = yield* ProviderRegistry.chooseWithFreshUsage(
            registry,
            [codex, cached, ...others],
            (providers) => resolve(input({ request: review, providers })),
            (chosen) => chosen.instanceId,
          );
          return { model: selection.model, reads };
        });

      // Sonnet leads the list; the re-read shows its account is out, so Codex serves.
      expect(yield* choose(reading(96, stale))).toEqual({
        model: codexModel,
        reads: [claude.instanceId],
      });
      // The registry's newer readings of the other accounts count too: the spare ran out
      // meanwhile, so the work moves past it.
      expect(yield* choose(reading(96, stale), [spare(50)])).toEqual({
        model: codexModel,
        reads: [claude.instanceId],
      });
      // Below the threshold, or freshly read, the cached reading is trusted.
      expect(yield* choose(reading(90, stale))).toEqual({ model: claudeModel, reads: [] });
      expect(yield* choose(reading(96, "2026-10-15T00:09:30.000Z"))).toEqual({
        model: claudeModel,
        reads: [],
      });
    }),
  );

  it.effect("delegates past accounts out of usage to the next model with allowance", () =>
    Effect.gen(function* () {
      const resolver = yield* Resolver.AgentRoleResolver;
      const limit = (account: ServerProvider, resetsAt: string, id = account.instanceId) => ({
        ...account,
        instanceId: id,
        usageLimits: {
          checkedAt: "2026-10-15T00:00:00.000Z",
          windows: [
            { id: "seven_day", kind: "weekly" as const, label: "Week", usedPercent: 100, resetsAt },
          ],
        },
      });
      const review = (authorModel?: string) =>
        request({
          role: "ticket-reviewer",
          sourceRevision: "reviewed-commit",
          review: changeReview,
          ...(authorModel === undefined ? {} : { authorModel }),
        });
      const claudeOut = limit(claude, "2026-10-15T03:00:00.000Z");
      const codexOut = limit(codex, "2026-10-15T02:00:00.000Z");

      // Sonnet leads the list, but its only account is out, so Codex serves.
      const skipped = yield* resolver.preview(
        input({ request: review(), providers: [codex, claudeOut] }),
      );
      expect(skipped.selection?.model).toBe(codexModel);
      expect(skipped.candidates).toContainEqual(
        expect.objectContaining({ alias: "sonnet", reason: "usage-limited" }),
      );

      // Another account with allowance keeps the preferred model.
      const spare = { ...claude, instanceId: ProviderInstanceId.make("claude-spare") };
      const kept = yield* resolve(
        input({ request: review(), providers: [codex, claudeOut, spare] }),
      );
      expect(kept).toMatchObject({ model: claudeModel, instanceId: spare.instanceId });

      // With every account out, the one resetting soonest serves rather than refusing.
      const allOut = yield* resolver.preview(
        input({ request: review(), providers: [codexOut, claudeOut] }),
      );
      expect(allOut.refusal).toBeNull();
      expect(allOut.selection?.model).toBe(codexModel);
      expect(allOut.candidates).toContainEqual(
        expect.objectContaining({ alias: "sol", reason: "selected" }),
      );
      expect(allOut.candidates).toContainEqual(
        expect.objectContaining({ alias: "sonnet", reason: "usage-limited" }),
      );

      // Allowance outranks a reviewer's preference against the author's model.
      const authorOnly = yield* resolve(
        input({ request: review(claudeModel), providers: [codexOut, claude] }),
      );
      expect(authorOnly.model).toBe(claudeModel);

      // An explicit choice takes an account of that model with allowance when it has one.
      const chosen = yield* resolve(
        input({
          request: review(),
          providers: [codex, claudeOut, spare],
          selection: { model: claudeModel },
        }),
      );
      expect(chosen.instanceId).toBe(spare.instanceId);
    }),
  );
});
