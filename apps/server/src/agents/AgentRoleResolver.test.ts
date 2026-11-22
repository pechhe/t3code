import { evaluateConservation } from "../provider/subagentConservation.ts";
import { expect, it } from "@effect/vitest";
import {
  ProviderDriverKind,
  type AgentPolicySnapshot,
  ProviderInstanceId,
  type ServerProvider,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Resolver from "./AgentRoleResolver.ts";
import { providerOverloadKey } from "../provider/ProviderOverloads.ts";
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
  it.effect("an unsupported OpenCode binding leaves every catalog model eligible", () =>
    Effect.gen(function* () {
      const models = ["opencode-go/workspace-only", "opencode/console", "anthropic/claude"];
      const account = {
        ...provider("opencode", "scoped-go", models),
        conservationScope: {
          providerIds: [],
          reason: "The serving credential cannot be verified.",
        },
      };
      const status = evaluateConservation(
        account,
        { enabled: true, remainingPercent: 20, window: "any", windowIds: ["go_weekly"], models },
        0,
      ).status;
      const original = snapshot();
      const configured = {
        ...original,
        manifest: {
          ...original.manifest,
          models: {
            ...original.manifest.models,
            ...Object.fromEntries(
              ["sol", "sonnet", "luna"].map((alias, index) => [
                alias,
                {
                  driverKind: ProviderDriverKind.make("opencode"),
                  model: models[index]!,
                  effortOption: "effort",
                },
              ]),
            ),
          },
          lists: {
            ...original.manifest.lists,
            workhorse: ["sol", "sonnet", "luna"].map((model) => ({ model, effort: "medium" })),
          },
        },
      };
      const value = input({
        snapshot: configured,
        providers: [{ ...account, subagentConservation: status }],
      });
      for (const model of models)
        expect(
          (yield* resolve({ ...value, selection: { instanceId: account.instanceId, model } }))
            .model,
        ).toBe(model);
    }),
  );

  it.effect(
    "conservation filters discovery and explicit starts while retaining existing conversations",
    () =>
      Effect.gen(function* () {
        const resolver = yield* Resolver.AgentRoleResolver;
        for (const state of ["active", "unknown"] as const) {
          const limited = {
            ...codex,
            subagentConservation: {
              state,
              unavailable: state === "unknown",
              models: [codexModel],
              message: "Selected model conserved",
            },
          };
          const value = input({
            providers: [limited, claude],
            selection: { instanceId: codex.instanceId, model: codexModel },
          });
          const preview = yield* resolver.preview(value);
          expect(preview.selection).toBeNull();
          expect(preview.refusal).toContain("conservation");
          expect((yield* refusal(value)).reason).toBe("conservation");
          expect((yield* resolve({ ...value, ignoreConservation: true })).model).toBe(codexModel);
          expect(
            (yield* resolve({
              ...value,
              providers: [
                {
                  ...limited,
                  subagentConservation: { ...limited.subagentConservation, state: "ready" },
                },
                claude,
              ],
            })).model,
          ).toBe(codexModel);
          expect(
            (yield* resolve({
              ...value,
              providers: [
                {
                  ...limited,
                  subagentConservation: {
                    ...limited.subagentConservation,
                    models: ["another-model"],
                  },
                },
                claude,
              ],
            })).model,
          ).toBe(codexModel);
        }
      }),
  );
  it.effect("lets change and Spec reviews each run on any model of the one reviewer list", () =>
    Effect.gen(function* () {
      const original = snapshot();
      const policy = {
        ...original,
        manifest: {
          ...original.manifest,
          lists: {
            ...original.manifest.lists,
            reviewers: [
              { model: "astra", effort: "high" },
              { model: "sonnet", effort: "high" },
            ],
          },
          roles: {
            ...original.manifest.roles,
            reviewer: { ...original.manifest.roles.reviewer, list: "reviewers" },
          },
        },
      };
      for (const scope of ["change", "spec"] as const) {
        const value = input({
          snapshot: policy,
          request: request({
            role: "reviewer",
            sourceRevision: "candidate",
            review: { ...changeReview, scope, specRef: "spec", specRevision: "revision" },
          }),
        });
        for (const model of ["gpt-astra-test", claudeModel])
          expect((yield* resolve({ ...value, selection: { model } })).model).toBe(model);
      }
    }),
  );
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
  it.effect("read-only dispatch skips providers without enforcement and explains refusals", () =>
    Effect.gen(function* () {
      const resolver = yield* Resolver.AgentRoleResolver;
      const unenforced = { ...claude, readOnlySourceAccess: undefined };
      const reader = request({
        role: "reviewer",
        sourceRevision: "candidate",
        review: changeReview,
      });
      const base = input({ providers: [unenforced, codex], request: reader });
      const preview = yield* resolver.preview(base);
      expect(preview.selection?.instanceId).toBe(codex.instanceId);
      expect(preview.candidates).toContainEqual(
        expect.objectContaining({
          alias: "sonnet",
          providerInstanceId: claude.instanceId,
          reason: "read-only-unenforced",
        }),
      );
      for (const value of [
        { ...base, providers: [unenforced] },
        { ...base, selection: { model: claudeModel } },
        {
          ...base,
          providers: [{ ...codex, readOnlySourceAccess: undefined }],
          request: request({ readOnly: true }),
        },
      ]) {
        const error = yield* refusal(value);
        expect(error.candidates).toContainEqual(
          expect.objectContaining({ reason: "read-only-unenforced" }),
        );
        expect(error.message).toContain("read-only-unenforced");
      }
      expect(
        (yield* resolve(input({ providers: [{ ...codex, readOnlySourceAccess: undefined }] })))
          .instanceId,
      ).toBe(codex.instanceId);
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
                  reviewer: {
                    ...original.manifest.roles["reviewer"],
                    preferOtherAuthorProvider,
                  },
                },
              },
            },
            providers,
            request: request({
              role: "reviewer",
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
            sol: { ...original.manifest.models.sol!, options: { serviceTier: "fast" } },
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
            request: request({ role: "implementer" }),
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
        pinned: true,
      });
      const kimiOnly = { ...pi, models: pi.models.filter((model) => model.slug === effortful) };
      expect(yield* resolve({ ...base, providers: [kimiOnly] })).toEqual({
        instanceId: pi.instanceId,
        model: effortful,
        pinned: true,
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
            role: "reviewer",
            sourceRevision: "reviewed-commit",
            review: changeReview,
            readOnly: true,
          }),
        })).model,
      ).toBe(effortless);
    }),
  );

  it.effect("selects a workhorse at its list effort", () =>
    Effect.gen(function* () {
      expect(yield* resolve(input())).toEqual({
        instanceId: codex.instanceId,
        model: codexModel,
        pinned: true,
        options: [{ id: "reasoning", value: "medium" }],
      });
      const lowOnly = provider("codex", "codex-low", [codexModel], ["low"]);
      expect((yield* refusal(input({ providers: [lowOnly] }))).reason).toBe("no-eligible-model");
    }),
  );

  it.effect("runs a trial's assigned model and effort, even off the role's own list", () =>
    Effect.gen(function* () {
      const treatment = {
        instanceId: codex.instanceId,
        model: "gpt-astra-test",
        options: [{ id: "reasoning", value: "high" }],
      };
      const assigned = input({
        selection: treatment,
        treatment,
      });
      expect(yield* resolve(assigned)).toEqual({
        instanceId: codex.instanceId,
        model: "gpt-astra-test",
        pinned: true,
        options: [{ id: "reasoning", value: "high" }],
      });
      // Every account and capability check still applies to the assigned treatment.
      expect(
        (yield* refusal({
          ...assigned,
          providers: [provider("codex", "codex-test", [codexModel, "gpt-astra-test"], ["medium"])],
        })).reason,
      ).toBe("selection-denied");
      const unknown = { ...treatment, model: "not-in-policy" };
      expect((yield* refusal({ ...assigned, selection: unknown, treatment: unknown })).reason).toBe(
        "selection-denied",
      );
    }),
  );

  it.effect("keeps roles inside their lists and task classes", () =>
    Effect.gen(function* () {
      expect(
        (yield* refusal(
          input({ providers: [provider("codex", "advisor-only", ["gpt-astra-test"])] }),
        )).reason,
      ).toBe("no-eligible-model");
      // The policy's fixture browser role takes only UI work.
      expect(
        (yield* refusal(input({ request: request({ role: "browser", taskClass: "non-ui" }) })))
          .reason,
      ).toBe("classification");
    }),
  );

  it.effect("refuses a role the policy does not configure", () =>
    Effect.gen(function* () {
      for (const role of ["scout"] as const)
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
            role: "reviewer",
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
      const specReviewer = { role: "reviewer" } as const;
      expect((yield* refusal(reviewer(spec, specReviewer))).reason).toBe("review-scope-invalid");
      const pinned = { ...spec, specRef: "owner/repo#12", specRevision: "body-3" };
      yield* resolve(reviewer(pinned, specReviewer));
      yield* resolve(reviewer(pinned));
      yield* resolve(reviewer({}, specReviewer));
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
      // Recording the earlier report's change against another base (its published commit)
      // names that report's own base; the server proves the diffs equal.
      yield* resolve(
        reviewer({
          priorReview: { ...prior, baseRevision: "earlier-base" },
          baseRevision: "published-parent",
        }),
      );
      // Each scope problem names its field and the scope or shape the role takes.
      expect((yield* refusal(reviewer(spec, specReviewer))).detail).toContain("review.specRef");
      expect((yield* refusal(reviewer({ includedChanges: [] }))).detail).toContain(
        "review.includedChanges",
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
        pinned: true,
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

  it.effect("lets a reviewer's or implementer's listed model take UI and mixed work", () =>
    Effect.gen(function* () {
      const reviews = [
        { role: "reviewer", review: changeReview },
        {
          role: "reviewer",
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
      // No model is held back from UI work: the implementer runs it on any model its list names.
      for (const taskClass of ["ui", "mixed"] as const) {
        const uiWork = input({ providers: [codex], request: request({ taskClass }) });
        expect((yield* resolve(uiWork)).model).toBe(codexModel);
        expect(
          (yield* resolve({
            ...uiWork,
            selection: {
              instanceId: codex.instanceId,
              model: codexModel,
              options: [{ id: "reasoning", value: "medium" }],
            },
          })).model,
        ).toBe(codexModel);
      }
    }),
  );

  it.effect("admits a Spec lead wherever a top-level thread could run, never narrower", () =>
    Effect.gen(function* () {
      const lead = request({ role: "lead" });
      // Supervised, and Claude without the leaf-writer opt-in, both stay open to a lead.
      expect(
        (yield* resolve(
          input({ providers: [claude], ceiling: "approval-required", request: lead }),
        )).model,
      ).toBe(claudeModel);
      expect((yield* resolve(input({ providers: [claude], request: lead }))).model).toBe(
        claudeModel,
      );
      for (const narrower of [
        request({ role: "lead", readOnly: true }),
        request({ role: "lead", executionRequirement: "sandbox-required" }),
      ])
        expect((yield* refusal(input({ request: narrower }))).reason).toBe(
          "unsupported-permissions",
        );
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
    "admits trusted Claude writers with opt-in and full access, and only behind an explicit sandbox otherwise",
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
        // A writer request no longer has to ask for host access; that is the default.
        const byDefault = yield* resolver.preview({ ...trusted, request: request() });
        expect(byDefault.selection?.model).toBe(claudeModel);
        expect(byDefault.executionBoundary).toBe("trusted-host-access");
        for (const denied of [
          { ...trusted, allowTrustedClaudeWriters: false },
          { ...trusted, ceiling: "auto" as const },
          { ...trusted, ceiling: "auto-accept-edits" as const },
          { ...trusted, ceiling: "approval-required" as const },
          { ...trusted, request: request({ executionRequirement: "sandbox-required" }) },
        ]) {
          expect((yield* resolver.preview(denied)).selection).toBeNull();
        }
        const codexWriter = yield* resolver.preview({ ...trusted, providers: [codex] });
        expect(codexWriter.executionBoundary).toBe("trusted-host-access");
        const sandboxedWriter = yield* resolver.preview({
          ...trusted,
          providers: [codex],
          request: request({ executionRequirement: "sandbox-required" }),
        });
        expect(sandboxedWriter.executionBoundary).toBe("workspace-sandbox");
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

  it.effect("starts a UI implementer with no browser route and refuses a browser selection", () =>
    Effect.gen(function* () {
      const base = input({
        providers: [claude],
        allowTrustedClaudeWriters: true,
        request: request({ taskClass: "ui" }),
      });
      expect((yield* resolve(base)).instanceId).toBe(claude.instanceId);
      for (const backend of ["integrated", "phi"] as const) {
        const refused = yield* refusal({
          ...base,
          request: { ...base.request, browser: { backend } },
        });
        expect(refused.reason).toBe("unsupported-options");
        expect(refused.detail).toContain("t3_browser_*");
      }
    }),
  );

  it.effect("refuses a role the policy does not configure, naming it", () =>
    Effect.gen(function* () {
      const policy = snapshot();
      const { "ui-verifier": _retired, ...roles } = policy.manifest.roles;
      const refused = yield* refusal(
        input({
          snapshot: { ...policy, manifest: { ...policy.manifest, roles } },
          request: request({ role: "ui-verifier", taskClass: "ui", readOnly: true }),
          browser: { refusal: null },
        }),
      );
      expect(refused.reason).toBe("role-not-configured");
      expect(refused.message).toContain("the agent policy does not configure ui-verifier");
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

  it.effect("runs a named listed model, and the first listed one when none is named", () =>
    Effect.gen(function* () {
      const value = (selection?: Input["selection"]) =>
        resolve(
          input({
            request: request({ readOnly: true }),
            ...(selection === undefined ? {} : { selection }),
          }),
        );
      // The policy still names Sol as the retired large-task model; it changes nothing.
      expect(yield* value()).toMatchObject({
        model: claudeModel,
        options: [{ id: "effort", value: "medium" }],
      });
      expect(yield* value({ model: codexModel })).toEqual({
        instanceId: codex.instanceId,
        model: codexModel,
        pinned: true,
        options: [{ id: "reasoning", value: "medium" }],
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
        pinned: true,
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
        pinned: true,
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
          pinned: true,
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

  it.effect(
    "requires a caller choice for multi-model roles regardless of list order or outages",
    () =>
      Effect.gen(function* () {
        const resolver = yield* Resolver.AgentRoleResolver;
        const original = snapshot();
        const build = (
          models: string[],
          providers: ReadonlyArray<ServerProvider> = [codex, claude],
        ) =>
          input({
            requireExplicitSelection: true,
            snapshot: {
              ...original,
              manifest: {
                ...original.manifest,
                lists: {
                  ...original.manifest.lists,
                  workhorse: models.map((model) => ({ model, effort: "medium" })),
                },
              },
            },
            providers,
          });
        const omitted = yield* resolver.preview(build(["sonnet", "sol"]));
        const permuted = yield* resolver.preview(build(["sol", "sonnet"]));
        expect(omitted.selection).toBeNull();
        expect(omitted.refusal).toContain("choose a model");
        expect(omitted.candidates.map(({ model }) => model).sort()).toEqual(
          permuted.candidates.map(({ model }) => model).sort(),
        );
        const offline = yield* refusal(
          build(["sonnet", "sol"], [{ ...codex, availability: "unavailable" }, claude]),
        );
        expect(offline.detail).toContain("choose a model");
        expect(
          (yield* resolver.resolve({
            ...build(["sonnet", "sol"]),
            selection: { model: codexModel },
          })).model,
        ).toBe(codexModel);
      }),
  );

  it.effect("counts one configured model once across aliases and accounts", () =>
    Effect.gen(function* () {
      const original = snapshot();
      const policy = {
        ...original,
        manifest: {
          ...original.manifest,
          models: { ...original.manifest.models, solCopy: original.manifest.models.sol! },
          lists: {
            ...original.manifest.lists,
            workhorse: [
              { model: "sol", effort: "medium" },
              { model: "solCopy", effort: "medium" },
            ],
          },
        },
      };
      const other = { ...codex, instanceId: ProviderInstanceId.make("codex-copy") };
      const result = yield* resolve(
        input({ snapshot: policy, providers: [codex, other], requireExplicitSelection: true }),
      );
      expect(result.model).toBe(codexModel);
    }),
  );

  it.effect("passes over a skipped account until its skip ends, but runs it when named", () =>
    Effect.gen(function* () {
      const nowMs = DateTime.toEpochMillis(yield* DateTime.now);
      const review = request({
        role: "reviewer",
        sourceRevision: "reviewed-commit",
        review: changeReview,
      });
      const skipped = (untilMs: number) => ({
        pooledModelKeys: [claudeModel],
        accountSkips: {
          [claude.instanceId]: {
            [claudeModel]: {
              until: DateTime.formatIso(DateTime.makeUnsafe(untilMs)),
              reportedReset: true,
            },
          },
        },
      });

      // Sonnet leads the list; while its account is skipped the next entry serves.
      const passedOver = yield* resolve(
        input({ request: review, routing: skipped(nowMs + 60_000) }),
      );
      expect(passedOver.model).toBe(codexModel);

      // Once the skip has ended, the list's first choice serves again.
      const returned = yield* resolve(input({ request: review, routing: skipped(nowMs) }));
      expect(returned.model).toBe(claudeModel);

      // A named account is tried while skipped, and pinned there rather than swapped.
      const named = yield* resolve(
        input({
          request: review,
          selection: { instanceId: claude.instanceId },
          routing: skipped(nowMs + 60_000),
        }),
      );
      expect(named).toMatchObject({
        instanceId: claude.instanceId,
        model: claudeModel,
        pinned: true,
      });
    }),
  );

  it.effect(
    "reports each account of a pooled model with its own skip and dispatches a free one",
    () =>
      Effect.gen(function* () {
        const resolver = yield* Resolver.AgentRoleResolver;
        const nowMs = DateTime.toEpochMillis(yield* DateTime.now);
        const original = snapshot();
        const models = ["acct-a/claude-opus-5-5", "acct-b/claude-opus-5-5"];
        const pi: ServerProvider = {
          ...provider("pi", "pi-test", models),
          models: models.map((slug) => ({
            slug,
            name: "Claude Opus 5.5",
            isCustom: false,
            capabilities: { optionDescriptors: [] },
          })),
        };
        const policy: AgentPolicySnapshot = {
          ...original,
          manifest: {
            ...original.manifest,
            models: {
              ...original.manifest.models,
              opus: {
                driverKind: ProviderDriverKind.make("pi"),
                model: "acct-a/claude-opus-5-5",
                anyAccount: true,
              },
            },
            lists: { ...original.manifest.lists, workhorse: [{ model: "opus" }] },
          },
        };
        const preview = yield* resolver.preview(
          input({
            snapshot: policy,
            providers: [pi],
            request: request({ role: "implementer" }),
            routing: {
              pooledModelKeys: ["claude-opus-5-5"],
              accountSkips: {
                "pi-test:acct-a": {
                  "claude-opus-5-5": {
                    until: DateTime.formatIso(DateTime.makeUnsafe(nowMs + 60_000)),
                    reportedReset: true,
                  },
                },
              },
            },
          }),
        );
        // The free second account serves, and only the skipped first is reported usage-limited.
        expect(preview.selection?.model).toBe("acct-b/claude-opus-5-5");
        expect(
          Object.fromEntries(preview.candidates.map(({ model, reason }) => [model, reason])),
        ).toEqual({
          "acct-a/claude-opus-5-5": "usage-limited",
          "acct-b/claude-opus-5-5": "selected",
        });
      }),
  );

  it.effect("moves past an overloaded model until its cool-down ends", () =>
    Effect.gen(function* () {
      const resolver = yield* Resolver.AgentRoleResolver;
      const nowMs = DateTime.toEpochMillis(yield* DateTime.now);
      const review = request({
        role: "reviewer",
        sourceRevision: "reviewed-commit",
        review: changeReview,
      });
      const overloaded = (
        entries: ReadonlyArray<readonly [ServerProvider, string, number]>,
      ): ReadonlyMap<string, number> =>
        new Map(
          entries.map(([account, model, until]) => [
            providerOverloadKey(account.instanceId, model),
            until,
          ]),
        );

      // Sonnet leads the list; while it is overloaded the next entry serves, and discovery
      // says why and until when.
      const passedOver = yield* resolver.preview(
        input({
          request: review,
          overloads: overloaded([[claude, claudeModel, nowMs + 60_000]]),
        }),
      );
      expect(passedOver.selection?.model).toBe(codexModel);
      expect(passedOver.candidates).toContainEqual(
        expect.objectContaining({
          alias: "sonnet",
          reason: "overloaded",
          until: DateTime.formatIso(DateTime.makeUnsafe(nowMs + 60_000)),
        }),
      );

      // Overload belongs to one model: another model on the same account does not demote it.
      const otherModel = yield* resolve(
        input({
          request: review,
          overloads: overloaded([[claude, "another-model", nowMs + 60_000]]),
        }),
      );
      expect(otherModel.model).toBe(claudeModel);

      // Once the cool-down has ended, the list's first choice serves again.
      const recovered = yield* resolve(
        input({ request: review, overloads: overloaded([[claude, claudeModel, nowMs]]) }),
      );
      expect(recovered.model).toBe(claudeModel);

      // Among overloaded models the one whose cool-down ends first serves.
      const bothOverloaded = yield* resolve(
        input({
          request: review,
          overloads: overloaded([
            [claude, claudeModel, nowMs + 120_000],
            [codex, codexModel, nowMs + 60_000],
          ]),
        }),
      );
      expect(bothOverloaded.model).toBe(codexModel);
    }),
  );
});
