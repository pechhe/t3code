import { describe, expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as WorkspaceAllocationIntents from "../persistence/WorkspaceAllocationIntents.ts";
import * as Processes from "../processRunner.ts";
import * as Git from "../vcs/GitVcsDriver.ts";
import * as Workspaces from "./WorkspaceProvider.ts";

const output = (stdout = "") => ({
  stdout,
  stderr: "",
  code: ChildProcessSpawner.ExitCode(0),
  timedOut: false,
  stdoutTruncated: false,
  stderrTruncated: false,
  stdoutInvalidUtf8: false,
  stderrInvalidUtf8: false,
});
const failure = (stderr = "", stdout = "") => ({
  ...output(stdout),
  stderr,
  code: ChildProcessSpawner.ExitCode(1),
});

// What `slipjay attempt show` and `attempt release` print.
const attempt = (record: {
  readonly status: "allocating" | "preparing" | "ready" | "failed";
  readonly workspacePath?: string;
  readonly owned?: boolean;
  readonly interrupted?: boolean;
}) => output(JSON.stringify({ interrupted: false, ...record }));
const noAttempt = (id = "id") => failure(`No allocation attempt '${id}'`);
const released = (removed: string | null = null) =>
  output(JSON.stringify({ released: true, removed }));
const refused = (reason: string) => ({
  ...output(JSON.stringify({ released: false, reason })),
  code: ChildProcessSpawner.ExitCode(1),
});

type Command = { readonly args: ReadonlyArray<string>; readonly cwd: string | undefined };
type Handler = (
  args: ReadonlyArray<string>,
) => ReturnType<typeof output> | Effect.Effect<ReturnType<typeof output>>;

// A SlipJay whose commands are scripted by name (`start`, `attempt show`, `attempt release`,
// `attach-issue`); anything unscripted succeeds with no output.
const harness = Effect.fn("test.harness")(function* (handlers: Partial<Record<string, Handler>>) {
  const intents = yield* WorkspaceAllocationIntents.WorkspaceAllocationIntents;
  const commands: Array<Command> = [];
  const service = yield* Workspaces.make.pipe(
    Effect.provide(
      Layer.mergeAll(
        Layer.mock(Processes.ProcessRunner)({
          run: (input) =>
            Effect.suspend(() => {
              commands.push({ args: [input.command, ...input.args], cwd: input.cwd });
              const key = input.args[0] === "attempt" ? `attempt ${input.args[1]}` : input.args[0];
              const result = (key === undefined ? undefined : handlers[key])?.(input.args);
              return result === undefined
                ? Effect.succeed(output())
                : Effect.isEffect(result)
                  ? result
                  : Effect.succeed(result);
            }),
        }),
        Layer.mock(Git.GitVcsDriver)({}),
      ),
    ),
  );
  const named = (name: string) =>
    commands.filter((command) =>
      name === "attempt release" || name === "attempt show"
        ? command.args.slice(1, 3).join(" ") === name
        : command.args[1] === name,
    );
  return { intents, service, commands, named };
});

const layerIntents = WorkspaceAllocationIntents.layer.pipe(
  Layer.provideMerge(SqlitePersistence.layerMemory),
);

const request = {
  projectRoot: "/project",
  task: "work",
  owner: { kind: "thread-launch", ref: "thread-1" },
} as const;

const attemptIdOf = (commands: ReadonlyArray<Command>) => {
  const start = commands.find((command) => command.args[1] === "start")?.args ?? [];
  return start[start.indexOf("--attempt") + 1];
};

it.layer(NodeServices.layer)("WorkspaceProvider lifecycle", (it) => {
  it.effect("removes JJ checkouts through SlipJay and linked Git worktrees through Git", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* fs.realPath(yield* fs.makeTempDirectoryScoped());
      yield* fs.makeDirectory(`${root}/.jj`);
      yield* fs.writeFileString(`${root}/slipjay.json`, "{}");
      yield* fs.makeDirectory(`${root}/jj-child/.jj`, { recursive: true });
      yield* fs.makeDirectory(`${root}/git-child`);
      const commands: string[][] = [];
      const gitPaths: string[] = [];
      const service = yield* Workspaces.make.pipe(
        Effect.provide(
          Layer.mergeAll(
            Layer.mock(Processes.ProcessRunner)({
              run: (input) =>
                Effect.sync(() => {
                  commands.push([input.command, ...input.args]);
                  return output();
                }),
            }),
            Layer.mock(Git.GitVcsDriver)({
              removeWorktree: (input) =>
                Effect.sync(() => {
                  gitPaths.push(input.path);
                }),
            }),
          ),
        ),
      );
      yield* service.remove({ cwd: root, path: `${root}/jj-child`, force: true });
      yield* service.remove({ cwd: root, path: `${root}/git-child`, force: true });
      expect(commands).toEqual([["slipjay", "remove", `${root}/jj-child`]]);
      expect(gitPaths).toEqual([`${root}/git-child`]);
    }).pipe(Effect.provide(layerIntents)),
  );

  it.effect("finds a SlipJay project from its Jujutsu root, never from a Git-only repository", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* fs.realPath(yield* fs.makeTempDirectoryScoped());
      const cwds: string[] = [];
      const service = yield* Workspaces.make.pipe(
        Effect.provide(
          Layer.mergeAll(
            Layer.mock(Processes.ProcessRunner)({
              run: (input) =>
                Effect.sync(() => {
                  // Nothing is committed on trunk() in these repositories.
                  if (input.command === "jj")
                    return { ...output(), code: ChildProcessSpawner.ExitCode(1) };
                  cwds.push(input.cwd ?? "");
                  return output(JSON.stringify({ workspacePath: `${root}/allocated` }));
                }),
            }),
            Layer.mock(Git.GitVcsDriver)({}),
          ),
        ),
      );
      yield* fs.makeDirectory(`${root}/jj/.jj`, { recursive: true });
      yield* fs.makeDirectory(`${root}/jj/packages/app`, { recursive: true });
      yield* fs.writeFileString(`${root}/jj/slipjay.json`, "{ not json");
      yield* fs.makeDirectory(`${root}/git/.git`, { recursive: true });
      yield* fs.makeDirectory(`${root}/git/packages/app`, { recursive: true });
      yield* fs.writeFileString(`${root}/git/slipjay.json`, "{}");
      yield* fs.makeDirectory(`${root}/plain-jj/.jj`, { recursive: true });
      // A subdirectory of a SlipJay project is one too, even when SlipJay cannot read its config.
      expect(yield* service.resolve(`${root}/jj/packages/app`)).toBe("slipjay");
      expect(yield* service.resolve(`${root}/git/packages/app`)).toBe("git-worktree");
      expect(yield* service.resolve(`${root}/plain-jj`)).toBe("git-worktree");
      // It allocates from the SlipJay root, where slipjay.json lives.
      yield* service.allocate({ ...request, projectRoot: `${root}/jj/packages/app` });
      expect(cwds).toEqual([`${root}/jj`]);
    }).pipe(Effect.provide(layerIntents)),
  );

  it.effect.each([true, false, undefined])(
    "gives back a workspace through its attempt when cancellation arrives before SlipJay emits the allocation receipt: %s",
    (created) =>
      Effect.gen(function* () {
        const entered = yield* Deferred.make<void>();
        const allowReceipt = yield* Deferred.make<void>();
        const { intents, service, commands, named } = yield* harness({
          start: () =>
            Deferred.succeed(entered, undefined).pipe(
              Effect.andThen(Deferred.await(allowReceipt)),
              Effect.as(
                output(JSON.stringify({ workspacePath: "/allocated-jj-workspace", created })),
              ),
            ),
          "attempt release": () => Effect.succeed(released("/allocated-jj-workspace")),
        });
        const allocation = yield* service.allocate(request).pipe(Effect.forkChild);
        yield* Deferred.await(entered);
        yield* Effect.sync(() => allocation.interruptUnsafe());
        yield* Deferred.succeed(allowReceipt, undefined);
        expect(Exit.isFailure(yield* Fiber.await(allocation))).toBe(true);
        // SlipJay decides what the attempt owns: a resumed or unvouched checkout is kept by it.
        const id = attemptIdOf(commands);
        expect(named("attempt release").map((command) => command.args.slice(1))).toEqual([
          ["attempt", "release", id],
        ]);
        expect(yield* intents.list).toEqual([]);
      }).pipe(Effect.provide(layerIntents)),
  );

  it.effect.each([
    { receipt: { created: true }, created: true },
    { receipt: { created: false }, created: false },
    { receipt: {}, created: null },
  ])("reports the allocation receipt's created as $created", ({ receipt, created }) =>
    Effect.gen(function* () {
      const { service } = yield* harness({
        start: () => output(JSON.stringify({ workspacePath: "/ws", ...receipt })),
      });
      const allocation = yield* service.allocate(request);
      expect(allocation.created).toBe(created);
    }).pipe(Effect.provide(layerIntents)),
  );

  it.effect("records the intent before SlipJay starts and keeps it until the caller settles", () =>
    Effect.gen(function* () {
      let recorded: ReadonlyArray<WorkspaceAllocationIntents.WorkspaceAllocationIntent> = [];
      const intents = yield* WorkspaceAllocationIntents.WorkspaceAllocationIntents;
      const { service, commands } = yield* harness({
        start: () =>
          intents.list.pipe(
            Effect.orDie,
            Effect.tap((rows) =>
              Effect.sync(() => {
                recorded = rows;
              }),
            ),
            Effect.as(output(JSON.stringify({ workspacePath: "/ws", created: true }))),
          ),
      });
      const allocation = yield* service.allocate(request);
      const id = allocation.attemptId;
      expect(attemptIdOf(commands)).toBe(id);
      expect(recorded).toMatchObject([
        {
          attemptId: id,
          projectRoot: "/project",
          ownerKind: "thread-launch",
          ownerRef: "thread-1",
        },
      ]);
      expect((yield* intents.list).map((row) => row.attemptId)).toEqual([id]);
      yield* service.settled(id);
      expect(yield* intents.list).toEqual([]);
    }).pipe(Effect.provide(layerIntents)),
  );

  it.effect("allocates a Build item's workspace through SlipJay's resume-or-create start", () =>
    Effect.gen(function* () {
      const { service, commands } = yield* harness({
        start: () => output(JSON.stringify({ workspacePath: "/item-42", created: false })),
      });
      const allocation = yield* service.allocate({
        ...request,
        issue: { number: 42, mode: "resume" },
      });
      const id = attemptIdOf(commands);
      expect(allocation).toEqual({
        workspacePath: "/item-42",
        created: false,
        issue: 42,
        attemptId: id,
      });
      expect(commands).toEqual([
        {
          args: [
            "slipjay",
            "start",
            "--integration",
            "--json",
            "--attempt",
            id,
            "--issue",
            "42",
            "work",
          ],
          cwd: "/project",
        },
      ]);
    }).pipe(Effect.provide(layerIntents)),
  );

  it.effect.each([
    { attachCode: 0, issue: 42, attachFailure: undefined },
    {
      attachCode: 1,
      issue: null,
      attachFailure: "SlipJay could not allocate a workspace for /project (slipjay exited with 1).",
    },
  ])(
    "attaches a Build item to a new checkout only when no other workspace holds it: %o",
    ({ attachCode, issue, attachFailure }) =>
      Effect.gen(function* () {
        const { service, commands } = yield* harness({
          start: () => output(JSON.stringify({ workspacePath: "/fresh", created: true })),
          "attach-issue": () => ({ ...output(""), code: ChildProcessSpawner.ExitCode(attachCode) }),
        });
        const allocation = yield* service.allocate({
          ...request,
          issue: { number: 42, mode: "attach" },
        });
        const id = allocation.attemptId;
        expect(allocation).toEqual({
          workspacePath: "/fresh",
          created: true,
          issue,
          attemptId: id,
          ...(attachFailure === undefined ? {} : { attachFailure }),
        });
        expect(commands).toEqual([
          {
            args: ["slipjay", "start", "--integration", "--json", "--attempt", id, "work"],
            cwd: "/project",
          },
          { args: ["slipjay", "attach-issue", "42"], cwd: "/fresh" },
        ]);
      }).pipe(Effect.provide(layerIntents)),
  );

  it.effect.each([
    { name: "stderr", stdout: "progress", stderr: "Issue 42 is held by another workspace\n" },
    { name: "stdout when stderr is empty", stdout: "Issue 42 is held\n", stderr: "" },
  ])("a failed allocation says why SlipJay refused: $name", ({ stdout, stderr }) =>
    Effect.gen(function* () {
      const { intents, service } = yield* harness({
        start: () => failure(stderr, stdout),
        "attempt show": () => noAttempt(),
      });
      const error = yield* Effect.flip(service.allocate(request));
      expect(error.message).toBe(
        `SlipJay could not allocate a workspace for /project (slipjay exited with 1): ${(stderr || stdout).trim()}`,
      );
      // SlipJay never recorded the start, so nothing can be stranded and the intent is gone.
      expect(yield* intents.list).toEqual([]);
    }).pipe(Effect.provide(layerIntents)),
  );

  it.effect("bounds long SlipJay output to its tail and leaves a silent failure unchanged", () =>
    Effect.gen(function* () {
      let stderr = `${"noise ".repeat(1000)}the real cause`;
      const { service } = yield* harness({
        start: () => failure(stderr),
        "attempt show": () => noAttempt(),
      });
      const long = yield* Effect.flip(service.allocate(request));
      expect(long.detail?.length).toBeLessThanOrEqual(1000);
      expect(long.detail?.startsWith("…")).toBe(true);
      expect(long.message.endsWith("the real cause")).toBe(true);
      stderr = "  \n";
      const silent = yield* Effect.flip(service.allocate(request));
      expect(silent.message).toBe(
        "SlipJay could not allocate a workspace for /project (slipjay exited with 1).",
      );
    }).pipe(Effect.provide(layerIntents)),
  );

  describe("a start whose receipt never arrived", () => {
    it.effect.each([
      { owned: true, created: true },
      { owned: false, created: false },
    ])("uses the finished checkout instead of starting again: owned $owned", ({ owned, created }) =>
      Effect.gen(function* () {
        const { intents, service, named } = yield* harness({
          start: () => failure("receipt lost"),
          "attempt show": () => attempt({ status: "ready", workspacePath: "/finished", owned }),
        });
        const allocation = yield* service.allocate(request);
        expect(allocation).toMatchObject({ workspacePath: "/finished", created });
        expect(named("start")).toHaveLength(1);
        expect(named("attempt release")).toEqual([]);
        // The caller still owns the checkout, so the intent stays until it settles.
        expect((yield* intents.list).map((row) => row.attemptId)).toEqual([allocation.attemptId]);
      }).pipe(Effect.provide(layerIntents)),
    );

    it.effect.each([
      { name: "failed", show: () => attempt({ status: "failed" }) },
      {
        name: "interrupted",
        show: () => attempt({ status: "preparing", interrupted: true }),
      },
    ])("releases an attempt that $name and surfaces the error", ({ show }) =>
      Effect.gen(function* () {
        const { intents, service, named } = yield* harness({
          start: () => failure("install failed"),
          "attempt show": show,
          "attempt release": () => released("/half-prepared"),
        });
        const error = yield* Effect.flip(service.allocate(request));
        expect(error.detail).toBe("install failed");
        expect(named("start")).toHaveLength(1);
        expect(named("attempt release")).toHaveLength(1);
        expect(yield* intents.list).toEqual([]);
      }).pipe(Effect.provide(layerIntents)),
    );

    it.effect("keeps the intent, with SlipJay's reason, when it refuses to release", () =>
      Effect.gen(function* () {
        const { intents, service } = yield* harness({
          start: () => failure("install failed"),
          "attempt show": () => attempt({ status: "failed" }),
          "attempt release": () => refused("the checkout has unlanded work"),
        });
        yield* Effect.flip(service.allocate(request));
        expect(yield* intents.list).toMatchObject([{ detail: "the checkout has unlanded work" }]);
      }).pipe(Effect.provide(layerIntents)),
    );

    it.effect("neither releases nor starts again while SlipJay still runs the start", () =>
      Effect.gen(function* () {
        let state: ReturnType<typeof output> = attempt({ status: "preparing" });
        const { intents, service, named, commands } = yield* harness({
          start: () => failure("timed out"),
          "attempt show": () => state,
        });
        const error = yield* Effect.flip(service.allocate(request));
        const attemptId = attemptIdOf(commands);
        // The caller sees the attempt, that it still runs, and how to retry it safely.
        expect(error.detail).toBe(
          `timed out. SlipJay attempt ${attemptId} is still running and may yet complete. T3 keeps the attempt: retry the same request to reconcile it rather than start another checkout.`,
        );
        expect(named("start")).toHaveLength(1);
        expect(named("attempt release")).toEqual([]);
        expect((yield* intents.list).map((row) => row.attemptId)).toEqual([attemptId]);

        // The same owner's retry names the same attempt and starts nothing.
        const retried = yield* Effect.flip(service.allocate(request));
        expect(retried.detail).toContain(`SlipJay attempt ${attemptId} is still running`);
        expect(named("start")).toHaveLength(1);

        // Once SlipJay finishes it, the retry adopts that checkout.
        state = attempt({ status: "ready", workspacePath: "/ws", owned: true });
        const allocation = yield* service.allocate(request);
        expect(allocation).toMatchObject({ attemptId, workspacePath: "/ws" });
        expect(named("start")).toHaveLength(1);
      }).pipe(Effect.provide(layerIntents)),
    );

    it.effect("tells a caller whose retry would not adopt to check the attempt instead", () =>
      Effect.gen(function* () {
        const { intents, service, commands } = yield* harness({
          start: () => failure("timed out"),
          "attempt show": () => attempt({ status: "preparing" }),
        });
        const error = yield* Effect.flip(
          service.allocate({ ...request, owner: { kind: "mcp", ref: "call-1" } }),
        );
        const attemptId = attemptIdOf(commands);
        expect(error.detail).toBe(
          `timed out. SlipJay attempt ${attemptId} is still running and may yet complete. T3 keeps the attempt and settles it when it finishes; check it with \`slipjay attempt show ${attemptId}\` before asking again, since a new request starts another checkout.`,
        );
        expect((yield* intents.list).map((row) => row.attemptId)).toEqual([attemptId]);
      }).pipe(Effect.provide(layerIntents)),
    );

    it.effect(
      "says the attempt's state is unknown, and keeps it, when SlipJay will not report it",
      () =>
        Effect.gen(function* () {
          let state: ReturnType<typeof output> = failure("database is locked");
          const { intents, service, named, commands } = yield* harness({
            start: () => failure("timed out"),
            "attempt show": () => state,
            "attempt release": () => released(),
          });
          const error = yield* Effect.flip(service.allocate(request));
          const attemptId = attemptIdOf(commands);
          expect(error.detail).toBe(
            `timed out. SlipJay could not report the state of attempt ${attemptId}, which may still be running. T3 keeps the attempt: retry the same request to reconcile it rather than start another checkout.`,
          );
          expect(named("attempt release")).toEqual([]);
          expect((yield* intents.list).map((row) => row.attemptId)).toEqual([attemptId]);

          // When it later fails, the startup sweep settles it as before.
          state = attempt({ status: "failed" });
          yield* service.reconcile({
            isBound: () => Effect.succeed(false),
            retryable: () => Effect.succeed(false),
          });
          expect(named("attempt release").map((command) => command.args[3])).toEqual([attemptId]);
          expect(yield* intents.list).toEqual([]);
        }).pipe(Effect.provide(layerIntents)),
    );
  });

  describe("reconcile", () => {
    const record = (
      intents: WorkspaceAllocationIntents.WorkspaceAllocationIntents["Service"],
      attemptId: string,
    ) =>
      intents.record({
        attemptId,
        projectRoot: "/project",
        ownerKind: "thread-launch",
        ownerRef: "thread-1",
        createdAt: "2026-10-21T09:00:00.000Z",
      });

    it.effect("settles what an earlier run left, keeping bound and unfinished checkouts", () =>
      Effect.gen(function* () {
        const shows: Record<string, ReturnType<typeof output>> = {
          gone: noAttempt("gone"),
          running: attempt({ status: "allocating" }),
          broken: attempt({ status: "failed" }),
          bound: attempt({ status: "ready", workspacePath: "/bound", owned: true }),
          stray: attempt({ status: "ready", workspacePath: "/stray", owned: true }),
          unlanded: attempt({ status: "ready", workspacePath: "/unlanded", owned: true }),
        };
        const { intents, service, named } = yield* harness({
          "attempt show": (args) => shows[args[2] ?? ""] ?? noAttempt(),
          "attempt release": (args) =>
            args[2] === "unlanded" ? refused("the checkout has unlanded work") : released(),
        });
        for (const id of Object.keys(shows)) yield* record(intents, id);
        const asked: string[] = [];
        yield* service.reconcile({
          isBound: (path) => Effect.sync(() => (asked.push(path), path === "/bound")),
          retryable: () => Effect.succeed(false),
        });
        expect(named("attempt release").map((command) => command.args[3])).toEqual([
          "broken",
          "stray",
          "unlanded",
        ]);
        expect(asked).toEqual(["/bound", "/stray", "/unlanded"]);
        expect((yield* intents.list).map((row) => [row.attemptId, row.detail]).sort()).toEqual([
          ["running", null],
          ["unlanded", "the checkout has unlanded work"],
        ]);
        // A second sweep changes nothing more.
        yield* service.reconcile({
          isBound: () => Effect.succeed(false),
          retryable: () => Effect.succeed(false),
        });
        expect(named("attempt release")).toHaveLength(4);
      }).pipe(Effect.provide(layerIntents)),
    );

    it.effect("leaves an allocation this process is still making or has not settled", () =>
      Effect.gen(function* () {
        const { intents, service, named } = yield* harness({
          start: () => output(JSON.stringify({ workspacePath: "/ws", created: true })),
        });
        const allocation = yield* service.allocate(request);
        yield* service.reconcile({
          isBound: () => Effect.succeed(false),
          retryable: () => Effect.succeed(false),
        });
        expect(named("attempt show")).toEqual([]);
        expect((yield* intents.list).map((row) => row.attemptId)).toEqual([allocation.attemptId]);
      }).pipe(Effect.provide(layerIntents)),
    );

    it.effect("keeps a finished checkout for the launching thread's retry while it can retry", () =>
      Effect.gen(function* () {
        const { intents, service, named } = yield* harness({
          "attempt show": () => attempt({ status: "ready", workspacePath: "/ws", owned: true }),
          "attempt release": () => released(),
        });
        yield* record(intents, "waiting");
        yield* service.reconcile({
          isBound: () => Effect.succeed(false),
          retryable: () => Effect.succeed(true),
        });
        expect(named("attempt release")).toEqual([]);
        expect(yield* intents.list).toHaveLength(1);
        yield* service.reconcile({
          isBound: () => Effect.succeed(false),
          retryable: () => Effect.succeed(false),
        });
        expect(named("attempt release")).toHaveLength(1);
        expect(yield* intents.list).toEqual([]);
      }).pipe(Effect.provide(layerIntents)),
    );

    it.effect("releases an unbound checkout a terminal or tool call asked for", () =>
      Effect.gen(function* () {
        const { intents, service, named } = yield* harness({
          "attempt show": () => attempt({ status: "ready", workspacePath: "/ws", owned: true }),
        });
        yield* intents.record({
          attemptId: "tool",
          projectRoot: "/project",
          ownerKind: "mcp",
          ownerRef: "thread-1",
          createdAt: "2026-10-21T09:00:00.000Z",
        });
        yield* service.reconcile({
          isBound: () => Effect.succeed(false),
          retryable: () => Effect.succeed(true),
        });
        expect(named("attempt release")).toHaveLength(1);
      }).pipe(Effect.provide(layerIntents)),
    );
  });

  describe("adopting an earlier launch", () => {
    const earlier = (
      intents: WorkspaceAllocationIntents.WorkspaceAllocationIntents["Service"],
      ownerKind = "thread-launch",
    ) =>
      intents.record({
        attemptId: "earlier",
        projectRoot: "/project",
        ownerKind,
        ownerRef: "thread-1",
        createdAt: "2026-10-21T09:00:00.000Z",
      });

    it.effect("uses the checkout its interrupted launch finished and starts nothing", () =>
      Effect.gen(function* () {
        const { intents, service, named } = yield* harness({
          "attempt show": () => attempt({ status: "ready", workspacePath: "/ws", owned: true }),
        });
        yield* earlier(intents);
        const allocation = yield* service.allocate(request);
        expect(allocation).toMatchObject({
          workspacePath: "/ws",
          created: true,
          attemptId: "earlier",
        });
        expect(named("start")).toEqual([]);
        // Still the caller's to settle once bound.
        expect(yield* intents.list).toHaveLength(1);
        yield* service.settled(allocation.attemptId);
        expect(yield* intents.list).toEqual([]);
      }).pipe(Effect.provide(layerIntents)),
    );

    it.effect("starts afresh, settling the earlier row, when that start never finished", () =>
      Effect.gen(function* () {
        const shows: Record<string, ReturnType<typeof output>> = {
          earlier: attempt({ status: "failed" }),
        };
        const { intents, service, named } = yield* harness({
          start: () => output(JSON.stringify({ workspacePath: "/new", created: true })),
          "attempt show": (args) => shows[args[2] ?? ""] ?? noAttempt(),
          "attempt release": () => released(),
        });
        yield* earlier(intents);
        const allocation = yield* service.allocate(request);
        expect(allocation).toMatchObject({ workspacePath: "/new" });
        expect(allocation.attemptId).not.toBe("earlier");
        expect(named("start")).toHaveLength(1);
        expect(named("attempt release").map((command) => command.args[3])).toEqual(["earlier"]);
        expect((yield* intents.list).map((row) => row.attemptId)).toEqual([allocation.attemptId]);
      }).pipe(Effect.provide(layerIntents)),
    );

    it.effect("neither starts again nor releases while the earlier start still runs", () =>
      Effect.gen(function* () {
        const { intents, service, named } = yield* harness({
          start: () => output(JSON.stringify({ workspacePath: "/new", created: true })),
          "attempt show": () => attempt({ status: "preparing" }),
        });
        yield* earlier(intents);
        yield* Effect.flip(service.allocate(request));
        expect(named("start")).toEqual([]);
        expect(named("attempt release")).toEqual([]);
        expect((yield* intents.list).map((row) => row.attemptId)).toEqual(["earlier"]);
      }).pipe(Effect.provide(layerIntents)),
    );

    it.effect("never adopts a checkout a sweep is releasing", () =>
      Effect.gen(function* () {
        const reading = yield* Deferred.make<void>();
        const proceed = yield* Deferred.make<void>();
        let gone = false;
        let shows = 0;
        const { intents, service, named } = yield* harness({
          start: () => output(JSON.stringify({ workspacePath: "/new", created: true })),
          // The sweep reads the attempt first and is held there while a retry arrives.
          "attempt show": () =>
            ++shows === 1
              ? Deferred.succeed(reading, undefined).pipe(
                  Effect.andThen(Deferred.await(proceed)),
                  Effect.as(attempt({ status: "ready", workspacePath: "/ws", owned: true })),
                )
              : Effect.succeed(
                  gone
                    ? noAttempt()
                    : attempt({ status: "ready", workspacePath: "/ws", owned: true }),
                ),
          "attempt release": () => {
            gone = true;
            return released();
          },
        });
        yield* earlier(intents);
        const sweeping = yield* Effect.forkChild(
          service.reconcile({
            isBound: () => Effect.succeed(false),
            retryable: () => Effect.succeed(false),
          }),
        );
        yield* Deferred.await(reading);
        const retrying = yield* Effect.forkChild(service.allocate(request));
        yield* Deferred.succeed(proceed, undefined);
        yield* Fiber.join(sweeping);
        const allocation = yield* Fiber.join(retrying);
        // The retry never holds the checkout the sweep gave back: it starts its own.
        expect(named("attempt release").map((command) => command.args[3])).toEqual(["earlier"]);
        expect(allocation).toMatchObject({ workspacePath: "/new" });
        expect(allocation.attemptId).not.toBe("earlier");
      }).pipe(Effect.provide(layerIntents)),
    );

    it.effect("is not undone by a later sweep once the retry has taken the checkout", () =>
      Effect.gen(function* () {
        const { intents, service, named } = yield* harness({
          "attempt show": () => attempt({ status: "ready", workspacePath: "/ws", owned: true }),
          "attempt release": () => released(),
        });
        yield* earlier(intents);
        const allocation = yield* service.allocate(request);
        yield* service.reconcile({
          isBound: () => Effect.succeed(false),
          retryable: () => Effect.succeed(false),
        });
        expect(named("attempt release")).toEqual([]);
        expect((yield* intents.list).map((row) => row.attemptId)).toEqual([allocation.attemptId]);
      }).pipe(Effect.provide(layerIntents)),
    );

    it.effect("never adopts for another kind of owner", () =>
      Effect.gen(function* () {
        const { intents, service, named } = yield* harness({
          start: () => output(JSON.stringify({ workspacePath: "/new", created: true })),
          "attempt show": () => attempt({ status: "ready", workspacePath: "/ws", owned: true }),
        });
        yield* earlier(intents, "terminal");
        const allocation = yield* service.allocate(request);
        expect(allocation.workspacePath).toBe("/new");
        expect(named("start")).toHaveLength(1);
      }).pipe(Effect.provide(layerIntents)),
    );
  });
});
