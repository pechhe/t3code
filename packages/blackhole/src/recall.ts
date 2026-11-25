import * as NodeCrypto from "node:crypto";

import { BLACKHOLE_DEFAULTS } from "./config.ts";
import type { SessionEntry } from "./session.ts";
import { registerVirtualSession } from "./upstream/core/session-lines.ts";
import { executeRecall } from "./upstream/tools/recall.ts";

export interface RecallParams {
  readonly query?: string | undefined;
  readonly expand?: ReadonlyArray<number> | undefined;
  readonly page?: number | undefined;
  readonly scope?: "lineage" | "all" | undefined;
  readonly mode?: "hybrid" | "file" | "touched" | undefined;
}

/** Blackhole's `recall` over a session: same grammar, ranking and response budget as in Pi. */
export async function recall(
  entries: ReadonlyArray<SessionEntry>,
  params: RecallParams,
  maxChars: number = BLACKHOLE_DEFAULTS.recallResponseMaxChars,
): Promise<string> {
  const key = `t3-blackhole-session:${NodeCrypto.randomUUID()}`;
  const release = registerVirtualSession(key, entries);
  const branch = entries as SessionEntry[];
  const sessionManager = {
    getSessionFile: () => key,
    getBranch: () => branch,
    getEntries: () => branch,
  };
  try {
    const result = await executeRecall(
      {
        ...(params.query === undefined ? {} : { query: params.query }),
        ...(params.expand === undefined ? {} : { expand: [...params.expand] }),
        ...(params.page === undefined ? {} : { page: params.page }),
        ...(params.scope === undefined ? {} : { scope: params.scope }),
        ...(params.mode === undefined ? {} : { mode: params.mode }),
      },
      { sessionManager },
      maxChars,
    );
    return result.content.map((part) => part.text).join("\n");
  } finally {
    release();
  }
}
