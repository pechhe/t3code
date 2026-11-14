import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

import * as Journal from "../persistence/WorkspaceCustody.ts";
import * as Sqlite from "../persistence/Sqlite.ts";
import * as ProcessRunner from "../processRunner.ts";
import * as WorkspaceCustody from "./WorkspaceCustody.ts";

const json = Schema.fromJsonString(Schema.Unknown);
const requestSchema = Schema.Struct({ ownerId: Schema.String, credential: Schema.String });
const decodeRequest = Schema.decodeEffect(Schema.fromJsonString(requestSchema));
const decodeRelease = Schema.decodeEffect(
  Schema.fromJsonString(
    Schema.Struct({
      claimId: Schema.String,
      generation: Schema.String,
      requestId: Schema.String,
      settlementRef: Schema.String,
    }),
  ),
);
export const fixture = Effect.gen(function* () {
  const controllerStart = yield* Ref.make("first-start");
  const producerProtocol = yield* Ref.make(1);
  const workspaceRoot = yield* Ref.make<string | null>(null);
  const releases = yield* Ref.make(0);
  const releaseFailures = yield* Ref.make(0);
  const releaseRefusalClaim = yield* Ref.make<string | null>(null);
  const releaseLostReplies = yield* Ref.make(0);
  const releaseRequests = yield* Ref.make<
    ReadonlyArray<{ claimId: string; generation: string; requestId: string; settlementRef: string }>
  >([]);
  const releasedRequests = new Set<string>();
  const acquisitionPath = yield* Ref.make<string | null>(null);
  const acquisitionGate = yield* Ref.make<Effect.Effect<void>>(Effect.void);
  const argumentsUsed = yield* Ref.make<ReadonlyArray<string>>([]);
  const processLayer = Layer.mock(ProcessRunner.ProcessRunner)({
    run: Effect.fn("custodyFixture.run")(function* (input) {
      yield* Ref.update(argumentsUsed, (all) => [...all, input.command, ...input.args]);
      const args = input.command === "bun" ? input.args.slice(1) : input.args;
      if (input.command === "jj" && args[0] === "root")
        return {
          stdout: (yield* Ref.get(workspaceRoot)) ?? input.cwd ?? "",
          stderr: "",
          code: ChildProcessSpawner.ExitCode(0),
          timedOut: false,
          stdoutTruncated: false,
          stderrTruncated: false,
          stdoutInvalidUtf8: false,
          stderrInvalidUtf8: false,
        };
      let reply: unknown;
      let code = 0;
      let lostReply = false;
      switch (args[1]) {
        case "capability":
          reply = {
            ok: true,
            capability: "generation-bound-custody",
            protocol: yield* Ref.get(producerProtocol),
            supported: true,
            producerEntry: "/producer/workspace.ts",
          };
          break;
        case "activate":
          reply = { ok: true, version: 1, activationId: "activation-one" };
          break;
        case "controller":
          reply = {
            ok: true,
            controller: {
              platform: "linux",
              pid: 123,
              boot: "boot-one",
              start: yield* Ref.get(controllerStart),
            },
          };
          break;
        case "acquire": {
          yield* yield* Ref.get(acquisitionGate);
          const request = yield* decodeRequest(input.stdin ?? "");
          reply = {
            ok: true,
            version: 1,
            path: (yield* Ref.get(acquisitionPath)) ?? args[2],
            generation: "allocation-one",
            claimId: request.ownerId,
            ownerId: request.ownerId,
          };
          break;
        }
        case "release": {
          const request = yield* decodeRelease(input.stdin ?? "");
          yield* Ref.update(releaseRequests, (requests) => [...requests, request]);
          if (
            (yield* Ref.get(releaseFailures)) > 0 &&
            ((yield* Ref.get(releaseRefusalClaim)) === null ||
              (yield* Ref.get(releaseRefusalClaim)) === request.claimId)
          ) {
            yield* Ref.update(releaseFailures, (count) => count - 1);
            code = 1;
            reply = { ok: false };
            break;
          }
          if (!releasedRequests.has(request.requestId)) {
            releasedRequests.add(request.requestId);
            yield* Ref.update(releases, (count) => count + 1);
          }
          if ((yield* Ref.get(releaseLostReplies)) > 0) {
            yield* Ref.update(releaseLostReplies, (count) => count - 1);
            lostReply = true;
          }
          reply = {
            ok: true,
            version: 1,
            released: true,
            generation: request.generation,
            claimId: request.claimId,
          };
          break;
        }
        case "recover":
          reply = { ok: true, recoveryRequired: true };
          break;
        default:
          return yield* Effect.die("Unexpected custody producer operation");
      }
      const stdout = lostReply ? "" : yield* Schema.encodeEffect(json)(reply).pipe(Effect.orDie);
      return {
        stdout,
        stderr: "",
        code: ChildProcessSpawner.ExitCode(code),
        timedOut: false,
        stdoutTruncated: false,
        stderrTruncated: false,
        stdoutInvalidUtf8: false,
        stderrInvalidUtf8: false,
      };
    }, Effect.orDie),
  });
  const persistence = Journal.layer.pipe(Layer.provideMerge(Sqlite.layerMemory));
  const dependencies = Layer.mergeAll(
    persistence,
    processLayer,
    NodeServices.layer,
    NodeCrypto.layer,
    Layer.succeed(WorkspaceCustody.ControllerPid, 123),
  );
  const layer = WorkspaceCustody.layer.pipe(Layer.provideMerge(dependencies));
  return {
    layer,
    dependencies,
    releaseFailures,
    releaseRefusalClaim,
    releaseLostReplies,
    releaseRequests,
    controllerStart,
    producerProtocol,
    workspaceRoot,
    releases,
    argumentsUsed,
    acquisitionGate,
    acquisitionPath,
  };
});
