#!/bin/bash
# Creates the named upstream-reconciliation fixtures in a scratch directory:
# small fork/upstream repositories, each with an upstream tag to merge and the
# overlap a reviewer following the `t3-fork-rebase` skill is expected to find
# (`expected.md`, which the reviewer must not read). They exercise the review,
# not the receipt gate: scripts/fork-upstream-receipt.test.ts covers that.
#
#   scripts/fork-reconcile-fixtures.sh <empty directory>
set -euo pipefail

OUT="${1:?usage: $0 <empty directory>}"
mkdir -p "$OUT"
OUT="$(cd "$OUT" && pwd)"
export GIT_AUTHOR_NAME=fixture GIT_AUTHOR_EMAIL=fixture@example.com
export GIT_COMMITTER_NAME=fixture GIT_COMMITTER_EMAIL=fixture@example.com

write() { mkdir -p "$(dirname "$1")" && cat >"$1"; }
commit() { git add -A && git commit --quiet -m "$1"; }

# A shared base: a contract, a client that renders thread rows, and an
# upstream-owned helper. The fork then adds its recorded differences.
base() {
  local dir="$OUT/$1"
  mkdir -p "$dir" && cd "$dir"
  git init --quiet --initial-branch=upstream
  write src/contracts/thread.ts <<'EOF'
export interface ThreadSummary {
  readonly id: string;
  readonly title: string;
  readonly updatedAt: string;
}
EOF
  write src/client/threadRow.ts <<'EOF'
import type { ThreadSummary } from "../contracts/thread.ts";

export const threadRow = (thread: ThreadSummary): string => thread.title;
EOF
  commit "upstream base"
  git tag v1.0.0
  git checkout --quiet -b t3peach
  write src/fork/elapsed.ts <<'EOF'
// Fork: show how long ago a thread changed, e.g. "5m ago", in the sidebar.
export const elapsedLabel = (from: Date, now: Date): string => {
  const minutes = Math.floor((now.getTime() - from.getTime()) / 60000);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  return hours < 24 ? `${hours}h ago` : `${Math.floor(hours / 24)}d ago`;
};
EOF
  write src/fork/elapsed.test.ts <<'EOF'
import { expect, it } from "vitest";
import { elapsedLabel } from "./elapsed.ts";

it("labels minutes, hours and days", () => {
  const now = new Date("2026-01-02T00:00:00Z");
  expect(elapsedLabel(new Date("2026-01-01T23:55:00Z"), now)).toBe("5m ago");
  expect(elapsedLabel(new Date("2026-01-01T21:00:00Z"), now)).toBe("3h ago");
  expect(elapsedLabel(new Date("2025-12-30T00:00:00Z"), now)).toBe("3d ago");
});
EOF
  write src/fork/pinnedThreads.ts <<'EOF'
import type { ThreadSummary } from "../contracts/thread.ts";

// Fork: pinned threads sort first, then by most recent update.
export const sortWithPins = (threads: readonly ThreadSummary[], pinned: ReadonlySet<string>) =>
  [...threads].sort(
    (a, b) =>
      Number(pinned.has(b.id)) - Number(pinned.has(a.id)) ||
      b.updatedAt.localeCompare(a.updatedAt),
  );
EOF
  write src/client/threadRow.ts <<'EOF'
import type { ThreadSummary } from "../contracts/thread.ts";
import { elapsedLabel } from "../fork/elapsed.ts";

export const threadRow = (thread: ThreadSummary, now = new Date()): string =>
  `${thread.title} · ${elapsedLabel(new Date(thread.updatedAt), now)}`;
EOF
  write fork/differences.md <<'EOF'
# Fork differences

## Entries
### sidebar-elapsed-time
- **Kind:** durable extension
- **Why:** Henry scans the sidebar for recently active threads.
- **Requirements:** each thread row shows time since its last update as `Nm ago`, `Nh ago` or `Nd ago`; rows never show a future or negative time.
- **Integration points:** `ThreadSummary.updatedAt` contract; the client thread row.
- **Proof:** `src/fork/elapsed.test.ts`.
- **Upstream:** none known.
- **Retire when:** upstream shows equivalent relative times in thread rows.
- **Decision:** retain (seed).

### pinned-threads
- **Kind:** durable extension
- **Why:** keep long-running threads at the top.
- **Requirements:** pinned threads sort before unpinned ones; within each group, most recently updated first.
- **Integration points:** `ThreadSummary.id` and `ThreadSummary.updatedAt` contract fields.
- **Proof:** none.
- **Upstream:** none known.
- **Retire when:** upstream ships pinning with the same ordering.
- **Decision:** retain (seed).
EOF
  commit "fork: elapsed time and pinned threads"
  git checkout --quiet upstream
}

