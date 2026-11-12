import {
  ChampionListInput,
  ChampionListResult,
  ChampionSummary,
  EnvironmentId,
  OrchestratorMcpPeerNotice,
  PeerEnvironmentStatus,
} from "@t3tools/contracts";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import * as McpInvocationContext from "../mcp/McpInvocationContext.ts";
import * as PeerLinks from "../peer/PeerLinks.ts";
import * as PeerMcpClient from "../peer/PeerMcpClient.ts";
import { readCaller } from "../mcp/threadAccess.ts";
import * as PeerEnvironments from "../peers/PeerEnvironments.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as Champions from "./ChampionService.ts";

const EnvironmentStatus = Schema.Struct({
  environmentId: EnvironmentId,
  label: Schema.String,
  status: PeerEnvironmentStatus,
  notice: Schema.String,
});
export const ChampionDirectoryResult = Schema.Struct({
  champions: Schema.Array(
    Schema.Struct({
      ...ChampionSummary.fields,
      environmentId: Schema.optional(EnvironmentId),
      environmentLabel: Schema.optional(Schema.String),
    }),
  ),
  environments: Schema.optional(Schema.Array(EnvironmentStatus)),
});

const decodeListResult = Schema.decodeUnknownEffect(ChampionListResult);

/** Summaries have no paging; aggregate each machine once without duplicating its page. */
export const listAcross = Effect.fn("ChampionDirectory.listAcross")(function* (
  input: typeof ChampionListInput.Type & { readonly environmentId?: EnvironmentId | undefined },
) {
  const scope = yield* McpInvocationContext.McpInvocationContext;
  const service = yield* Champions.ChampionService;
  const { environmentId, ...query } = input;
  const local = yield* service.list(query);
  const peers = yield* Effect.serviceOption(PeerEnvironments.PeerEnvironments);
  if (
    environmentId !== undefined ||
    scope.client?.linked === true ||
    scope.linkedEnvironments === false
  )
    return local;
  const links = yield* Effect.serviceOption(PeerLinks.PeerLinks);
  const client = yield* Effect.serviceOption(PeerMcpClient.PeerMcpClient);
  const full =
    Option.isSome(links) && Option.isSome(client)
      ? yield* links.value.list.pipe(Effect.orElseSucceed(() => []))
      : [];
  const limits = full.length > 0 ? (yield* readCaller()).limits : undefined;
  const readOnly = Option.isSome(peers)
    ? yield* peers.value.linked.pipe(Effect.orElseSucceed(() => []))
    : [];
  const linked = [
    ...full,
    ...readOnly.filter((peer) => !full.some((link) => link.environmentId === peer.environmentId)),
  ];
  const answers = yield* Effect.forEach(
    linked,
    (peer) => {
      const answer = (
        status: PeerEnvironmentStatus,
        page: typeof ChampionListResult.Type | null,
      ) => ({
        environmentId: peer.environmentId,
        label: peer.label,
        status,
        notice: OrchestratorMcpPeerNotice,
        page,
      });
      if (
        full.some((link) => link.environmentId === peer.environmentId) &&
        Option.isSome(client) &&
        limits !== undefined
      )
        return client.value
          .call({
            environmentId: peer.environmentId,
            tool: "t3_champions_list",
            arguments: { environmentId: peer.environmentId },
            limits,
            success: ChampionListResult,
          })
          .pipe(
            Effect.map((page) => answer("ok", page)),
            Effect.catchTags({
              OrchestratorMcpFailure: (error) =>
                Effect.succeed(
                  answer(error.code === "capability_denied" ? "unauthorized" : "offline", null),
                ),
            }),
            Effect.timeoutOption(Duration.seconds(8)),
            Effect.map(Option.getOrElse(() => answer("timeout", null))),
          );
      if (Option.isNone(peers)) return Effect.succeed(answer("offline", null));
      return peers.value
        .callTool({
          environmentId: peer.environmentId,
          name: "t3_champions_list",
          arguments: { environmentId: peer.environmentId },
        })
        .pipe(
          Effect.flatMap((result) =>
            result.isError
              ? Effect.succeed(answer("unsupported", null))
              : decodeListResult(result.structuredContent).pipe(
                  Effect.map((page) => answer("ok", page)),
                  Effect.orElseSucceed(() => answer("unsupported", null)),
                ),
          ),
          Effect.catchTags({
            PeerCallError: (error) =>
              Effect.succeed(
                answer(error.status === "not_linked" ? "offline" : error.status, null),
              ),
            PeerEnvironmentError: () => Effect.succeed(answer("offline", null)),
          }),
        );
    },
    { concurrency: 4 },
  );
  const server = yield* Effect.serviceOption(ServerEnvironment.ServerEnvironment);
  const localLabel = Option.isSome(server)
    ? (yield* server.value.getDescriptor).label
    : "This environment";
  return {
    champions: [
      ...local.champions.map((champion) => ({
        ...champion,
        environmentId: scope.environmentId,
        environmentLabel: localLabel,
      })),
      ...answers.flatMap((answer) =>
        (answer.page?.champions ?? []).map((champion) => ({
          ...champion,
          environmentId: answer.environmentId,
          environmentLabel: answer.label,
        })),
      ),
    ],
    environments: answers.map(({ page: _page, ...status }) => status),
  };
});
