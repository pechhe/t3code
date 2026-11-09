import type {
  SlipJayRunnerOperation,
  SlipJayRunnerOverview,
  SlipJayRunnerRelease,
  VcsSlipJayPromotion,
} from "@t3tools/contracts";
import { formatElapsedDurationLabel } from "~/timestampFormat";

/** `HH:mm` in the viewer's time zone, as the runner's times are shown in the box. */
const formatClock = (iso: string): string => {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false });
};

const sha7 = (commitId: string) => commitId.slice(0, 7);

/**
 * The screening lanes: one bar per lane the runner offers, busy while a landing screens in it.
 * A repository that screens one at a time (0 configured) has one lane. A runner that reports no
 * repositories offers as many lanes as its landings occupy, never fewer than one.
 */
export function resolveScreeningLanes(overview: SlipJayRunnerOverview): {
  lanes: boolean[];
  busy: number;
} {
  const screening = overview.serial.filter(
    (operation) =>
      operation.kind === "landing" &&
      operation.status === "running" &&
      operation.lane !== undefined,
  );
  if (overview.repositories.length === 0) {
    const total = Math.max(1, ...screening.map((operation) => operation.lane ?? 0));
    const lanes = Array.from({ length: total }, (_, index) =>
      screening.some((operation) => operation.lane === index + 1),
    );
    return { lanes, busy: lanes.filter(Boolean).length };
  }
  const lanes = overview.repositories.flatMap((repository) =>
    Array.from({ length: Math.max(1, repository.screeningLanes) }, (_, index) =>
      screening.some(
        (operation) => operation.repo === repository.repo && operation.lane === index + 1,
      ),
    ),
  );
  return { lanes, busy: lanes.filter(Boolean).length };
}

export type SlipJayPublishLane =
  | { kind: "idle" }
  | { kind: "held" }
  | { kind: "publishing"; operation: SlipJayRunnerOperation };

/** The publish lane: the landing publishing now, else held while paused with landings waiting, else idle. */
export function resolveSlipJayPublishLane(overview: SlipJayRunnerOverview): SlipJayPublishLane {
  const publishing = overview.serial.find(
    (operation) =>
      operation.kind === "landing" &&
      operation.status === "running" &&
      operation.stage === "publishing",
  );
  if (publishing !== undefined) return { kind: "publishing", operation: publishing };
  const waiting = overview.serial.some((operation) => operation.kind === "landing");
  return overview.paused && waiting ? { kind: "held" } : { kind: "idle" };
}

export type SlipJayTone = "ok" | "warn" | "bad" | "run" | "dim";

/** What the candidate waits on, as one plain sentence with its tone. */
export function resolveReleaseWaiting(release: SlipJayRunnerRelease): {
  tone: SlipJayTone;
  text: string;
  /** SlipJay's why, unless the sentence already says it. */
  detail: string | null;
} {
  const sentence = releaseSentence(release);
  const detail = release.waitingOn.detail;
  return {
    ...sentence,
    detail: detail && !sentence.text.includes(detail) ? detail : null,
  };
}

function releaseSentence(release: SlipJayRunnerRelease): { tone: SlipJayTone; text: string } {
  switch (release.waitingOn.kind) {
    case "up_to_date":
      return { tone: "ok", text: "Production is up to date" };
    case "paused":
      return { tone: "warn", text: "Held while the runner is paused" };
    case "images":
      return { tone: "warn", text: "Waiting on the release images" };
    case "audit": {
      const next = release.audit?.nextRunAt;
      const at = next === null || next === undefined ? "" : formatClock(next);
      return {
        tone: "warn",
        text:
          at === "" ? "Waiting on the nightly audit" : `Waiting on the nightly audit · runs ${at}`,
      };
    }
    case "verification":
      return { tone: "warn", text: "Waiting on verification" };
    case "deploy":
      return { tone: "run", text: "Releasing to production" };
    case "approval":
      return { tone: "warn", text: "Waiting on approval" };
    case "failed": {
      // SlipJay also files failed images, verification and withheld promotion under `failed`.
      const attempt = release.production.latestAttempt?.status;
      return attempt === "rolled_back"
        ? { tone: "bad", text: "Production deploy failed · rolled back" }
        : attempt === "failed"
          ? { tone: "bad", text: "Production deploy failed" }
          : {
              tone: "bad",
              text: release.waitingOn.detail
                ? `Release held: ${release.waitingOn.detail}`
                : "Release held",
            };
    }
  }
}

