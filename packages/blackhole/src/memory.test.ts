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

  it("repeated compactions stay bounded when the stored summary is the whole handoff text", async () => {
    // T3 stores `compaction.text` (summary + memory) on the compaction item and feeds it back.
    let round = 0;
    const runWorker: RunWorker = async (request) =>
      request.stage === "observer"
        ? {
            observations: [
              {
                content: `Round ${round} fact about the billing service.`,
                relevance: "high",
                sourceEntryIds: [`u${round}`],
              },
            ],
            complete: true,
          }
        : null;
    const session: SessionEntry[] = [];
    const sizes: number[] = [];
    let text = "";
    for (round = 1; round <= 6; round++) {
      session.push(
        user(`u${round}`, `Round ${round}: keep working on the billing service.`),
        assistant(`a${round}`, `Round ${round}: done, details follow. `.repeat(20)),
      );
      const records = await runMemoryCycle({ entries: session, runWorker, config: LOW });
      records.forEach((record, index) =>
        session.push({
          type: "custom",
          id: `m${round}-${index}`,
          timestamp: at(),
          customType: record.customType,
          data: record.data,
        }),
      );
      const compaction = compileCompaction({ entries: session, cwd: "/repo", memory: true });
      expect(compaction).toBeDefined();
      text = compaction!.text;
      sizes.push(text.length);
      session.push({
        type: "compaction",
        id: `c${round}`,
        timestamp: at(),
        summary: text,
        firstKeptEntryId: "",
      });
      expect(text.match(/^## Observations/gm)?.length ?? 0).toBeLessThanOrEqual(1);
      expect(text.match(/The\s+conversation\s+before\s+this\s+point/g)?.length).toBe(1);
      for (let n = 1; n <= round; n++) {
        // once in the goals, once in the transcript
        expect(text.match(new RegExp(`Round ${n}:\\s+keep working`, "g"))?.length).toBe(2);
      }
      for (let n = 1; n <= round; n++) {
        expect(text.split(`Round ${n} fact about`).length - 1).toBe(1);
      }
    }
    // Growth is linear in new content, not compounding.
    expect(sizes[5]! - sizes[4]!).toBeLessThanOrEqual((sizes[1]! - sizes[0]!) * 2);
  });

  it.each([
    ["a stance paragraph, then a short request line", true],
    ["a single long paragraph with no short line", false],
  ])("keeps the transcript across compactions when the first message is %s", (_name, shortLine) => {
    const stance =
      "Delegation stance: implement. Build everything yourself; read-only helpers are fine. ".repeat(
        8,
      );
    const first = shortLine
      ? `${stance.trim()}\n\nUser message:\nFix the billing webhook retry bug.`
      : stance.trim();
    const session: SessionEntry[] = [
      user("u1", first),
      assistant("a1", "Looking at the retry code now."),
    ];
    const one = compileCompaction({ entries: session, cwd: "/repo", memory: false })!;
    session.push(
      { type: "compaction", id: "c1", timestamp: at(), summary: one.text, firstKeptEntryId: "" },
      user("u2", "Also add a regression test."),
      assistant("a2", "Added the regression test."),
    );
    const two = compileCompaction({ entries: session, cwd: "/repo", memory: false })!;
    expect(two.summary).toContain("Looking at the retry code now.");
    expect(two.summary).toContain("Added the regression test.");
  });

  it("keeps a headerless fresh transcript merged into a summary that has goals", () => {
    const session: SessionEntry[] = [
      user("u1", "Fix the billing webhook retry bug."),
      assistant("a1", "On it."),
    ];
    const one = compileCompaction({ entries: session, cwd: "/repo", memory: false })!;
    session.push(
      { type: "compaction", id: "c1", timestamp: at(), summary: one.text, firstKeptEntryId: "" },
      user(
        "u2",
        "Please also review the retry backoff settings in the worker configuration. ".repeat(6),
      ),
      assistant("a2", "Reviewed the backoff settings."),
    );
    const two = compileCompaction({ entries: session, cwd: "/repo", memory: false })!;
    expect(two.summary).toContain("On it.");
    expect(two.summary).toContain("Reviewed the backoff settings.");
  });

  it("stays idle below the observe threshold", async () => {
    const runWorker: RunWorker = async () => {
      throw new Error("no worker should run");
    };
    expect(await runMemoryCycle({ entries: conversation.slice(0, 1), runWorker })).toEqual([]);
  });
});
