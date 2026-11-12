import * as HostProcess from "@t3tools/shared/HostProcess";
import * as NodeModule from "node:module";
// @effect-diagnostics-next-line nodeBuiltinImport:off -- The token file must be checked through the same open descriptor that is read.
import * as NodeFSP from "node:fs/promises";
// @effect-diagnostics-next-line nodeBuiltinImport:off -- This path is used inside the lazy native SDK boundary.
import * as NodePath from "node:path";
// @effect-diagnostics-next-line nodeBuiltinImport:off -- Keychain output stays inside this redacted SDK boundary.
import * as NodeChildProcess from "node:child_process";
import * as NodeUtil from "node:util";
import { SecretManagementError } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Schema from "effect/Schema";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Semaphore from "effect/Semaphore";
import * as Schedule from "effect/Schedule";

export interface BwsSecret {
  readonly id: string;
  readonly key: string;
  readonly projectId?: string | null | undefined;
  readonly value: string;
  readonly note: string;
}

export class BwsClient extends Context.Service<
  BwsClient,
  {
    readonly projectId: Effect.Effect<string, SecretManagementError>;
    readonly list: () => Effect.Effect<
      ReadonlyArray<{ readonly id: string; readonly key: string; readonly projectId: string }>,
      SecretManagementError
    >;
    readonly get: (id: string) => Effect.Effect<BwsSecret, SecretManagementError>;
    readonly create: (
      key: string,
      value: string,
    ) => Effect.Effect<BwsSecret, SecretManagementError>;
    readonly update: (
      secret: BwsSecret,
      key: string,
      value: string,
    ) => Effect.Effect<BwsSecret, SecretManagementError>;
    readonly remove: (id: string) => Effect.Effect<void, SecretManagementError>;
  }
>()("t3/secrets/BwsClient") {}

const unavailable = () => new SecretManagementError({ reason: "unavailable" });
class BwsRateLimit extends Schema.TaggedError<BwsRateLimit>()("BwsRateLimit", {}) {}
const isBwsRateLimit = Schema.is(BwsRateLimit);

function redactFailure(cause: unknown) {
  const message = cause instanceof Error ? cause.message : typeof cause === "string" ? cause : "";
  return /\b429\b|too many requests|rate[\s_-]*limit/i.test(message)
    ? new BwsRateLimit()
    : unavailable();
}
const inventoryRead = Effect.fn("BwsClient.inventoryRead")(<A>(run: () => Promise<A>) =>
  Effect.tryPromise({ try: run, catch: redactFailure }).pipe(
    Effect.retry({
      while: isBwsRateLimit,
      times: 2,
      schedule: Schedule.exponential("2 seconds"),
    }),
    Effect.mapError(unavailable),
  ),
);
const runFile = NodeUtil.promisify(NodeChildProcess.execFile);
// The native SDK stays external; single-executables resolve its files through require.
const requireBws = NodeModule.createRequire(import.meta.url);

export function selectDefaultProject(input: unknown): string {
  if (!Array.isArray(input)) throw new Error("invalid project list");
  const matches = input.filter(
    (entry): entry is { id: string; name: string } =>
      entry !== null &&
      typeof entry === "object" &&
      typeof entry.id === "string" &&
      entry.name === "localdev",
  );
  if (matches.length !== 1) throw new Error("configure T3CODE_BWS_PROJECT_ID");
  return matches[0]!.id;
}

async function accessToken(
  environment: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
  home: string,
  uid: number | undefined,
): Promise<string> {
  if (environment.BWS_ACCESS_TOKEN) return environment.BWS_ACCESS_TOKEN;
  if (platform === "darwin") {
    const { stdout } = await runFile("security", [
      "find-generic-password",
      "-s",
      "bws-access-token",
      "-w",
    ]);
    return stdout.replace(/\r?\n$/, "");
  }
  if (platform !== "linux") throw new Error("unsupported platform");
  const file = await NodeFSP.open(NodePath.join(home, ".config/bws/access-token"), "r");
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.uid !== uid || (stat.mode & 0o077) !== 0)
      throw new Error("insecure token file");
    return (await file.readFile("utf8")).replace(/\r?\n$/, "");
  } finally {
    await file.close();
  }
}

