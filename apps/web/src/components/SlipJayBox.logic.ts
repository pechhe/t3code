import type {
  SlipJayRunnerDeploy,
  SlipJayRunnerOperation,
  SlipJayRunnerOverview,
  SlipJayRunnerRelease,
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

export interface SlipJayReleaseStep {
  key: "images" | "audit" | "deploy";
  tone: SlipJayTone;
  label: string;
}

/** The Images / Audit / Deploy chips; none once production is up to date. */
export function resolveReleaseSteps(release: SlipJayRunnerRelease): SlipJayReleaseStep[] {
  if (release.waitingOn.kind === "up_to_date") return [];
  const steps: SlipJayReleaseStep[] = [];
  const { images, audit, production } = release;
  if (images !== null) {
    const at = images.at === null ? "" : ` ${formatClock(images.at)}`;
    steps.push(
      images.status === "built"
        ? { key: "images", tone: "ok", label: `Images built${at}` }
        : images.status === "building"
          ? { key: "images", tone: "run", label: "Images building" }
          : images.status === "failed"
            ? { key: "images", tone: "bad", label: `Images failed${at}` }
            : { key: "images", tone: "dim", label: "Images" },
    );
  }
  if (audit !== null) {
    const latest = audit.latest;
    steps.push(
      latest === null
        ? { key: "audit", tone: "dim", label: "Audit" }
        : latest.status === "green"
          ? { key: "audit", tone: "ok", label: `Audit green ${formatClock(latest.finishedAt)}` }
          : { key: "audit", tone: "bad", label: `Audit failed ${formatClock(latest.finishedAt)}` },
    );
  }
  const attempt = production.latestAttempt;
  steps.push(
    attempt === null
      ? { key: "deploy", tone: "dim", label: "Deploy" }
      : attempt.status === "running"
        ? { key: "deploy", tone: "run", label: "Deploying" }
        : {
            key: "deploy",
            tone: "bad",
            label: attempt.status === "failed" ? "Deploy failed" : "Rolled back",
          },
  );
  return steps;
}

export interface SlipJayEnvironmentRow {
  key: "production" | "images" | "staging";
  name: string;
  sha: string;
  tone: SlipJayTone;
  status: string;
  /** A quieter line under the row, such as the last production attempt. */
  note: string | null;
}

/** Production, the release images and, when skipped, staging. The latest attempt is only ever a note. */
export function resolveEnvironmentRows(
  release: SlipJayRunnerRelease,
  now: number = Date.now(),
  /** This repository's deploys, newest first, of which the staging ones fill the Staging row. */
  deploys: ReadonlyArray<SlipJayRunnerDeploy> = [],
): SlipJayEnvironmentRow[] {
  const age = (iso: string) => formatElapsedDurationLabel(iso, now);
  const { live, latestAttempt } = release.production;
  const attemptNote =
    latestAttempt === null
      ? null
      : `${
          latestAttempt.status === "running"
            ? `Deploying ${sha7(latestAttempt.commitId)} · ${age(latestAttempt.at)}`
            : `Last attempt ${sha7(latestAttempt.commitId)} ${
                latestAttempt.status === "failed" ? "failed" : "rolled back"
              } ${age(latestAttempt.at)} ago`
        }${latestAttempt.reason ? ` (${latestAttempt.reason})` : ""}`;
  const rows: SlipJayEnvironmentRow[] = [
    live === null
      ? {
          key: "production",
          name: "Production",
          sha: "none",
          tone: "dim",
          status: "nothing deployed",
          note: attemptNote,
        }
      : {
          key: "production",
          name: "Production",
          sha: sha7(live.commitId),
          tone: live.healthy === false ? "bad" : "ok",
          status: `live · ${live.healthy === null ? "" : live.healthy ? "healthy · " : "unhealthy · "}${age(live.deployedAt)}`,
          note: attemptNote,
        },
  ];
  const { images } = release;
  if (images !== null) {
    const when = images.at === null ? "" : ` · ${formatClock(images.at)}`;
    rows.push({
      key: "images",
      name: "Images",
      sha: sha7(images.commitId),
      tone:
        images.status === "built"
          ? "ok"
          : images.status === "failed"
            ? "bad"
            : images.status === "building"
              ? "run"
              : "dim",
      status:
        images.status === "built"
          ? `built${when}`
          : images.status === "building"
            ? "building"
            : images.status === "failed"
              ? `failed${images.reason ? ` · ${images.reason}` : ""}`
              : "not built",
      note: null,
    });
  }
  if (release.stagingSkipped) {
    rows.push({
      key: "staging",
      name: "Staging",
      sha: "none",
      tone: "dim",
      status: "skipped (development mode)",
      note: null,
    });
  } else {
    rows.push(stagingRow(deploys, age));
  }
  return rows;
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

/** Staging as its latest deploy: a failed one is the row's state only when no deploy succeeded before it. */
function stagingRow(
  deploys: ReadonlyArray<SlipJayRunnerDeploy>,
  age: (iso: string) => string,
): SlipJayEnvironmentRow {
  const staging = deploys.filter((deploy) => deploy.environment === "staging");
  const latest = staging[0];
  const when = (deploy: SlipJayRunnerDeploy) =>
    deploy.finishedAt === undefined ? "" : ` · ${age(deploy.finishedAt)}`;
  if (latest === undefined) {
    return {
      key: "staging",
      name: "Staging",
      sha: "none",
      tone: "dim",
      status: "nothing deployed",
      note: null,
    };
  }
  const live = staging.find((deploy) => deploy.status === "deployed");
  if (live === undefined) {
    return {
      key: "staging",
      name: "Staging",
      sha: sha7(latest.commitId),
      tone: "bad",
      status: `${latest.status}${when(latest)}`,
      note: null,
    };
  }
  return {
    key: "staging",
    name: "Staging",
    sha: sha7(live.commitId),
    tone: "ok",
    status: `deployed${when(live)}`,
    note:
      latest === live
        ? null
        : `Last attempt ${sha7(latest.commitId)} ${latest.status}${
            latest.finishedAt === undefined ? "" : ` ${age(latest.finishedAt)} ago`
          }`,
  };
}
