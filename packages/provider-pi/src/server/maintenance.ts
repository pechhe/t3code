import { ProviderDriverKind } from "@t3tools/contracts";
import { compareSemverVersions } from "@t3tools/shared/semver";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import {
  makePackageManagedProviderMaintenanceResolver,
  makeProviderMaintenanceCapabilities,
  type ProviderComponentUpdate,
  type ProviderMaintenanceCapabilitiesResolver,
  type ProviderMaintenanceResolutionContext,
  type ProviderMaintenanceResolverServices,
  resolveLatestNpmVersion,
  runProbe,
} from "@t3tools/provider-core/server/maintenanceResolver";
import { piAgentDirectory } from "./compaction.ts";

const DRIVER_KIND = ProviderDriverKind.make("pi");
const PI_BOLT_PACKAGE = "pi-bolt";

const NODE_PI = makePackageManagedProviderMaintenanceResolver({
  provider: DRIVER_KIND,
  npmPackageName: "@earendil-works/pi-coding-agent",
  mise: { tool: "pi" },
  nativeUpdate: { args: ["update", "--self"] },
});

/** Pi-Bolt prints Pi's version first: `1.5.2 (Pi-Bolt 1.2.1, linux-x64, JIT off)`. */
export function parsePiBoltVersion(output: string): string | null {
  return output.match(/\(Pi-Bolt v?(\d+\.\d+\.\d+(?:-[\w.]+)?)\b/)?.[1] ?? null;
}

const PiSettingsPackages = Schema.Struct({
  packages: Schema.optional(
    Schema.Array(Schema.Union([Schema.String, Schema.Struct({ source: Schema.String })])),
  ),
});
const decodePiSettingsPackages = Schema.decodeUnknownOption(
  Schema.fromJsonString(PiSettingsPackages),
);
const PackageVersion = Schema.Struct({ version: Schema.String });
const decodePackageVersion = Schema.decodeUnknownOption(Schema.fromJsonString(PackageVersion));

/** `npm:name` with no version; Pi pins exact versions and keeps ranges, so neither is offered. */
export function unversionedNpmPackageName(source: string): string | null {
  if (!source.startsWith("npm:")) return null;
  const spec = source.slice("npm:".length).trim();
  const versionAt = spec.indexOf("@", spec.startsWith("@") ? 1 : 0);
  return spec.length === 0 || versionAt >= 0 ? null : spec;
}

/** The user-scope npm packages Pi loads, as Pi's own startup check sees them. */
const readPiNpmPackageNames = Effect.fn("PiMaintenance.readPiNpmPackageNames")(function* (
  agentDir: string,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const settings = yield* fileSystem
    .readFileString(path.join(agentDir, "settings.json"))
    .pipe(Effect.orElseSucceed(() => ""));
  const packages = Option.match(decodePiSettingsPackages(settings), {
    onNone: () => [],
    onSome: (decoded) => decoded.packages ?? [],
  });
  return [
    ...new Set(
      packages.flatMap((entry) => {
        const name = unversionedNpmPackageName(typeof entry === "string" ? entry : entry.source);
        return name === null ? [] : [name];
      }),
    ),
  ];
});

const lookupPiPackageUpdates = (agentDir: string, packageNames: ReadonlyArray<string>) =>
  Effect.forEach(
    packageNames,
    Effect.fn("PiMaintenance.lookupPiPackageUpdate")(function* (name) {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const manifestPath = path.join(agentDir, "npm", "node_modules", name, "package.json");
      // Pi installs a missing package on its next start; until then there is nothing to update.
      if (!(yield* fileSystem.exists(manifestPath).pipe(Effect.orElseSucceed(() => true)))) {
        return [];
      }
      const installed = yield* fileSystem
        .readFileString(manifestPath)
        .pipe(Effect.orElseSucceed(() => ""));
      const decoded = decodePackageVersion(installed);
      if (Option.isNone(decoded)) return null;
      const currentVersion = decoded.value.version;
      const latestVersion = yield* resolveLatestNpmVersion(name);
      if (latestVersion === null) return null;
      return compareSemverVersions(currentVersion, latestVersion) < 0
        ? [{ name, currentVersion, latestVersion } satisfies ProviderComponentUpdate]
        : [];
    }),
    { concurrency: "unbounded" },
  ).pipe(
    Effect.map((results) => {
      const updates = results.flatMap((result) => result ?? []);
      // An unchecked package must not read as current; one found behind is still worth offering.
      return updates.length === 0 && results.includes(null) ? null : updates;
    }),
  );

/** Pi-Bolt installs through npm as `pi-bolt` and self-updates into `~/.pi-bolt`. */
export function isPiBoltCommandPath(commandPath: string): boolean {
  return /(?:^|[\\/])(?:\.?pi-bolt)(?:[\\/]|\.exe$|$)/i.test(commandPath);
}

const resolvePiBoltMaintenance = Effect.fn("PiMaintenance.resolvePiBolt")(function* (
  context: ProviderMaintenanceResolutionContext,
) {
  const services = yield* Effect.context<ProviderMaintenanceResolverServices>();
  const versionOutput = yield* runProbe(context.resolvedCommandPath, ["--version"], context.env);
  const installedVersion = versionOutput === null ? null : parsePiBoltVersion(versionOutput);
  const agentDir = piAgentDirectory(context.env);
  const packageNames = agentDir === null ? [] : yield* readPiNpmPackageNames(agentDir);
  const capabilities = makeProviderMaintenanceCapabilities({
    provider: DRIVER_KIND,
    packageName: PI_BOLT_PACKAGE,
    updateExecutable: context.resolvedCommandPath,
    // One action brings Pi-Bolt and every package current, in this instance's agent directory.
    updateArgs: ["update", "--all"],
    updateLockKey: `pi-bolt:${context.realCommandPath}`,
    env: context.env,
    platform: context.platform,
  });
  return {
    ...capabilities,
    installedVersion,
    ...(agentDir === null || packageNames.length === 0
      ? {}
      : {
          componentCacheKeys: packageNames,
          lookupComponentUpdates: lookupPiPackageUpdates(agentDir, packageNames).pipe(
            Effect.provideContext(services),
          ),
        }),
  };
});

export const PI_MAINTENANCE: ProviderMaintenanceCapabilitiesResolver = {
  resolve: (context) =>
    context !== null &&
    (isPiBoltCommandPath(context.realCommandPath) || isPiBoltCommandPath(context.binaryPath))
      ? resolvePiBoltMaintenance(context)
      : NODE_PI.resolve(context),
};
