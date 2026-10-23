// @effect-diagnostics nodeBuiltinImport:off - The agent CLI uses HOME and stdin.
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeFSP from "node:fs/promises";

import {
  AgentRolesInput,
  AgentSessionAttachInput,
  AgentTaskOutcomeInput,
  EnvironmentId,
  ExperimentOutcomeInput,
  ExperimentWorkAllocationInput,
  ExperimentWorkEvidenceInput,
  ExperimentWorkEnrollInput,
  ExperimentWorkReadInput,
  OrchestratorMcpDelegateTaskInput,
  OrchestratorMcpTaskCancelInput,
  OrchestratorMcpTaskStatusInput,
  OrchestratorMcpThreadReadInput,
} from "@t3tools/contracts";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { Command, Flag } from "effect/cli";
import * as CliError from "effect/cli/CliError";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as AgentCliClient from "./AgentCliClient.ts";

const endpointFlag = Flag.String("endpoint").pipe(
  Flag.withDescription("T3 server URL to connect to."),
);
const credentialsDirFlag = Flag.String("credentials-dir").pipe(
  Flag.withDescription("Absolute directory for this CLI's private credentials."),
  Flag.optional,
);
const requestFileFlag = Flag.String("request-file").pipe(
  Flag.withDescription("JSON request file, or '-' to read JSON from stdin."),
  Flag.optional,
);
const taskIdFlag = Flag.String("task-id").pipe(Flag.withDescription("Delegated task id."));
const outputSchema = Schema.fromJsonString(Schema.Unknown);
const jsonInputSchema = Schema.fromJsonString(Schema.Unknown);
const decodeJson = Schema.decodeUnknownSync(jsonInputSchema);
const decodeEvidenceStatus = Schema.decodeUnknownSync(
  Schema.Struct({ childThreadId: Schema.optional(Schema.String) }),
);
const userError = (userMessage: string, cause: unknown = userMessage) =>
  new CliError.UserError({ cause, userMessage });
const isAgentCliError = Schema.is(AgentCliClient.AgentCliError);
const isUserError = Schema.is(CliError.UserError);

export const readAgentRequest = <E, F>(
  source: string,
  readFile: (path: string) => Effect.Effect<string, E>,
  readStdin: () => Effect.Effect<string, F>,
) => (source === "-" ? readStdin() : readFile(source));

const readStdin = Effect.tryPromise({
  try: async () => {
    let value = "";
    for await (const chunk of process.stdin) value += String(chunk);
    return value;
  },
  catch: () => userError("Could not read request JSON."),
});

const requestData = Effect.fn("agentCli.requestData")(function* (source: Option.Option<string>) {
  if (Option.isNone(source))
    return yield* userError("Provide --request-file PATH or --request-file -.");
  const text = yield* readAgentRequest(
    source.value,
    (path) =>
      Effect.tryPromise({
        try: () => NodeFSP.readFile(path, "utf8"),
        catch: () => userError("Could not read request JSON."),
      }),
    () => readStdin,
  );
  return yield* Effect.try({
    try: () => decodeJson(text),
    catch: () => userError("Request file must contain valid JSON."),
  });
});

export const decodeAgentRequest = <A, S extends Schema.ConstraintDecoder<A>>(
  schema: S,
  value: unknown,
) =>
  Schema.decodeUnknownEffect(schema)(value).pipe(
    Effect.mapError(() => userError("Request JSON does not match the command schema.")),
  );

export const callAgentTool = (
  client: Pick<AgentCliClient.AgentCliClient["Service"], "call">,
  endpoint: string,
  tool: string,
  schema: Schema.ConstraintDecoder<unknown>,
  value: unknown,
  normalize: (args: unknown) => unknown = (args) => args,
) =>
  decodeAgentRequest(schema, value).pipe(
    Effect.flatMap((args) =>
      client.call(endpoint, tool, normalize(args) as Readonly<Record<string, unknown>>),
    ),
  );

const jsonOutput = (value: unknown) =>
  Schema.encodeUnknownEffect(outputSchema)(value).pipe(
    Effect.mapError(() => userError("The server returned an unsupported result.")),
    Effect.flatMap((json) => Console.log(json)),
  );

export const resolveAgentCredentialsDirectory = (
  directory: Option.Option<string>,
  home = NodeOS.homedir(),
) => (Option.isSome(directory) ? directory.value : NodePath.join(home, ".t3", "agent-clients"));

const credentialsLayer = (directory: Option.Option<string>) => {
  const path = resolveAgentCredentialsDirectory(directory);
  if (!NodePath.isAbsolute(path))
    return Effect.fail(userError("--credentials-dir must be an absolute path."));
  return Effect.succeed(ServerSecretStore.layerAtDirectory(path));
};

