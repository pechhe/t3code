import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { McpServer, Tool, Toolkit } from "effect/ai";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { AgentPolicyManifest, OrchestratorMcpFailure } from "@t3tools/contracts";

import * as AgentPolicy from "../agents/AgentPolicyService.ts";
import { snapshot } from "../agents/agentPolicy.testkit.ts";
import * as HiddenTools from "./HiddenTools.ts";
import * as McpHttpServer from "./McpHttpServer.ts";
import * as McpToolAccess from "./McpToolAccess.ts";

const encodeManifest = Schema.encodeSync(AgentPolicyManifest);
const hidden = ["*pull_request*", "t3_work_*", "create_threads"];

/** A policy root holding `manifest`, with every brief the roles name. */
const policyRoot = (drop: (manifest: Record<string, unknown>) => Record<string, unknown>) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const root = yield* fs.makeTempDirectoryScoped({ prefix: "hidden-tools-test-" });
    const written = encodeManifest(snapshot().manifest) as Record<string, unknown> & {
      readonly roles: Record<string, { readonly brief: string }>;
    };
    yield* fs.makeDirectory(`${root}/roles`);
    yield* fs.writeFileString(
      `${root}/roles/policy.json`,
      JSON.stringify(drop({ ...written, hiddenTools: hidden })),
    );
    for (const role of Object.values(written.roles))
      yield* fs.writeFileString(`${root}/${role.brief}`, "Brief\n");
    return root;
  });

const readHiddenTools = (root: string | undefined) =>
  HiddenTools.HiddenTools.pipe(
    Effect.provide(HiddenTools.layerHiddenTools.pipe(Layer.provide(AgentPolicy.layer))),
    // An empty root is an environment that reads no policy at all.
    Effect.provideService(HostProcess.Environment, {
      ...process.env,
      T3CODE_AGENT_POLICY_ROOT: root ?? "",
    }),
  );

const nodeLayers = Layer.mergeAll(NodeServices.layer, NodeCrypto.layer);

it.effect("reads the hidden tools the owner's role policy lists", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const root = yield* policyRoot((manifest) => manifest);
      expect(yield* readHiddenTools(root)).toEqual(hidden);
      // Absent or empty hides nothing, and removing an entry needs no T3 change.
      const empty = yield* policyRoot((manifest) => ({ ...manifest, hiddenTools: [] }));
      expect(yield* readHiddenTools(empty)).toEqual([]);
      const absent = yield* policyRoot(({ hiddenTools: _hidden, ...manifest }) => manifest);
      expect(yield* readHiddenTools(absent)).toEqual([]);
    }),
  ).pipe(Effect.provide(nodeLayers)),
);

it.effect("hides nothing when the environment reads no readable policy", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const broken = yield* fs.makeTempDirectoryScoped({ prefix: "hidden-tools-broken-" });
      yield* fs.makeDirectory(`${broken}/roles`);
      yield* fs.writeFileString(`${broken}/roles/policy.json`, "{ not a policy");
      expect(yield* readHiddenTools(undefined)).toEqual([]);
      expect(yield* readHiddenTools(broken)).toEqual([]);
    }),
  ).pipe(Effect.provide(nodeLayers)),
);

it.effect("leaves the policy's hidden tools out of the catalogue a thread reads", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const root = yield* policyRoot((manifest) => manifest);
      const tool = (name: string) =>
        Tool.make(name, {
          description: name,
          success: Schema.Struct({}),
          failure: OrchestratorMcpFailure,
          failureMode: "return",
        });
      const Demo = Toolkit.make(
        tool("link_pull_request"),
        tool("t3_work_enroll"),
        tool("create_threads"),
        tool("t3_thread_list"),
      );
      const reads = McpToolAccess.reads(() => Effect.succeed({}));
      const names = yield* Effect.gen(function* () {
        const server = yield* McpServer.McpServer;
        return server.tools.map(({ tool: listed }) => listed.name).toSorted();
      }).pipe(
        Effect.provide(
          McpHttpServer.toolkitRegistration(
            Demo,
            McpToolAccess.toLayer(Demo, {
              link_pull_request: reads,
              t3_work_enroll: reads,
              create_threads: reads,
              t3_thread_list: reads,
            }),
          ).pipe(
            Layer.provideMerge(McpHttpServer.layerInProcessMcpServer),
            Layer.provide(HiddenTools.layerHiddenTools),
            Layer.provide(AgentPolicy.layer),
            Layer.provide(
              Layer.succeed(HostProcess.Environment, {
                ...process.env,
                T3CODE_AGENT_POLICY_ROOT: root,
              }),
            ),
          ),
        ),
      );
      expect(names).toEqual(["t3_thread_list"]);
    }),
  ).pipe(Effect.provide(nodeLayers)),
);
