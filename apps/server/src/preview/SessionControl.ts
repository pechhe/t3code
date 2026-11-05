import { PreviewAutomationControlReason } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

export class BrowserControlInterrupted extends Schema.TaggedError<BrowserControlInterrupted>()(
  "BrowserControlInterrupted",
  {
    message: Schema.String.pipe(
      Schema.withConstructorDefault(
        Effect.succeed("Browser control changed. Refresh the snapshot before trying again."),
      ),
    ),
    reason: PreviewAutomationControlReason.pipe(
      Schema.withConstructorDefault(Effect.succeed("interrupted" as const)),
    ),
  },
) {}

/** A bounded browser task holds this tab; only passive reads and closing stay available. */
export class BrowserTaskLeaseHeld extends Schema.TaggedError<BrowserTaskLeaseHeld>()(
  "BrowserTaskLeaseHeld",
  {
    message: Schema.String.pipe(
      Schema.withConstructorDefault(
        Effect.succeed(
          "A bounded browser task holds this tab. Read preview_status, wait for it to finish, or cancel it.",
        ),
      ),
    ),
  },
) {}

const settle = (work: Promise<unknown>) =>
  work.then(
    () => undefined,
    () => undefined,
  );

/** Reserves control immediately, but drains running work before the new owner can act. */
export class SessionControl {
  readonly agentId: string | null;
  private readonly onGenerationChange: () => void;
  private tail: Promise<unknown> = Promise.resolve();
  private latestHuman: {
    entry: { viewerId: string; key: string; input: unknown; run: (input: never) => Promise<void> };
    result: Promise<void>;
  } | null = null;
  private pending: Promise<void> = Promise.resolve();
  private readonly handoff = new Set<Promise<void>>();
  private readonly observations = new Set<Promise<void>>();
  private owner: string | null = null;
  private epoch = 0;
  private closed = false;
  private taskLease: string | null = null;
  private inspectionDue = false;

  constructor(agentId: string | null, onGenerationChange: () => void = () => {}) {
    this.agentId = agentId;
    this.onGenerationChange = onGenerationChange;
  }

  get controller() {
    return this.owner;
  }

  get generation() {
    return this.epoch;
  }

  private enqueue<A>(run: () => Promise<A>): Promise<A> {
    this.latestHuman = null;
    const result = this.tail.then(run);
    this.tail = result.then(
      () => this.pending,
      () => this.pending,
    );
    return result;
  }

  /** An action can respond before its navigation commits, while later actions still wait. */
  track(work: Promise<unknown>) {
    this.pending = Promise.all([this.pending, settle(work)]).then(() => undefined);
  }

  /** Viewer input stays responsive, but control handoffs still drain its navigations. */
  trackUntilHandoff(work: Promise<unknown>) {
    const settled = settle(work).finally(() => {
      this.handoff.delete(settled);
    });
    this.handoff.add(settled);
  }

  private assertOpen() {
    if (this.closed)
      throw new BrowserControlInterrupted({
        message: "This browser tab is closed.",
        reason: "closed",
      });
  }

  private changeOwner(owner: string | null) {
    this.latestHuman = null;
    this.owner = owner;
    this.epoch++;
    this.onGenerationChange();
  }

  private async action<A>(allowed: () => boolean, run: () => Promise<A>, deadlineMs?: number) {
    this.assertOpen();
    if (!allowed())
      throw new BrowserControlInterrupted({ message: "You do not control this browser tab." });
    const epoch = this.epoch;
    return this.enqueue(async () => {
      this.assertOpen();
      if (epoch !== this.epoch || !allowed()) throw new BrowserControlInterrupted();
      if (deadlineMs !== undefined && performance.now() >= deadlineMs) {
        throw new DOMException(
          "This browser request expired before it could start.",
          "TimeoutError",
        );
      }
      return run();
    });
  }

  /** Whether this caller holds the tab's lease, or the tab has none. */
  private leaseAllows(lease: string | undefined) {
    return this.taskLease === null || this.taskLease === lease;
  }

  get taskLeaseHeld() {
    return this.taskLease !== null;
  }

  assertLeaseAllows(lease?: string) {
    if (!this.leaseAllows(lease)) throw new BrowserTaskLeaseHeld();
  }

  /**
   * Reserves the tab at once, so nothing new can start, then waits for work already running to
   * drain. The holder acts only after this resolves.
   */
  async acquireTaskLease(agentId: string, lease: string) {
    this.assertOpen();
    if (this.agentId !== agentId)
      throw new BrowserControlInterrupted({
        message: "This tab belongs to another agent.",
        reason: "agentMismatch",
      });
    if (this.owner !== null)
      throw new BrowserControlInterrupted({
        message: "A human controls this tab.",
        reason: "humanControl",
      });
    this.assertLeaseAllows();
    this.taskLease = lease;
    await this.tail;
    // A snapshot already running regenerates refs, so it must end before the holder reads any.
    await Promise.all(this.observations);
    this.assertOpen();
  }

