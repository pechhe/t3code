import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import { agentPolicyRoot } from "../agents/agentPolicyRoot.ts";
import * as AgentPolicy from "../agents/AgentPolicyService.ts";

/**
 * The tool patterns the owner's role policy hides from every agent thread. A Reference, so a
 * layer built without a policy hides nothing instead of failing to build.
 */
export const HiddenTools = Context.Reference<ReadonlyArray<string>>("t3/mcp/HiddenTools", {
  defaultValue: () => [],
});

/** The owner's hidden tools, read once where the policy service is available. */
export const layerHiddenTools = Layer.unwrap(
  Effect.gen(function* () {
    const service = yield* AgentPolicy.AgentPolicyService;
    const root = yield* agentPolicyRoot;
    const patterns = Option.isNone(root)
      ? []
      : yield* service.snapshot(root.value).pipe(
          Effect.map((snapshot) => snapshot.manifest.hiddenTools ?? []),
          // An unreadable policy hides nothing: the run that needs it reports the reason.
          Effect.orElseSucceed(() => []),
        );
    return Layer.succeed(HiddenTools, patterns);
  }),
);
