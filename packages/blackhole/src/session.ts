import type { Message } from "./shims/pi-ai.ts";

/**
 * A T3 thread seen as a Pi session: its conversation as message entries, with Blackhole's memory
 * records and compactions placed where they were written. Blackhole's own code reads it unchanged.
 */
export type SessionEntry =
  | {
      readonly type: "message";
      readonly id: string;
      readonly timestamp: string;
      readonly message: Message;
    }
  | {
      readonly type: "custom";
      readonly id: string;
      readonly timestamp: string;
      readonly customType: string;
      readonly data: unknown;
    }
  | {
      readonly type: "compaction";
      readonly id: string;
      readonly timestamp: string;
      readonly summary: string;
      /** Always "" in T3: every compaction starts a fresh native session, so nothing is kept raw. */
      readonly firstKeptEntryId: string;
      readonly details?: unknown;
    };

export type { Message };