  /** Gives back a lease whose holder dispatched nothing, without waiting on anyone else's work. */
  abandonTaskLease(lease: string) {
    if (this.taskLease === lease) this.taskLease = null;
  }

  /** Ends the lease only once everything it dispatched has quiesced; closing unblocks the wait. */
  async releaseTaskLease(lease: string, options: { readonly inspectFirst: boolean }) {
    await this.tail;
    if (this.taskLease !== lease) return;
    this.taskLease = null;
    if (options.inspectFirst) this.inspectionDue = true;
  }

  /** After an uncertain mutation the page must be read before anything changes it again. */
  get inspectionRequired() {
    return this.inspectionDue;
  }

  markInspected() {
    this.inspectionDue = false;
  }

  agentMayAct(agentId: string) {
    return this.agentId === null || this.agentId === agentId;
  }

  agent<A>(agentId: string, run: () => Promise<A>, deadlineMs?: number, lease?: string) {
    if (!this.agentMayAct(agentId))
      return Promise.reject(
        new BrowserControlInterrupted({
          message: "This tab belongs to another agent.",
          reason: "agentMismatch",
        }),
      );
    if (this.owner !== null)
      return Promise.reject(
        new BrowserControlInterrupted({
          message: "A human controls this tab.",
          reason: "humanControl",
        }),
      );
    if (!this.leaseAllows(lease)) return Promise.reject(new BrowserTaskLeaseHeld());
    return this.action(
      () => this.agentMayAct(agentId) && this.owner === null,
      async () => {
        this.assertLeaseAllows(lease);
        return run();
      },
      deadlineMs,
    );
  }

  agentCanActNow(agentId: string) {
    return this.agentMayAct(agentId) && this.owner === null;
  }

  /** Read without control or queueing so agents can observe without delaying human input. */
  observe<A>(run: () => Promise<A>) {
    this.assertOpen();
    this.assertLeaseAllows();
    const work = run();
    const settled = settle(work).finally(() => {
      this.observations.delete(settled);
    });
    this.observations.add(settled);
    return work;
  }

  system<A>(run: () => Promise<A>) {
    this.assertOpen();
    return this.enqueue(async () => {
      this.assertOpen();
      return run();
    });
  }

  human<A>(viewerId: string, run: () => Promise<A>) {
    return this.action(() => this.owner === viewerId, run);
  }

  /**
   * Merge into only adjacent waiting work with the same key; the running action and
   * intervening actions keep their order. Work sharing a key must share its input type.
   */
  humanLatest<A>(
    viewerId: string,
    key: string,
    input: A,
    run: (input: A) => Promise<void>,
    merge: (waiting: A, next: A) => A = (_waiting, next) => next,
  ): Promise<void> {
    if (this.closed || this.owner !== viewerId) return this.human(viewerId, () => run(input));
    const latest = this.latestHuman;
    if (latest?.entry.viewerId === viewerId && latest.entry.key === key) {
      latest.entry.input = merge(latest.entry.input as A, input);
      latest.entry.run = run;
      return latest.result;
    }
    const entry = { viewerId, key, input, run };
    const result = this.human(viewerId, async () => {
      if (this.latestHuman?.entry === entry) this.latestHuman = null;
      await entry.run(entry.input);
    });
    this.latestHuman = { entry, result };
    return result;
  }

  async take(viewerId: string) {
    this.assertOpen();
    this.assertLeaseAllows();
    if (this.owner !== null && this.owner !== viewerId) {
      throw new BrowserControlInterrupted({ message: "Another viewer controls this browser tab." });
    }
    if (this.owner !== viewerId) this.changeOwner(viewerId);
    return this.human(viewerId, async () => {});
  }

  async release(viewerId: string, afterDrain: () => Promise<void> = async () => {}) {
    this.assertOpen();
    if (this.owner !== viewerId) {
      throw new BrowserControlInterrupted({
        message: "Only the controlling viewer can release this browser tab.",
      });
    }
    this.changeOwner(null);
    await this.enqueue(async () => {
      await Promise.all(this.handoff);
      await afterDrain();
    });
  }

  async disconnect(viewerId: string, afterDrain?: () => Promise<void>) {
    if (!this.closed && this.owner === viewerId) await this.release(viewerId, afterDrain);
  }

  async close() {
    if (!this.closed) {
      this.closed = true;
      this.changeOwner(null);
    }
    await this.tail;
  }
}
