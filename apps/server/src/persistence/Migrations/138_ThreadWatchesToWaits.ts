import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

const PayloadJson = Schema.fromJsonString(Schema.Unknown);
const decodePayload = Schema.decodeUnknownEffect(PayloadJson);
const encodePayload = Schema.encodeUnknownEffect(PayloadJson);

type StoredWatch = {
  readonly id?: unknown;
  readonly title?: unknown;
  readonly startedAt?: unknown;
  readonly target?: Record<string, unknown>;
  readonly threadId?: unknown;
  readonly waitsOnPerson?: unknown;
};

const targetKey = (target: Record<string, unknown>) =>
  JSON.stringify([
    target.kind,
    target.threadId,
    target.environmentId,
    target.number,
    target.until,
    target.operationId,
  ]);

/**
 * A thread holds one kind of wait. Each held watch becomes a wait that gives up two hours from
 * now, as a wait with no expected time does; T3's own landing waits last until the landing ends.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const now = yield* DateTime.now;
  const expectedAt = DateTime.formatIso(DateTime.add(now, { hours: 1 }));
  const givesUpAt = DateTime.formatIso(DateTime.add(now, { hours: 2 }));
  const toWaits = Effect.fnUntraced(function* (payloadJson: string) {
    const { threadWatches, ...thread } = (yield* decodePayload(payloadJson)) as Record<
      string,
      unknown
    > & {
      readonly threadWatches?: ReadonlyArray<StoredWatch>;
      readonly parkedWaits?: ReadonlyArray<{ readonly target: Record<string, unknown> }>;
    };
    const parked = thread.parkedWaits ?? [];
    const waiting = new Set(parked.map((wait) => targetKey(wait.target)));
    const converted = (threadWatches ?? []).flatMap((watch) => {
      const target =
        watch.target ??
        (typeof watch.threadId === "string" ? { kind: "thread", threadId: watch.threadId } : null);
      if (target === null || typeof watch.id !== "string" || waiting.has(targetKey(target))) {
        return [];
      }
      const lastsUntilEnded = watch.id.includes("server:landing-watch:");
      return [
        {
          id: watch.id,
          title: watch.title,
          startedAt: watch.startedAt,
          target,
          ...(lastsUntilEnded ? {} : { expectedAt, givesUpAt }),
          ...(watch.waitsOnPerson === undefined ? {} : { waitsOnPerson: watch.waitsOnPerson }),
        },
      ];
    });
    const waits = [...parked, ...converted];
    return yield* encodePayload({
      ...thread,
      ...(waits.length === 0 ? {} : { parkedWaits: waits }),
    });
  });

  const rows = yield* sql<{ thread_id: string; payload_json: string }>`
    SELECT thread_id, payload_json FROM orchestration_v2_projection_threads
    WHERE json_valid(payload_json) AND json_type(payload_json, '$.threadWatches') = 'array'
  `;
  for (const row of rows) {
    yield* sql`
      UPDATE orchestration_v2_projection_threads
      SET payload_json = ${yield* toWaits(row.payload_json)}
      WHERE thread_id = ${row.thread_id}
    `;
  }

  // Normalize the source events too, so rebuilding projections cannot drop the old watches.
  const pageSize = 500;
  let afterSequence = 0;
  while (true) {
    const events = yield* sql<{ readonly sequence: number; readonly payload_json: string }>`
      SELECT sequence, payload_json FROM orchestration_events
      WHERE sequence > ${afterSequence}
        AND application_event_version = 2 AND aggregate_kind = 'thread'
        AND json_valid(payload_json)
        AND json_type(payload_json, '$.threadWatches') = 'array'
      ORDER BY sequence
      LIMIT ${pageSize}
    `;
    for (const event of events) {
      yield* sql`
        UPDATE orchestration_events
        SET payload_json = ${yield* toWaits(event.payload_json)}
        WHERE sequence = ${event.sequence}
      `;
    }
    if (events.length < pageSize) break;
    afterSequence = events.at(-1)!.sequence;
  }
  yield* sql`DROP INDEX IF EXISTS orchestration_v2_projection_threads_watching_idx`;
});