# 1. Upstream adds an equivalent of a fork feature under different names; the
#    merge is clean.
base equivalent-renamed
write src/time/relativeTime.ts <<'EOF'
export const formatRelative = (date: Date, now: Date): string => {
  const minutes = Math.max(0, Math.floor((now.getTime() - date.getTime()) / 60000));
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  return hours < 24 ? `${hours}h ago` : `${Math.floor(hours / 24)}d ago`;
};
EOF
write src/time/relativeTime.test.ts <<'EOF'
import { expect, it } from "vitest";
import { formatRelative } from "./relativeTime.ts";

it("formats relative times and clamps the future", () => {
  const now = new Date("2026-01-02T00:00:00Z");
  expect(formatRelative(new Date("2026-01-01T23:55:00Z"), now)).toBe("5m ago");
  expect(formatRelative(new Date("2026-01-03T00:00:00Z"), now)).toBe("0m ago");
});
EOF
write src/client/threadMeta.ts <<'EOF'
import type { ThreadSummary } from "../contracts/thread.ts";
import { formatRelative } from "../time/relativeTime.ts";

export const threadMeta = (thread: ThreadSummary, now = new Date()) =>
  formatRelative(new Date(thread.updatedAt), now);
EOF
commit "Show relative update times for threads"
git tag v1.1.0
write expected.md <<'EOF'
Expected: `sidebar-elapsed-time` overlaps upstream's `formatRelative`/`threadMeta`
(different files and names, clean merge). Decision `adopt` (or `adapt` if rows
must keep the fork's placement): upstream's helper meets every requirement and
also clamps the future, so `src/fork/elapsed.ts` and its test are removed and the
row uses upstream's helper. `pinned-threads` is considered and unaffected.
EOF

# 2. Upstream ships most of a fork capability but misses one requirement.
base partial-equivalent
write src/client/pins.ts <<'EOF'
import type { ThreadSummary } from "../contracts/thread.ts";

// Pinned threads come first; order within each group is unchanged.
export const pinFirst = (threads: readonly ThreadSummary[], pinned: ReadonlySet<string>) =>
  [...threads].sort((a, b) => Number(pinned.has(b.id)) - Number(pinned.has(a.id)));
EOF
commit "Pin threads to the top of the sidebar"
git tag v1.1.0
write expected.md <<'EOF'
Expected: `pinned-threads` overlaps upstream's `pinFirst`, which keeps the input
order within each group instead of most-recent-first. Decision `adapt` (use
`pinFirst` plus the recency ordering as the smallest extension, removing the
fork's own pin sort) or `defer` with the missing requirement and a reassessment
condition. The recency requirement must not be lost, and two complete pin
sorts must not both remain.
EOF

# 3. Upstream changes a contract that fork code relies on; the merge is clean.
base contract-change
write src/contracts/thread.ts <<'EOF'
export interface ThreadSummary {
  readonly id: string;
  readonly title: string;
  /** Epoch milliseconds of the latest activity. */
  readonly lastActivityAt: number;
}
EOF
commit "Replace updatedAt with numeric lastActivityAt"
git tag v1.1.0
write expected.md <<'EOF'
Expected: the merge is clean, yet the contract change breaks the fork's
`src/client/threadRow.ts` and the untouched fork-only `src/fork/pinnedThreads.ts`
(`updatedAt.localeCompare`). Both `sidebar-elapsed-time` and `pinned-threads`
are brought into review through their `ThreadSummary.updatedAt` integration
point, adapted to `lastActivityAt`, and targeted checks (typecheck or tests)
cover both.
EOF

# 4. Upstream changes nothing the fork's entries depend on.
base no-overlap
write README.md <<'EOF'
# Example app

Run `vp dev` to start.
EOF
commit "Add a README"
git tag v1.1.0
write expected.md <<'EOF'
Expected: no overlap. A bounded coverage result lists the incoming commit, the
entries considered (`sidebar-elapsed-time`, `pinned-threads`) and why neither is
affected; no code changes beyond the merge.
EOF

for fixture in equivalent-renamed partial-equivalent contract-change no-overlap; do
  git -C "$OUT/$fixture" checkout --quiet t3peach
  mv "$OUT/$fixture/expected.md" "$OUT/$fixture.expected.md" 2>/dev/null || true
done
echo "fixtures in $OUT: merge tag v1.1.0 into t3peach in each; expectations in $OUT/*.expected.md"
