import type { OrchestrationV2ThreadShell } from "@t3tools/contracts";
import type * as SqlClient from "effect/sql/SqlClient";

type ChampionShellRow = {
  readonly owner_thread_id: string;
  readonly setup_thread_id: string | null;
  readonly id: string;
  readonly attention: number;
  readonly setup_attention: number;
};

/**
 * The Champions owning or setting up any of the given threads (fork/differences.md `champions`),
 * read with a shell snapshot so each thread shell can carry its Champion.
 */
export const readChampionShellRows = (sql: SqlClient.SqlClient, encodedThreadIds: string) =>
  sql<ChampionShellRow>`
    WITH target_threads AS (SELECT value FROM json_each(${encodedThreadIds}))
    SELECT json_extract(document_json, '$.champion.ownerThreadId') AS owner_thread_id,
      json_extract(document_json, '$.champion.setupThreadId') AS setup_thread_id,
      id, json_array_length(json_extract(document_json, '$.champion.attention')) AS attention,
      CASE WHEN EXISTS (SELECT 1 FROM json_each(document_json, '$.champion.attention') WHERE value LIKE 'Setup %')
        THEN 1 ELSE 0 END AS setup_attention
    FROM champions
    WHERE json_extract(document_json, '$.champion.ownerThreadId') IN (SELECT value FROM target_threads)
      OR json_extract(document_json, '$.champion.setupThreadId') IN (SELECT value FROM target_threads)
  `;

/** Adds each thread's Champion, as its owner or setup thread, to the shells it read. */
export const withChampions = (rows: ReadonlyArray<ChampionShellRow>) => {
  const champions = new Map(
    rows.flatMap((row) =>
      [row.owner_thread_id, ...(row.setup_thread_id === null ? [] : [row.setup_thread_id])].map(
        (threadId) =>
          [
            threadId,
            {
              id: row.id,
              attention:
                (threadId === row.owner_thread_id ? row.attention : row.setup_attention) > 0,
            },
          ] as const,
      ),
    ),
  );
  return <T extends OrchestrationV2ThreadShell>(thread: T): T =>
    champions.has(thread.id) ? { ...thread, champion: champions.get(thread.id)! } : thread;
};
