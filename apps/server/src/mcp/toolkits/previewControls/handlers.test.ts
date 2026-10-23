import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import {
  type AgentRole,
  type AgentTaskBinding,
  type AgentToolProfile,
  DEFAULT_SERVER_SETTINGS,
  EnvironmentId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import { resolveProjectSettings } from "@t3tools/shared/projectSettings";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";

import {
  request as agentTaskRequest,
  snapshot as agentPolicySnapshot,
} from "../../../agents/agentPolicy.testkit.ts";
import * as ServerConfig from "../../../config.ts";
import * as ThreadManagement from "../../../orchestration-v2/ThreadManagementService.ts";
import * as Preview from "../../../preview/Manager.ts";
import * as ServerSettings from "../../../serverSettings.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import * as McpToolAccessTestkit from "../../McpToolAccess.testkit.ts";
import * as PreviewAutomationBroker from "../../PreviewAutomationBroker.ts";
import * as PreviewControlsHandlers from "./handlers.ts";
import { PreviewControlsToolkit } from "./tools.ts";

const projectId = ProjectId.make("preview-controls-project");
const threadId = ThreadId.make("preview-controls-thread");

const settingsWith = (globalAccess: boolean, projectAccess: boolean) => ({
  ...DEFAULT_SERVER_SETTINGS,
  enableAgentBrowserAccess: globalAccess,
  projectSettingsOverrides: {
    [projectId]: { enableAgentBrowserAccess: projectAccess },
  },
});

interface ControlsFixture {
  readonly settings: ReturnType<typeof settingsWith>;
  readonly threadId: ThreadId;
  readonly threads: Layer.Layer<ThreadManagement.ThreadManagementService>;
  readonly toolProfile?: AgentToolProfile;
  readonly agentRole?: AgentRole;
  /** Whether the credential was issued while browser access was on, whatever the settings say now. */
  readonly browserCapability?: boolean;
}

/** Lists and closes through the toolkit's own handlers, as the `/mcp/preview` endpoint serves them. */
const runControls = ({
  settings,
  threadId,
  threads,
  toolProfile,
  agentRole,
  browserCapability,
}: ControlsFixture) =>
  Effect.scoped(
    Effect.gen(function* () {
      const effective = resolveProjectSettings(settings, projectId).settings;
      const scope: McpInvocationContext.McpInvocationScope = {
        environmentId: EnvironmentId.make("preview-controls-environment"),
        requestNamespace: "preview-controls-provider-session",
        thread: {
          threadId,
          providerSessionId: "preview-controls-provider-session",
          providerInstanceId: ProviderInstanceId.make("codex"),
        },
        client: undefined,
        capabilities: new Set(
          (browserCapability ?? effective.enableAgentBrowserAccess) ? ["preview"] : [],
        ),
        issuedAt: 0,
        ...(toolProfile === undefined ? {} : { toolProfile }),
        ...(agentRole === undefined ? {} : { agentRole }),
      };
      const manager = yield* Preview.make.pipe(
        Effect.provide(
          Layer.merge(
            ServerConfig.layerTest(process.cwd(), { prefix: "t3-preview-controls-" }).pipe(
              Layer.provide(NodeServices.layer),
            ),
            NodeCrypto.layer,
          ),
        ),
      );
      const tab = yield* manager.open({ threadId, url: "http://localhost:3000" });
      const dependencies = Layer.mergeAll(
        PreviewAutomationBroker.layer.pipe(
          Layer.provide(
            Layer.merge(NodeServices.layer, Layer.succeed(Preview.PreviewManager, manager)),
          ),
        ),
        Layer.succeed(Preview.PreviewManager, manager),
        Layer.succeed(McpInvocationContext.McpInvocationContext, scope),
        threads,
        Layer.mock(ServerSettings.ServerSettingsService)({
          getSettings: Effect.succeed(settings),
        }),
      );
      const toolkit = yield* PreviewControlsToolkit.pipe(
        Effect.provide(
          McpToolAccess.HandlersLayer.layer(PreviewControlsHandlers.layer).pipe(
            Layer.provide(dependencies),
          ),
        ),
      );
      const call = (name: "t3_preview_list" | "t3_preview_close", args: Record<string, unknown>) =>
        toolkit
          .handle(name, args)
          .pipe(Stream.unwrap, Stream.runCollect, Effect.provide(dependencies));
      return {
        tab,
        listed: yield* call("t3_preview_list", {}),
        closed: yield* call("t3_preview_close", { tabId: tab.tabId }),
        manager,
      };
    }),
  );

const agentTaskBinding = (role: AgentRole, toolProfile: AgentToolProfile): AgentTaskBinding => {
  const policy = agentPolicySnapshot();
  const task = agentTaskRequest({ role, taskClass: "ui" });
  const selection = { instanceId: ProviderInstanceId.make("codex"), model: "gpt-sol-test" };
  return {
    ...task,
    requestFingerprint: "e".repeat(64),
    policyHash: policy.hash,
    policyRevision: policy.sourceRevision,
    briefHash: policy.briefs[role]!.hash,
    sourceAccess: "read-only",
    toolProfile,
    requested: selection,
    assigned: null,
    effective: selection,
  };
};

const layerChildThreads = (childThreadId: ThreadId, role: AgentRole) =>
  Layer.mock(ThreadManagement.ThreadManagementService)({
    getThreadShell: () =>
      Effect.succeed({
        ...McpToolAccessTestkit.liveThreadShell(childThreadId),
        agentTask: agentTaskBinding(role, "phi"),
      }),
  });

it.effect.each([
  { name: "project opt-in", globalAccess: false, projectAccess: true },
  { name: "project opt-out", globalAccess: true, projectAccess: false },
])("list and close respect the credential for a $name", ({ globalAccess, projectAccess }) =>
  Effect.gen(function* () {
    const { tab, listed, closed, manager } = yield* runControls({
      settings: settingsWith(globalAccess, projectAccess),
      threadId,
      threads: McpToolAccessTestkit.liveThreadsLayer,
    });
    if (projectAccess) {
      expect(listed.at(-1)?.result).toMatchObject({ sessions: [tab], nextCursor: null });
      expect(closed.at(-1)?.result).toEqual({});
      expect((yield* manager.list({ threadId })).sessions).toEqual([]);
    } else {
      for (const result of [listed, closed]) {
        expect(result.at(-1)?.result).toMatchObject({
          _tag: "PreviewAutomationUnavailableError",
          capability: "preview",
          threadId,
        });
      }
      expect((yield* manager.list({ threadId })).sessions).toEqual([tab]);
    }
  }),
);

it.effect.each(["browser", "ui-verifier"] as const)(
  "a delegated %s child still closes its own tab once access is revoked",
  (role) => {
    const childThreadId = ThreadId.make(`preview-controls-revoked-${role}-child`);
    return Effect.gen(function* () {
      const { tab, listed, closed, manager } = yield* runControls({
        // The credential was issued while access was on; the settings no longer allow it.
        settings: settingsWith(false, false),
        threadId: childThreadId,
        threads: layerChildThreads(childThreadId, role),
        toolProfile: "phi",
        agentRole: role,
        browserCapability: true,
      });
      expect(listed.at(-1)?.result).toMatchObject({ sessions: [tab] });
      expect(closed.at(-1)?.result).toEqual({});
      expect((yield* manager.list({ threadId: childThreadId })).sessions).toEqual([]);
    });
  },
);

it.effect.each(["browser", "ui-verifier"] as const)(
  "a delegated %s child closes the tab its own session opened",
  (role) => {
    const childThreadId = ThreadId.make(`preview-controls-${role}-child`);
    return Effect.gen(function* () {
      const { tab, listed, closed, manager } = yield* runControls({
        settings: settingsWith(true, true),
        threadId: childThreadId,
        threads: layerChildThreads(childThreadId, role),
        toolProfile: "phi",
        agentRole: role,
      });
      expect(listed.at(-1)?.result).toMatchObject({ sessions: [tab] });
      expect(closed.at(-1)?.result).toEqual({});
      expect((yield* manager.list({ threadId: childThreadId })).sessions).toEqual([]);
    });
  },
);
