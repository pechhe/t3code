#!/usr/bin/env node
// @effect-diagnostics nodeBuiltinImport:off globalTimers:off - Polls fixture state for a worker arm outside the server runtime.
// Serves the browser decision-evaluation fixtures for a worker arm that drives its own browser.
// Writes <out>/manifest.json once and <out>/outcomes.json on every change; stops on SIGTERM.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeUtil from "node:util";
import { FIXTURE_VERSION, JOURNEYS, startFixture } from "../src/browserDecisionEval/journeys.ts";

const { values } = NodeUtil.parseArgs({
  options: { out: { type: "string" }, repeats: { type: "string", default: "1" } },
});
if (!values.out) throw new Error("Use --out <directory>.");
NodeFS.mkdirSync(values.out, { recursive: true });
const served: {
  journey: (typeof JOURNEYS)[number];
  repeat: number;
  fixture: Awaited<ReturnType<typeof startFixture>>;
}[] = [];
for (const journey of JOURNEYS) {
  for (let repeat = 0; repeat < Number(values.repeats); repeat += 1) {
    served.push({ journey, repeat, fixture: await startFixture(journey) });
  }
}
NodeFS.writeFileSync(
  NodePath.join(values.out, "manifest.json"),
  JSON.stringify(
    {
      fixtureVersion: FIXTURE_VERSION,
      fixtures: served.map(({ journey, repeat, fixture }) => ({
        journey: journey.id,
        repeat,
        goal: journey.goal,
        url: `${fixture.origin}${journey.startPath}`,
      })),
    },
    null,
    2,
  ),
);
const write = () =>
  NodeFS.writeFileSync(
    NodePath.join(values.out!, "outcomes.json"),
    JSON.stringify(
      served.map(({ journey, repeat, fixture }) => ({
        journey: journey.id,
        repeat,
        ...fixture.outcome(),
      })),
    ),
  );
const timer = setInterval(write, 250);
process.on("SIGTERM", () => {
  clearInterval(timer);
  write();
  process.exit(0);
});