/**
 * Request-parsing failures are already user-facing; masking them as a credential problem
 * would send the caller to the wrong fix.
 */
export const toAgentCommandError = (error: unknown) =>
  isUserError(error)
    ? error
    : userError(
        isAgentCliError(error)
          ? error.message
          : "T3 agent command failed. Check the endpoint and local credentials.",
      );

const withClient = Effect.fn("agentCli.withClient")(function* <A, E>(
  directory: Option.Option<string>,
  run: (client: AgentCliClient.AgentCliClient["Service"]) => Effect.Effect<A, E>,
) {
  const layer = yield* credentialsLayer(directory);
  return yield* Effect.gen(function* () {
    const client = yield* AgentCliClient.AgentCliClient;
    return yield* run(client);
  }).pipe(Effect.provide(Layer.provideMerge(AgentCliClient.layer, layer)));
}, Effect.mapError(toAgentCommandError));

const loginCommand = Command.make("login", {
  endpoint: endpointFlag,
  credentialsDir: credentialsDirFlag,
}).pipe(
  Command.withDescription("Authorize this CLI with a T3 server."),
  Command.withHandler((flags) =>
    withClient(flags.credentialsDir, (client) =>
      client
        .login({
          endpoint: flags.endpoint,
          showAuthorization: (url) =>
            Console.error(`Open this authorization URL in a browser:\n${url}`),
        })
        .pipe(Effect.flatMap(jsonOutput)),
    ),
  ),
);

const logoutCommand = Command.make("logout", {
  endpoint: endpointFlag,
  credentialsDir: credentialsDirFlag,
}).pipe(
  Command.withDescription("Remove this CLI's local credentials for a T3 server."),
  Command.withHandler((flags) =>
    withClient(flags.credentialsDir, (client) =>
      client.logout(flags.endpoint).pipe(Effect.flatMap(jsonOutput)),
    ),
  ),
);

const identityCommand = Command.make("identity", {
  endpoint: endpointFlag,
  credentialsDir: credentialsDirFlag,
}).pipe(
  Command.withDescription("Show the authenticated server identity."),
  Command.withHandler((flags) =>
    withClient(flags.credentialsDir, (client) =>
      client.identity(flags.endpoint).pipe(Effect.flatMap(jsonOutput)),
    ),
  ),
);

const actionCommand = (
  name: string,
  tool: string,
  schema: Schema.ConstraintDecoder<unknown>,
  normalize: (args: unknown) => unknown = (args) => args,
) =>
  Command.make(name, {
    endpoint: endpointFlag,
    credentialsDir: credentialsDirFlag,
    requestFile: requestFileFlag,
  }).pipe(
    Command.withDescription(`Call ${tool} with a JSON request.`),
    Command.withHandler((flags) =>
      withClient(flags.credentialsDir, (client) =>
        Effect.gen(function* () {
          const raw = yield* requestData(flags.requestFile);
          let args = yield* decodeAgentRequest(schema, raw);
          if (
            tool === "agent_session_attach" &&
            typeof args === "object" &&
            args !== null &&
            !("environmentId" in args)
          ) {
            const identity = yield* client.identity(flags.endpoint);
            args = yield* decodeAgentRequest(AgentSessionAttachInput, {
              ...args,
              environmentId: identity.environmentId,
            });
          }
          yield* callAgentTool(client, flags.endpoint, tool, schema, args, normalize).pipe(
            Effect.flatMap(jsonOutput),
          );
        }),
      ),
    ),
  );

const attachCommand = actionCommand(
  "attach",
  "agent_session_attach",
  Schema.Struct({
    ...AgentSessionAttachInput.fields,
    environmentId: Schema.optional(EnvironmentId),
  }),
);
const rolesCommand = actionCommand("roles", "agent_roles", AgentRolesInput);
const submitCommand = actionCommand("submit", "delegate_task", OrchestratorMcpDelegateTaskInput);
const outcomeCommand = actionCommand("outcome", "agent_task_outcome", AgentTaskOutcomeInput).pipe(
  Command.withDescription(
    "Record a self-reported outcome using an assignmentId returned by submit.",
  ),
);
const workEnrollCommand = actionCommand("work-enroll", "t3_work_enroll", ExperimentWorkEnrollInput);
const workAllocateCommand = actionCommand(
  "work-allocate",
  "t3_work_allocate",
  ExperimentWorkAllocationInput,
);
const workEvidenceCommand = actionCommand(
  "work-evidence",
  "t3_work_evidence",
  ExperimentWorkEvidenceInput,
);
const workReadCommand = actionCommand("work-read", "t3_work_read", ExperimentWorkReadInput);
const workOutcomeCommand = actionCommand(
  "work-outcome",
  "t3_work_outcome",
  ExperimentOutcomeInput,
  (value) => ({ ...(value as Record<string, unknown>), source: "self-report" }),
);