export const layer = Layer.effect(
  BwsClient,
  Effect.gen(function* () {
    const environment = yield* HostProcess.Environment;
    const platform = yield* HostProcess.Platform;
    const home = yield* HostProcess.HomeDirectory;
    const uid = yield* HostProcess.UserId;
    const resolveProjectId = async () => {
      if (environment.T3CODE_BWS_PROJECT_ID) return environment.T3CODE_BWS_PROJECT_ID;
      const token = await accessToken(environment, platform, home, uid);
      const { stdout } = await runFile("bws", ["project", "list"], {
        env: { ...environment, BWS_ACCESS_TOKEN: token },
      });
      return selectDefaultProject(JSON.parse(stdout));
    };
    const selectedProject = yield* Ref.make<string | undefined>(undefined);
    const projectLock = yield* Semaphore.make(1);
    const projectId = Effect.gen(function* () {
      const selected = yield* Ref.get(selectedProject);
      if (selected !== undefined) return selected;
      const resolved = yield* Effect.tryPromise({ try: resolveProjectId, catch: unavailable });
      yield* Ref.set(selectedProject, resolved);
      return resolved;
    }).pipe(projectLock.withPermits(1));
    const operation = <A>(
      f: (
        sdk: InstanceType<typeof import("@bitwarden/sdk-napi").BitwardenClient>,
        org: string,
        selectedProjectId: string,
      ) => Promise<A>,
    ) =>
      Effect.flatMap(projectId, (selectedProjectId) =>
        Effect.tryPromise({
          try: async () => {
            const { BitwardenClient } = requireBws(
              "@bitwarden/sdk-napi",
            ) as typeof import("@bitwarden/sdk-napi");
            const sdk = new BitwardenClient();
            await sdk.auth().loginAccessToken(await accessToken(environment, platform, home, uid));
            const project = await sdk.projects().get(selectedProjectId);
            return f(sdk, project.organizationId, project.id);
          },
          catch: unavailable,
        }),
      );
    // A zero TTL shares pending reads without retaining stale inventory after completion.
    const inventory = yield* Effect.gen(function* () {
      const { sdk, org, selectedProjectId } = yield* operation(
        async (sdk, org, selectedProjectId) => ({
          sdk,
          org,
          selectedProjectId,
        }),
      );
      const identifiers = (yield* inventoryRead(() => sdk.secrets().list(org))).data;
      const entries: Array<{ id: string; key: string; projectId: string }> = [];
      for (let i = 0; i < identifiers.length; i += 100) {
        const ids = identifiers.slice(i, i + 100).map((secret) => secret.id);
        const batch = (yield* inventoryRead(() => sdk.secrets().getByIds(ids))).data;
        if (
          batch.length !== ids.length ||
          new Set(batch.map((secret) => secret.id)).size !== ids.length ||
          batch.some((secret) => !ids.includes(secret.id))
        )
          return yield* unavailable();
        for (const secret of batch)
          if (secret.projectId === selectedProjectId)
            entries.push({ id: secret.id, key: secret.key, projectId: selectedProjectId });
      }
      return entries;
    }).pipe(Effect.cachedWithTTL(0));
    return BwsClient.of({
      projectId,
      list: Effect.fn("BwsClient.list")(() => inventory),
      get: Effect.fn("BwsClient.get")((id: string) => operation((sdk) => sdk.secrets().get(id))),
      create: Effect.fn("BwsClient.create")((key: string, value: string) =>
        operation((sdk, org, selectedProjectId) =>
          sdk.secrets().create(org, key, value, "", [selectedProjectId]),
        ),
      ),
      update: Effect.fn("BwsClient.update")((secret: BwsSecret, key: string, value: string) =>
        operation((sdk, org, selectedProjectId) => {
          if (!secret.projectId || secret.projectId !== selectedProjectId)
            throw new Error("out of scope");
          return sdk.secrets().update(org, secret.id, key, value, secret.note, [secret.projectId]);
        }),
      ),
      remove: Effect.fn("BwsClient.remove")((id: string) =>
        operation(async (sdk) => {
          const result = await sdk.secrets().delete([id]);
          if (result.data.length !== 1 || result.data[0]?.id !== id || result.data[0].error)
            throw new Error("delete failed");
        }),
      ),
    });
  }),
);
