---
name: t3-fork-rebase
description: Merge an upstream T3 Code nightly tag into the fork's `t3peach` branch when `scripts/fork-nightly.sh` could not, then build and stage the app. Run when the fork-nightly webhook starts a thread with a tag, or when asked to update the fork to a nightly.
---

# Merge an upstream nightly into the fork

`t3peach` is the fork: upstream's nightlies merged in, plus the fork's own commits. `scripts/fork-nightly.sh` (hourly, launchd) merges each new nightly automatically; it hands the tag to this skill only when the merge conflicts or the fork's checks fail on it. Henry has given standing permission for this skill to push a merge to `t3peach` as a plain fast-forward; that is the only push it makes. Never force-push or rewrite `t3peach`: every thread lands on it.

1. **Clone.** In a fresh `mktemp -d`:
   `git clone --filter=blob:none --branch t3peach https://github.com/pechhe/t3code.git fork && cd fork && git remote add upstream https://github.com/pingdotgg/t3code.git && git fetch upstream tag <tag> --no-tags`.
   If `git merge-base --is-ancestor <tag> HEAD`, the fork already has it: go to step 5. Never work in `~/Engineering/t3code`, `~/.t3fork/repo` or a SlipJay workspace.
2. **Merge.** `git merge --no-edit -m "merge upstream <tag>" <tag>`. For each conflict, read what upstream changed (`git log -p HEAD...<tag> -- <file>`, or the upstream commit named in the hunk) and what the fork's side intends (`git log -p <tag>..HEAD -- <file>`), then write the version that keeps the fork's behaviour on upstream's new code. The fork's own features are context rollover (`/rollover`), Experiments, managed agent roles and `t3 agent`, SlipJay delivery (`slipjay.json`), the device composer and machined sidebar, image annotation notes, and the `scripts/fork-*` jobs. For `pnpm-lock.yaml`, take upstream's side, then run `vp i` and stage the regenerated lockfile. Done when `git commit --no-edit` completes the merge.
   Stop and ask Henry in this thread, leaving the clone in place, when the sides want different product behaviour, or upstream removed or rewrote a subsystem a fork feature extends, so that keeping the feature means redesigning it.
3. **Check.** `vp i`, then every command in `slipjay.json`'s `requiredLandingVerification`, then the test files beside every file you resolved. Fix a failure the merge caused, in the merge commit (`git commit --amend --no-edit`, before pushing). When a failure also happens on the bare tag (`git worktree add ../tag <tag>`, `vp i` there and rerun it), note it and leave it. Done when everything you ran passes or is recorded as failing upstream.
4. **Push.** `git push origin HEAD:t3peach`. A rejected push means something landed meanwhile: `git pull --no-rebase origin t3peach`, rerun step 3 on what changed, and push again. Never force-push or push to any other branch.
5. **Build.** `rm -f ~/.t3fork/failed-tag && bash ~/.t3fork/repo/scripts/fork-nightly.sh --build-now` in the background (a few minutes; it builds the pushed `t3peach` and also installs the VPS runtime). Done when `~/.t3fork/nightly.log` ends with `staged <version>` or `Installed fork build <version>`; if it logs `another run holds`, the hourly run is busy: rerun when its lock clears. On a failure there, diagnose from the log.
6. **Report** in this thread: the tag, each conflict and how you resolved it, the checks and results, the pushed commit, and the staged version. If the build is staged, say T3 Code installs it when Henry quits the app. Delete the clone.
