import type { EnvironmentId, SlipJayRunnerOverview, VcsSlipJayPromotion } from "@t3tools/contracts";
import { AsyncResult, type AtomRegistry } from "effect/reactivity";
import { CircleAlertIcon, CircleCheckIcon } from "lucide-react";

import { getClientSettings, subscribeClientSettings } from "../hooks/useSettings";
import { environmentSummaries } from "../state/presentation";
import { vcsEnvironment } from "../state/vcs";
import {
  hasDesktopNotifications,
  hasNotificationSound,
  playNotificationSound,
} from "../threadNotifications";
import {
  createReleaseAnnouncementGate,
  resolvePromotionFailures,
  resolveReleaseOutcomes,
  type SlipJayReleaseOutcome,
} from "./SlipJayBox.logic";
import { toastManager } from "./ui/toast";

const repositoryName = (repo: string) => repo.slice(repo.indexOf("/") + 1);

const shouldAnnounce = createReleaseAnnouncementGate();

function announce(outcome: SlipJayReleaseOutcome) {
  if (!shouldAnnounce(outcome)) return;
  const key = `${outcome.repo}@${outcome.commitId}:${outcome.result}`;
  const released = outcome.result === "released";
  const title = released
    ? "Released to production"
    : outcome.result === "release_failed"
      ? "Release failed"
      : outcome.result === "failed"
        ? "Production deploy failed"
        : "Production deploy rolled back";
  const commit = outcome.commitId === "" ? "" : ` ${outcome.commitId.slice(0, 7)}`;
  const body = `${repositoryName(outcome.repo)}${commit}${
    outcome.reason === null ? "" : `: ${outcome.reason}`
  }`;
  const { notificationMode: mode, inAppNotificationsEnabled } = getClientSettings();
  const looking = document.visibilityState === "visible" && document.hasFocus();
  if (hasNotificationSound(mode)) {
    void playNotificationSound(released ? "completion" : "input", () =>
      hasNotificationSound(getClientSettings().notificationMode),
    );
  }
  if (looking) {
    if (!inAppNotificationsEnabled) return;
    toastManager.add({
      type: released ? "success" : "error",
      title,
      description: body,
      data: {
        hideCopyButton: true,
        leadingIcon: released ? (
          <CircleCheckIcon aria-hidden className="size-4 text-success-foreground" />
        ) : (
          <CircleAlertIcon aria-hidden className="size-4 text-destructive-foreground" />
        ),
      },
    });
    return;
  }
  if (
    !hasDesktopNotifications(mode) ||
    typeof Notification === "undefined" ||
    Notification.permission !== "granted"
  )
    return;
  try {
    const notification = new Notification(title, {
      body,
      tag: `slipjay-release:${key}`,
      silent: true,
    });
    notification.addEventListener("click", () => {
      notification.close();
      window.focus();
      void window.desktopBridge?.revealWindow().catch(() => undefined);
    });
  } catch {
    // Some browsers expose Notification but reject desktop presentation.
  }
}

/**
 * Announces every production release or failed deploy the runner reports in any connected
 * environment, whoever started it. App-lifetime.
 */
export function startSlipJayReleaseNotifications(registry: AtomRegistry.AtomRegistry): () => void {
  const watched = new Map<EnvironmentId, () => void>();
  const watch = (environmentId: EnvironmentId) => {
    let previous: SlipJayRunnerOverview | null = null;
    let previousPromotions: ReadonlyArray<VcsSlipJayPromotion> | null = null;
    const stopRunner = registry.subscribe(
      vcsEnvironment.slipJayRunner({ environmentId, input: {} }),
      (result) => {
        const overview = AsyncResult.getOrElse(result, () => null);
        if (overview === null) return;
        if (previous !== null)
          for (const outcome of resolveReleaseOutcomes(previous, overview)) announce(outcome);
        previous = overview;
      },
      { immediate: true },
    );
    // A release SlipJay refuses before any deploy begins leaves no attempt for the runner to report.
    const stopPromotions = registry.subscribe(
      vcsEnvironment.slipJayPromotions({ environmentId, input: {} }),
      (result) => {
        const promotions = AsyncResult.getOrElse(result, () => null);
        if (promotions === null) return;
        if (previousPromotions !== null)
          for (const outcome of resolvePromotionFailures(previousPromotions, promotions))
            announce(outcome);
        previousPromotions = promotions;
      },
      { immediate: true },
    );
    return () => {
      stopRunner();
      stopPromotions();
    };
  };
  const sync = () => {
    const { notificationMode, inAppNotificationsEnabled } = getClientSettings();
    const ids = new Set(
      notificationMode !== "off" || inAppNotificationsEnabled
        ? registry.get(environmentSummaries.environmentIdsAtom)
        : [],
    );
    for (const [environmentId, stop] of watched) {
      if (ids.has(environmentId)) continue;
      stop();
      watched.delete(environmentId);
    }
    for (const environmentId of ids) {
      if (!watched.has(environmentId)) watched.set(environmentId, watch(environmentId));
    }
  };
  const unsubscribeSettings = subscribeClientSettings(sync);
  const unsubscribeEnvironments = registry.subscribe(environmentSummaries.environmentIdsAtom, sync);
  sync();
  return () => {
    unsubscribeSettings();
    unsubscribeEnvironments();
    for (const stop of watched.values()) stop();
    watched.clear();
  };
}
