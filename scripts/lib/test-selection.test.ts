import { assert, describe, it } from "@effect/vitest";

import { changedModulePaths, importerTests } from "./test-selection.ts";

describe("what a change selects", () => {
  it("names a changed module as an import does, an index directory included", () => {
    assert.deepStrictEqual(
      [
        ...changedModulePaths([
          "apps/server/src/weave/WeaveAgentConnections.ts",
          "apps/x/index.ts",
        ]),
      ],
      ["apps/server/src/weave/WeaveAgentConnections", "apps/x/index", "apps/x"],
    );
  });

  it("selects a test importing a changed module from another directory", () => {
    // 20ff9c2027 failed the landing gate on tests its change left alone: they call the
    // changed ExperimentService and sit in another directory, so no beside-file rule saw them.
    assert.deepStrictEqual(
      importerTests(
        [
          {
            file: "apps/server/src/agents/ExternalAgentWorkService.test.ts",
            source: 'import * as Experiments from "../experiments/ExperimentService.ts";',
          },
          {
            file: "apps/server/src/mcp/ExperimentWorkMcp.test.ts",
            source: 'import * as Experiments from "../experiments/ExperimentService.ts";',
          },
          {
            file: "apps/server/src/mcp/ToolSessionPolicy.test.ts",
            source: 'import { AgentPolicy } from "@t3tools/contracts";',
          },
        ],
        ["apps/server/src/experiments/ExperimentService.ts"],
      ),
      [
        "apps/server/src/agents/ExternalAgentWorkService.test.ts",
        "apps/server/src/mcp/ExperimentWorkMcp.test.ts",
      ],
    );
  });
});
