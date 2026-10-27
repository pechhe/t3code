import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

// Triggers keep these counts exact. Turn items are written by INSERT, ON CONFLICT DO UPDATE and
// DELETE; an INSERT OR REPLACE would skip the delete trigger (recursive_triggers is off) and drift them.
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE TABLE orchestration_v2_projection_run_item_counts (
      thread_id TEXT NOT NULL,
      run_id TEXT,
      item_count INTEGER NOT NULL
    )
  `;
  // Distinguish runless history from even an empty run ID, and group NULLs together.
  yield* sql`
    CREATE UNIQUE INDEX orchestration_v2_projection_run_item_counts_key
    ON orchestration_v2_projection_run_item_counts(thread_id, COALESCE(run_id, ''), run_id IS NULL)
  `;
  yield* sql`
    INSERT INTO orchestration_v2_projection_run_item_counts (thread_id, run_id, item_count)
    SELECT thread_id, run_id, COUNT(*) FROM orchestration_v2_projection_turn_items
    GROUP BY thread_id, run_id
  `;
  yield* sql`
    CREATE TRIGGER orchestration_v2_projection_run_item_counts_insert
    AFTER INSERT ON orchestration_v2_projection_turn_items
    BEGIN
      INSERT INTO orchestration_v2_projection_run_item_counts (thread_id, run_id, item_count)
      VALUES (new.thread_id, new.run_id, 1)
      ON CONFLICT DO UPDATE SET item_count = item_count + 1;
    END
  `;
  yield* sql`
    CREATE TRIGGER orchestration_v2_projection_run_item_counts_delete
    AFTER DELETE ON orchestration_v2_projection_turn_items
    BEGIN
      UPDATE orchestration_v2_projection_run_item_counts SET item_count = item_count - 1
      WHERE thread_id = old.thread_id AND COALESCE(run_id, '') = COALESCE(old.run_id, '')
        AND (run_id IS NULL) = (old.run_id IS NULL);
      DELETE FROM orchestration_v2_projection_run_item_counts
      WHERE thread_id = old.thread_id AND COALESCE(run_id, '') = COALESCE(old.run_id, '')
        AND (run_id IS NULL) = (old.run_id IS NULL) AND item_count = 0;
    END
  `;
  yield* sql`
    CREATE TRIGGER orchestration_v2_projection_run_item_counts_update
    AFTER UPDATE OF thread_id, run_id ON orchestration_v2_projection_turn_items
    WHEN old.thread_id IS NOT new.thread_id OR old.run_id IS NOT new.run_id
    BEGIN
      UPDATE orchestration_v2_projection_run_item_counts SET item_count = item_count - 1
      WHERE thread_id = old.thread_id AND COALESCE(run_id, '') = COALESCE(old.run_id, '')
        AND (run_id IS NULL) = (old.run_id IS NULL);
      DELETE FROM orchestration_v2_projection_run_item_counts
      WHERE thread_id = old.thread_id AND COALESCE(run_id, '') = COALESCE(old.run_id, '')
        AND (run_id IS NULL) = (old.run_id IS NULL) AND item_count = 0;
      INSERT INTO orchestration_v2_projection_run_item_counts (thread_id, run_id, item_count)
      VALUES (new.thread_id, new.run_id, 1)
      ON CONFLICT DO UPDATE SET item_count = item_count + 1;
    END
  `;
  yield* sql`
    CREATE INDEX orchestration_v2_projection_turn_items_message_ordinal_idx
    ON orchestration_v2_projection_turn_items(thread_id, json_extract(payload_json, '$.messageId'), ordinal)
    WHERE type IN ('user_message', 'assistant_message')
  `;
});
