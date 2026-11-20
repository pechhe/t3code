import * as WorkspaceProvider from "../project/WorkspaceProvider.ts";
import * as SlipJayLandings from "../project/SlipJayLandings.ts";
import { expect, it } from "@effect/vitest";

import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";

import * as GitManager from "./GitManager.ts";
import * as GitWorkflowService from "./GitWorkflowService.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import * as VcsDriverRegistry from "../vcs/VcsDriverRegistry.ts";

it.layer(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer))("GitWorkflowService", (it) => {
  it.effect(
    "routes normal workspace removal through the workspace provider before Git-only checks",
    () => {
      const removed: string[] = [];
      return Effect.gen(function* () {
        const workflow = yield* GitWorkflowService.GitWorkflowService;
        yield* workflow.removeWorktree({ cwd: "/jj-project", path: "/jj-child", force: true });
        expect(removed).toEqual(["/jj-child"]);
      }).pipe(
        Effect.provide(
          GitWorkflowService.layer.pipe(
            Layer.provide(SlipJayLandings.layerNone),
            Layer.provide(
              Layer.mergeAll(
                Layer.mock(WorkspaceProvider.WorkspaceProvider)({
                  remove: (input) =>
                    Effect.sync(() => {
                      removed.push(input.path);
                    }),
                }),
                Layer.mock(VcsDriverRegistry.VcsDriverRegistry)({}),
                Layer.mock(GitVcsDriver.GitVcsDriver)({}),
                Layer.mock(GitManager.GitManager)({}),
              ),
            ),
          ),
        ),
      );
    },
  );
});
