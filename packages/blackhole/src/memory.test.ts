import { describe, expect, it } from "vite-plus/test";

import {
  compileCompaction,
  recall,
  runMemoryCycle,
  type RunWorker,
  type SessionEntry,
  type WorkerRequest,
} from "./index.ts";

let clock = Date.parse("2026-11-25T10:00:00Z");
const at = () => new Date((clock += 60_000)).toISOString();
const user = (id: string, text: string): SessionEntry => ({
  type: "message",
  id,
  timestamp: at(),
  message: { role: "user", content: [{ type: "text", text }], timestamp: clock },
});
const assistant = (id: string, text: string): SessionEntry => ({
  type: "message",
  id,
  timestamp: at(),
  message: { role: "assistant", content: [{ type: "text", text }], timestamp: clock },
});

const conversation: SessionEntry[] = [
  user("u1", "Deploy the billing service to staging, never to production without asking me."),
  assistant("a1", "Deployed billing to staging as release r-512. ".repeat(20)),
  user("u2", "Now rotate the webhook secret."),
  assistant("a2", "Rotated the webhook secret; the old one stops working at 18:00. ".repeat(20)),
];

const LOW = {
  observeAfterTokens: 50,
  reflectAfterTokens: 50,
  observationsPoolMaxTokens: 20_000,
};

describe("Blackhole memory in a T3 session", () => {
  it("records observer output, reflects on it, and both reach the compaction and recall", async () => {
    const requests: WorkerRequest[] = [];
    const runWorker: RunWorker = async (request) => {
      requests.push(request);
      if (request.stage === "observer") {
        expect(request.prompt).toContain("[Source entry id: u1]");
        return {
          observations: [
            {
              content: "User forbids production deploys without asking.",
              relevance: "critical",
              sourceEntryIds: ["u1"],
            },
            {
              content: "Billing release r-512 is on staging.",
              relevance: "high",
              sourceEntryIds: ["a1"],
            },
          ],
          complete: true,
        };
      }
      if (request.stage === "reflector") {
        const supporting = /\[([0-9a-f]{12})\][^\n]*production/.exec(request.prompt)?.[1];
        expect(supporting).toBeDefined();
        return {
          reflections: [
            {
              content: "Never deploy to production without the user's approval.",
              supportingObservationIds: [supporting],
              relevance: "critical",
            },
          ],
          complete: true,
        };
      }
      return null;
    };

    const records = await runMemoryCycle({ entries: conversation, runWorker, config: LOW });
    // The pool is far below its budget, so the dropper has nothing it may drop and makes no call.
    expect(requests.map((request) => request.stage)).toEqual(["observer", "reflector"]);
    expect(records.map((record) => record.customType)).toEqual([
      "om.observations.recorded",
      "om.reflections.recorded",
    ]);

    const session: SessionEntry[] = [
      ...conversation,
      ...records.map((record, index): SessionEntry => ({
        type: "custom",
        id: `m${index}`,
        timestamp: at(),
        customType: record.customType,
        data: record.data,
      })),
    ];
    const compaction = compileCompaction({ entries: session, cwd: "/repo", memory: true });
    expect(compaction?.text).toContain("## Reflections");
    expect(compaction?.text).toContain("Never deploy to production without the user's approval.");
    expect(compaction?.text).toContain("Billing release r-512 is on staging.");

    const observationId = /\[([0-9a-f]{12})\] \S+ \S+ \[high\] Billing/.exec(compaction!.text)?.[1];
    expect(observationId).toBeDefined();
    const sources = await recall(session, { query: observationId! });
    expect(sources).toContain("Deployed billing to staging as release r-512.");

    expect(await recall(session, { query: "webhook secret" })).toContain("#2");
    expect(await recall(session, { query: "#0" })).toContain("never to production");
  });

  it("turning memory off still compacts, without memory", () => {
    const compaction = compileCompaction({ entries: conversation, cwd: "/repo", memory: false });
    expect(compaction?.text).toContain("[Session Goal]");
    expect(compaction?.text).not.toContain("## Observations");
  });

  it("stays idle below the observe threshold", async () => {
    const runWorker: RunWorker = async () => {
      throw new Error("no worker should run");
    };
    expect(await runMemoryCycle({ entries: conversation.slice(0, 1), runWorker })).toEqual([]);
  });
});
