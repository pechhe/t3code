import { DEFAULT_SERVER_SETTINGS, type ServerSettings } from "@t3tools/contracts";
import {
  noCompatibilityPolicy,
  type ProviderCompatibilityLookup,
} from "@t3tools/provider-core/server/compatibility";
import * as ProviderHost from "@t3tools/provider-core/server/ProviderHost";
import { applyServerSettingsPatch } from "@t3tools/shared/serverSettings";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";

export interface TestProviderHostOptions {
  readonly cwd?: string;
  readonly settings?: ServerSettings;
  readonly runBackgroundWork?: boolean;
  readonly compatibility?: ProviderCompatibilityLookup;
}

export class TestProviderHostSettings extends Context.Service<
  TestProviderHostSettings,
  { readonly set: (settings: ServerSettings) => Effect.Effect<void> }
>()("@t3tools/provider-testing/TestProviderHost/TestProviderHostSettings") {}

export const layer = (
  options: TestProviderHostOptions = {},
): Layer.Layer<
  ProviderHost.ProviderHost | TestProviderHostSettings,
  never,
  FileSystem.FileSystem | Path.Path
> =>
  Layer.effectContext(
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const baseDir = yield* fileSystem
        .makeTempDirectoryScoped({ prefix: "t3-provider-host-" })
        .pipe(Effect.orDie);
      const stateDir = path.join(baseDir, "userdata");
      const providerStatusCacheDir = path.join(baseDir, "caches");
      const attachmentsDir = path.join(stateDir, "attachments");
      for (const directory of [stateDir, providerStatusCacheDir, attachmentsDir]) {
        yield* fileSystem.makeDirectory(directory, { recursive: true }).pipe(Effect.orDie);
      }
      const settings = yield* Ref.make(options.settings ?? DEFAULT_SERVER_SETTINGS);
      const changesPubSub = yield* Effect.acquireRelease(
        PubSub.unbounded<ServerSettings>(),
        PubSub.shutdown,
      );
      const publishSettings = (next: ServerSettings) =>
        Ref.set(settings, next).pipe(
          Effect.andThen(PubSub.publish(changesPubSub, next)),
          Effect.as(next),
        );
      const credentials = new Map<string, Uint8Array>();
      const host = ProviderHost.ProviderHost.of({
        compatibility: options.compatibility ?? noCompatibilityPolicy,
        paths: {
          cwd: options.cwd ?? process.cwd(),
          baseDir,
          stateDir,
          providerStatusCacheDir,
          attachmentsDir,
        },
        settings: {
          get: Ref.get(settings),
          update: (patch) =>
            Ref.get(settings).pipe(
              Effect.map((current) => applyServerSettingsPatch(current, patch)),
              Effect.flatMap(publishSettings),
            ),
          withSnapshot: (use) => Ref.get(settings).pipe(Effect.flatMap(use)),
          changes: Stream.fromPubSub(changesPubSub),
          subscribe: PubSub.subscribe(changesPubSub).pipe(
            Effect.map((subscription) => Stream.fromSubscription(subscription)),
          ),
        },
        shouldRunBackgroundWork: Effect.fn("ProviderHost.shouldRunBackgroundWork")(function () {
          return Effect.succeed(options.runBackgroundWork ?? true);
        }),
        resolveAttachmentPath: (attachment) => path.join(attachmentsDir, attachment.id),
        credentials: Effect.fn("ProviderHost.credentials")(function (namespace, bindingId) {
          return Effect.sync(() => {
            const key = `${namespace}:${bindingId}`;
            return {
              binding: { owner: "t3" as const, key },
              get: Effect.sync(() => Option.fromUndefinedOr(credentials.get(key))),
              set: (value: Uint8Array) => Effect.sync(() => void credentials.set(key, value)),
              remove: Effect.sync(() => void credentials.delete(key)),
            };
          });
        }),
      });
      return Context.make(ProviderHost.ProviderHost, host).pipe(
        Context.add(TestProviderHostSettings, {
          set: (next) => publishSettings(next).pipe(Effect.asVoid),
        }),
      );
    }),
  );
