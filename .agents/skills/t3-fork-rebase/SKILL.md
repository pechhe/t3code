---
name: t3-fork-rebase
description: Rebase the fork's `t3peach` branch onto an upstream T3 Code nightly tag when `scripts/fork-nightly.sh` could not, then build and stage the app. Run when the fork-nightly webhook starts a thread with a tag, or when asked to update the fork to a nightly.
---

# Rebase the fork onto an upstream nightly

`t3peach` is upstream's nightly plus the fork's own commits on top. `scripts/fork-nightly.sh` (hourly, launchd) rebases it automatically; it hands the tag to this skill only when the rebase conflicts or the fork's checks fail. Henry has given standing permission for this skill to rewrite `t3peach` and push it with a lease; that is the only push it makes.

1. **Clone.** In a fresh `mktemp -d`:
   `git clone --filter=blob:none --branch t3peach https://github.com/pechhe/t3code.git fork && cd fork && git remote add upstream https://github.com/pingdotgg/t3code.git && git fetch upstream tag <tag> --no-tags`.
   Record `BASE=$(git rev-parse HEAD)`. If `git merge-base --is-ancestor <tag> HEAD`, the fork already has it: go to step 5. Never work in `~/Engineering/t3code`, `~/.t3fork/repo` or a SlipJay workspace.
2. **Rebase.** `git rebase <tag>`. For each conflict, read what upstream changed (`git log -p ORIG_HEAD...<tag> -- <file>`, or the upstream commit named in the hunk) and what the fork commit intends (its message and diff), then write the version that keeps the fork's behaviour on upstream's new code. The fork's own features are context rollover (`/rollover`), Experiments, managed agent roles and `t3 agent`, SlipJay delivery (`slipjay.json`) and the `scripts/fork-*` jobs. For `pnpm-lock.yaml`, take upstream's side, finish the rebase, then run `vp i` and amend the regenerated lockfile into the last fork commit that touched dependencies. Done when `git status` shows no rebase in progress.
   Stop and ask Henry in this thread, leaving the clone in place, when the sides want different product behaviour, or upstream removed or rewrote a subsystem a fork feature extends, so that keeping the feature means redesigning it.
3. **Check.** `vp i`, then `vp run typecheck`, then `pnpm exec vp test run` on the files in `slipjay.json`'s `requiredLandingVerification`, `apps/server/src/orchestration-v2/ContextRollover.test.ts`, `apps/server/src/orchestration-v2/ContextRollover.integration.test.ts`, and the test files beside every file you resolved. Fix a failure the rebase caused. When a failure also happens on the bare tag (`git worktree add ../tag <tag>`, `vp i` there and rerun it), note it and leave it. Done when everything you ran passes or is recorded as failing upstream.
4. **Push.** `git push --force-with-lease=t3peach:$BASE origin HEAD:t3peach`. A rejected lease means something landed meanwhile: start again from step 1 in a new clone, reusing your resolutions. Never push without the lease or to any other branch.
5. **Build.** `rm -f ~/.t3fork/failed-tag && bash ~/.t3fork/repo/scripts/fork-nightly.sh --build-now` in the background (about ten minutes; it rebuilds from the pushed `t3peach` and also installs the VPS runtime). Done when `~/.t3fork/nightly.log` ends with `staged <version>` or `Installed fork build <version>`; if it logs `another run holds`, the hourly run is busy: rerun when its lock clears. On a failure there, diagnose from the log.
6. **Report** in this thread: the tag, each conflict and how you resolved it, the checks and results, the pushed commit, and the staged version. If the build is staged, say T3 Code installs it when Henry quits the app. Delete the clone.
