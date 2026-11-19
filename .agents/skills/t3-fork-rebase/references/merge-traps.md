# Merge traps

Things that cost a full update (v0.1.11-nightly.20261118.4903, about 290 conflicts) hours to find. Read before resolving.

## Resolving

- **Both sides rewrote a file.** A three-way merge aligns badly. Start from upstream's version and apply the fork's diff (`git diff <fork-base> <fork-head> -- <file>`) as a patch; hand-write only the rejected hunks. The same works after a rebase onto a moved `t3peach`: take `t3peach`'s file and re-apply the old merge's diff for it.
- **`both` under zdiff3** trims a shared suffix: when each side appended a function after the same closing line, one closing brace goes missing (TS1005 far below).
- **Wholesale-replaced tests** interleave under per-hunk `both`. Rebuild the region from the pristine sides (`git show HEAD:<f>`, `git show MERGE_HEAD:<f>`, `git merge-file --diff3` outside the repo) and match tests by title, not position.
- **Renamed shared helpers.** Check every importer before adopting upstream's name; untouched files may import the fork's.
- **Removed features win.** When fork work landed meanwhile retires something (T3-748 retired account and model pools), take its removal and keep only the merge's translation or upstream change around it; then grep for the retired API in tests (`poolSwitch`, `listPools` survived in merged fixtures).

## Making it build

- **Duplicate dependency versions** (two `gt-i18n` versions in the lockfile) make `m`/`msg` "two different types with this name". Bump every package that declares it to one version and `vp i`. After any version change delete `apps/web/node_modules/.cache/tsconfig.tsbuildinfo`; `--no-cache` does not clear it, so earlier "no errors in my files" claims are void.
- **A type cascade in a test fixture**: find the widest `.pipe()` first; past 20 arguments it degrades to unknown requirements. A helper that gained a middle parameter shows as a type mismatch on the shifted argument, not an arity error.
- **`Layer.mergeAll` keeps one provider per tag**: a merged fixture with a `Layer.mock` and a real layer for the same service silently uses one. Delete the superseded mock.
- **New MCP tools**: `McpToolAccess.routed` dies at layer construction for a tool whose `EnabledWhen` it does not know, and that breaks whole toolkits (160+ tests). Annotate every tool upstream added (`hiddenFromOutsideClients`, or `outsideClientsToo()` for the fork's outside-client tools).
- `vp lint` runs from the repo root, with no `..` in paths; `no-low-value-comments` rejects PR and issue numbers in comments.

## Tests

- **Triage against baselines.** On the Mac most failing suites are environment baselines (`/var` vs `/private/var`, git `insteadOf`, bash 3.2 exit codes, jj, desktop `Mac.key` CryptoError, `ssh/tunnel`, `GitVcsDriver`). Run each failure at fork HEAD and at the tag before calling it a regression: make a detached worktree, symlink its root `node_modules` to the merge clone's and copy each package's `node_modules`.
- **Printing from an Effect test** without shifting interleavings: `yield* Effect.sync(() => console.log(...))`. `Effect.log` adds a yield and can change which variant fails.
- **Writer ordering in `nodeSqliteClient`**: do not route newcomers through a fair-claim queue; it deadlocked `EffectWorker.drain` in side-chat tests. The batch-level `Effect.yieldNow` before the next commit in `ProviderCommitBatch` is the fix that holds.
- **`SynchronizedRef.get` is not synchronized**: reading after a `modifyEffect` that publishes an event is a stale-read race. Read under the permit with `SynchronizedRef.modify`.
- **Not every test runs at landing.** The landing budget defers some to the nightly audit, so a merge can land with them red. When the merge renames a patch or vendored file, update `fork/legacy-name-allowlist.json` and the `docs/dependencies.md` row that names it.

## Review and landing

- The remerge diff of a large update does not fit one reviewer: split it (server/packages/scripts/docs vs web/mobile) and leave out the lockfile, regenerated catalogs and upstream files the fork removes.
- `delegate_task` refuses a `sourceRevision` that is not the workspace's `@`: after editing a commit with `jj edit`, pass `jj log -r @ --no-graph -T commit_id`.
- The receipt must sit in the candidate's last commit; a follow-up chore found during review lands separately, after the merge.
