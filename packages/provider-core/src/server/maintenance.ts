import type { ProviderDriverKind } from "@t3tools/contracts";
import type * as Effect from "effect/Effect";
import type * as HttpClient from "effect/http/HttpClient";

import type * as ProviderLatestVersions from "./ProviderLatestVersions.ts";

/** Something the provider's update command also brings current, such as a Pi package. */
export interface ProviderComponentUpdate {
  readonly name: string;
  readonly currentVersion: string;
  readonly latestVersion: string;
}

export interface ProviderMaintenanceCapabilities {
  readonly provider: ProviderDriverKind;
  readonly packageName: string | null;
  readonly update: ProviderMaintenanceCommandAction | null;
  /** undefined defers to npm; null means the installer could not determine the latest version. */
  readonly latestVersion?: string | null;
  /**
   * Deferred until update checks are enabled; `null` falls back to
   * `latestVersion`, then npm.
   */
  readonly lookupLatestVersion?: Effect.Effect<string | null>;
  /** Separates installer release channels that share an update command. */
  readonly latestVersionCacheKey?: string;
  readonly compareVersions?: (current: string, latest: string) => number;
  /** Resolved executable path for advisories when no update command is proven. */
  readonly installPath?: string;
  /** Displayed for manual updates; never executed by T3 Code. */
  readonly manualCommand?: string;
  /**
   * The version the update command manages, when the CLI reports another (Pi-Bolt wraps Pi).
   * Its releases are not the runtime's, so compatibility policy never rates them.
   */
  readonly installedVersion?: string | null;
  /** Latest-version cache keys the component lookup reads, dropped with the provider's own. */
  readonly componentCacheKeys?: ReadonlyArray<string>;
  /**
   * Components behind their latest release; any makes the provider `behind_latest`. `null` means
   * a component could not be checked, so with nothing found behind the advisory stays `unknown`.
   */
  readonly lookupComponentUpdates?: Effect.Effect<
    ReadonlyArray<ProviderComponentUpdate> | null,
    never,
    HttpClient.HttpClient | ProviderLatestVersions.ProviderLatestVersions
  >;
}

export interface ProviderMaintenanceCommandAction {
  readonly command: string;
  readonly executable: string;
  readonly args: ReadonlyArray<string>;
  readonly lockKey: string;
  /** The provider's environment, including its PATH and custom home. */
  readonly env?: NodeJS.ProcessEnv;
}