/**
 * One repository's release row: what is happening in a sentence, and what a press can do. A
 * failure stays until it is dismissed, retried or production no longer needs that release.
 */
export function resolveReleaseRow(
  release: SlipJayRunnerRelease,
  promotion: VcsSlipJayPromotion | null,
): {
  tone: SlipJayTone;
  text: string;
  detail: string | null;
  action: "release" | "retry" | "releasing" | null;
} {
  if (promotion?.status === "releasing") {
    const sha = promotion.candidate === null ? "" : sha7(promotion.candidate);
    return {
      tone: "run",
      text:
        sha === ""
          ? "Starting the release"
          : release.waitingOn.kind === "verification"
            ? `Verifying ${sha}, then releasing it`
            : `Releasing ${sha} to production`,
      detail: null,
      action: "releasing",
    };
  }
  if (promotion?.status === "failed" && release.waitingOn.kind !== "up_to_date") {
    return { tone: "bad", text: "Release failed", detail: promotion.reason, action: "retry" };
  }
  const { tone, text, detail } = resolveReleaseWaiting(release);
  const candidate =
    release.waitingOn.kind === "up_to_date" ||
    release.waitingOn.kind === "deploy" ||
    release.candidate === null
      ? ""
      : ` · ${sha7(release.candidate.commitId)}`;
  return {
    tone,
    text: `${text}${candidate}`,
    detail,
    action:
      release.waitingOn.kind === "up_to_date" || release.waitingOn.kind === "deploy"
        ? null
        : "release",
  };
}

/** The releases that failed and still matter, which the box's tag calls attention to. */
export function resolveFailedPromotions(
  overview: SlipJayRunnerOverview | null | undefined,
  promotions: ReadonlyArray<VcsSlipJayPromotion> | null | undefined,
): ReadonlyArray<VcsSlipJayPromotion> {
  return (promotions ?? []).filter(
    (promotion) =>
      promotion.status === "failed" &&
      overview?.repositories.find((repository) => repository.repo === promotion.repo)?.release
        ?.waitingOn.kind !== "up_to_date",
  );
}

/** What production runs, in one line; a newer failed or running attempt is only ever a note. */
export function resolveProductionLine(
  { production: { live, latestAttempt } }: SlipJayRunnerRelease,
  now: number = Date.now(),
): { tone: SlipJayTone; text: string; note: string | null } {
  const age = (iso: string) => formatElapsedDurationLabel(iso, now);
  const note =
    latestAttempt === null
      ? null
      : `${
          latestAttempt.status === "running"
            ? `Deploying ${sha7(latestAttempt.commitId)} · ${age(latestAttempt.at)}`
            : `Last attempt ${sha7(latestAttempt.commitId)} ${
                latestAttempt.status === "failed" ? "failed" : "rolled back"
              } ${age(latestAttempt.at)} ago`
        }${latestAttempt.reason ? ` (${latestAttempt.reason})` : ""}`;
  if (live === null) return { tone: "dim", text: "Production has nothing deployed", note };
  const health = live.healthy === null ? "" : live.healthy ? "healthy · " : "unhealthy · ";
  return {
    tone: live.healthy === false ? "bad" : "ok",
    text: `Production ${sha7(live.commitId)} · ${health}${age(live.deployedAt)}`,
    note,
  };
}

/** The footer: what landed and failed screening today, and the queue's state. */
export function resolveBoxFooter(overview: SlipJayRunnerOverview): {
  today: string;
  queue: string;
} {
  const landed = overview.repositories.reduce((sum, repo) => sum + repo.today.landed, 0);
  const failed = overview.repositories.reduce((sum, repo) => sum + repo.today.failedScreens, 0);
  const waiting = overview.serial.filter((operation) => operation.status === "queued").length;
  return {
    today: `Today ${landed} landed · ${failed} failed ${failed === 1 ? "screen" : "screens"}`,
    queue: waiting === 0 ? "no queue" : overview.paused ? `${waiting} held` : `${waiting} queued`,
  };
}
