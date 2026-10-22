# T3peach fork

T3peach (`pechhe/t3code`, branch `t3peach`) is T3 Code with upstream's nightlies (`pingdotgg/t3code`) merged in, plus the fork's own features and fixes. These rules keep it gaining features and speed while staying cheap to update. They apply on top of the repository's `AGENTS.md`.

- [`differences.md`](differences.md) records each deliberate difference from upstream: why it exists, what must survive an update, where it meets upstream code, its proof and when it can go.
- [`upstream-receipt.json`](upstream-receipt.json) is the reconciliation receipt for the newest upstream merge. The landing gate refuses a candidate whose receipt is missing or stale (`scripts/fork-upstream-receipt.ts`).

## Upstream policy

1. Prefer upstream's implementation of shared behaviour when evidence shows it meets the fork's requirements. Keep required behaviour, not code because it was written here.
2. When upstream covers part of a capability, use its implementation plus the smallest fork extension. Two complete implementations of one thing need a recorded reason and exit condition.
3. Adopting equivalent upstream behaviour needs no confirmation. An unresolved loss of functionality, incompatible migration or product choice goes to Henry with its specific trade-off.
4. Keep `t3peach`'s history: everything lands through `slipjay land`. Upstream arrives as merge commits so later updates can tell incorporated work from fork changes. Those are the only merges on `t3peach`'s first-parent history: the receipt check and the updater treat the newest one as the current upstream integration, so fork work lands as linear commits.
5. Build on existing services, contracts and shared client code; no plugin framework or second architecture for fork code.

## Making a fork change

A substantial feature, behaviour change or performance fix:

- **Checks upstream first.** Look for upstream work on the same problem (recent commits, open PRs, issues) before adding another mechanism, and reuse it or its direction when it fits.
- **Stays removable.** Keep it behind existing service boundaries, in identifiable changes, so it can be retired without rewriting shared history.
- **Proves behaviour.** Tests assert the observable requirement, not the internal implementation, so an upstream replacement can pass them.
- **Stays readable by shipped clients.** The TestFlight and App Store apps are upstream builds. They ignore an extra optional key on a struct, so an additive optional field (like `endedThreadWatches` on the thread shell) needs no gate. A new enum value, union member, required field, changed type or message is rejected whole, and the app only says the connection failed. Gate those behind a per-connection opt-in that fork clients send (see `LIVE_RESPONSE_STREAMING_QUERY_PARAM`), and send older clients the nearest value they know. `apps/server/src/shippedClientCompatibility.test.ts` decodes the settings a shipped client receives against the frozen schema in `shipped-client/`; extend it when the fork changes another payload, and refresh the schema when a newer upstream release ships.
- **Updates its record entry** in `differences.md` in the same change: requirements, integration points (the contracts and seams an upstream change could break), proof, known upstream work, and the condition that retires it. A temporary workaround says so.
- **Measures performance claims.** Name the bottleneck, the realistic workload, the before and after source revisions and the correctness checks. Keep execution time apart from waiting, less work apart from deferred work, and measured gains apart from hypotheses. #135 owns profiling, metrics and the daily performance routine; use its results.
- **Considers upstream.** Note when a focused, general fix could be proposed upstream. Never open an upstream PR without Henry asking.

## Updating from upstream

`scripts/fork-nightly.sh` runs hourly. It sends each new upstream tag, once per attempt, to the `t3-fork-rebase` skill through a T3 scheduled task. That skill merges the tag in a SlipJay workspace, reconciles it against `differences.md`, writes the receipt and lands it. A clean merge is reconciled too. Once the update has landed, the same skill builds it, after checking that no agent turn is running on the VPS. The build accepts only landed source whose receipt check passes. It installs the VPS runtime, stages the app, and replaces the installed app only once a validated copy is in place. Signing uses a private keychain created once by `fork-nightly.sh setup-signing` (run in a Terminal on the Mac), so builds also work over `ssh mac`, where the login keychain is locked. `fork-nightly.sh status` shows the selected, staged and active builds by source commit, and each attempt's phase.