const statusCommand = Command.make("status", {
  endpoint: endpointFlag,
  credentialsDir: credentialsDirFlag,
  taskId: taskIdFlag,
}).pipe(
  Command.withDescription("Read delegated task status."),
  Command.withHandler((flags) =>
    withClient(flags.credentialsDir, (client) =>
      decodeAgentRequest(OrchestratorMcpTaskStatusInput, { taskId: flags.taskId }).pipe(
        Effect.flatMap((args) =>
          client.call(flags.endpoint, "task_status", args).pipe(Effect.flatMap(jsonOutput)),
        ),
      ),
    ),
  ),
);

const waitCommand = Command.make("wait", {
  endpoint: endpointFlag,
  credentialsDir: credentialsDirFlag,
  taskId: taskIdFlag,
  timeoutMs: Flag.Int("timeout-ms").pipe(
    Flag.withSchema(Schema.Int),
    Flag.withDefault(60_000),
    Flag.withDescription("Wait budget from 1 to 3600000 milliseconds."),
  ),
}).pipe(
  Command.withDescription("Wait for delegated task status."),
  Command.withHandler((flags) =>
    withClient(flags.credentialsDir, (client) =>
      decodeAgentRequest(OrchestratorMcpTaskStatusInput, {
        taskId: flags.taskId,
        timeoutMs: flags.timeoutMs,
      }).pipe(
        Effect.flatMap((args) =>
          client.call(flags.endpoint, "task_status", args).pipe(Effect.flatMap(jsonOutput)),
        ),
      ),
    ),
  ),
);

const cancelCommand = Command.make("cancel", {
  endpoint: endpointFlag,
  credentialsDir: credentialsDirFlag,
  taskId: taskIdFlag,
  requestId: Flag.String("request-id").pipe(
    Flag.withDescription("Stable request id for safe retries."),
  ),
}).pipe(
  Command.withDescription("Request cancellation of a delegated task."),
  Command.withHandler((flags) =>
    withClient(flags.credentialsDir, (client) =>
      decodeAgentRequest(OrchestratorMcpTaskCancelInput, {
        taskId: flags.taskId,
        clientRequestId: flags.requestId,
      }).pipe(
        Effect.flatMap((args) =>
          client.call(flags.endpoint, "task_cancel", args).pipe(Effect.flatMap(jsonOutput)),
        ),
      ),
    ),
  ),
);

const evidenceCommand = Command.make("evidence", {
  endpoint: endpointFlag,
  credentialsDir: credentialsDirFlag,
  taskId: taskIdFlag,
}).pipe(
  Command.withDescription("Read task status and its owned child thread history."),
  Command.withHandler((flags) =>
    withClient(flags.credentialsDir, (client) =>
      client.call(flags.endpoint, "task_status", { taskId: flags.taskId }).pipe(
        Effect.flatMap((status) => {
          const decoded = Effect.try({
            try: () => decodeEvidenceStatus(status),
            catch: () => userError("The server returned unsupported task status."),
          });
          return decoded.pipe(
            Effect.flatMap(({ childThreadId }) =>
              childThreadId === undefined
                ? jsonOutput({ taskId: flags.taskId, status, childThreadId: null, thread: null })
                : decodeAgentRequest(OrchestratorMcpThreadReadInput, {
                    threadId: childThreadId,
                  }).pipe(
                    Effect.flatMap((args) => client.call(flags.endpoint, "t3_thread_read", args)),
                    Effect.flatMap((thread) =>
                      jsonOutput({ taskId: flags.taskId, status, childThreadId, thread }),
                    ),
                  ),
            ),
          );
        }),
      ),
    ),
  ),
);

export const agentCommand = Command.make("agent").pipe(
  Command.withDescription("Manage and use authenticated T3 agent services."),
  Command.withSubcommands([
    loginCommand,
    logoutCommand,
    identityCommand,
    attachCommand,
    rolesCommand,
    submitCommand,
    outcomeCommand,
    workEnrollCommand,
    workAllocateCommand,
    workEvidenceCommand,
    workReadCommand,
    workOutcomeCommand,
    statusCommand,
    waitCommand,
    cancelCommand,
    evidenceCommand,
  ]),
);
