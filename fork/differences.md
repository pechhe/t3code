# Fork differences

This record lists the material, deliberate differences between the T3peach fork (pechhe/t3code, branch `t3peach`) and upstream (pingdotgg/t3code): capabilities, behaviour changes and temporary workarounds, with the requirements that must survive an upstream update. Every fork change that adds or changes a deliberate difference updates its entry in the same change; upstream reconciliation reads this file to decide retain, adopt, adapt or defer. Entries state requirements and seams, not file catalogues; history lives in git, and tracker items (pechhe/t3code#N) own the work.

## Baseline

- Upstream: v0.1.2-nightly.20261021.3473 (`1688f965682d331da16a8c39f049592361f69c8d`)
- Fork: `654d2eaee0dd89adf02b1a7e5fa6a3a5bb5bed85`

## Coverage

Seeded from `git diff 9c161462c9 d1d4354daf` (≈813 files, 265 non-merge commits) by directory and commit subject. "Classified" means mapped to an entry below; it does not mean every file in the area was read. Unverified items are marked in entries.

| Area                                                                                                                                                   | Status              | Entries or reason                                                                                                                                         |
| ------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| apps/server/src/orchestration-v2 (compact line, watches, unattended, project move, advisor close)                                                      | classified          | compact-line, thread-watches, unattended-threads, no-project-chats, managed-delegation                                                                    |
| apps/server/src/orchestration-v2 (other edits: adapters, run/turn services, outbox, projection, recovery)                                              | unknown             | Many small edits (≈50 files) that hook the entries above or carry perf fixes; not individually classified                                                 |
| apps/server/src/experiments, mcp/toolkits/experiments                                                                                                  | classified          | experiments                                                                                                                                               |
| apps/server/src/agents, cli/agent*, scripts agent-policy validator                                                                                     | classified          | agent-policy-roles, managed-delegation, t3-agent-cli, run-setup-records                                                                                   |
| apps/server/src/mcp (service, toolkits)                                                                                                                | classified          | managed-delegation, run-setup-records, managed-browser-roles, build-items-hq, thread-terminal-read (in managed-delegation)                                |
| apps/server/src/hq                                                                                                                                     | classified          | build-items-hq                                                                                                                                            |
| apps/server/src/vcs, project/SlipJay*, project/WorkspaceProvider, slipjay.json                                                                         | classified          | slipjay-workspaces, slipjay-landing, slipjay-release-approvals, slipjay-settings, slipjay-delivery-config                                                 |
| apps/server/src/releases                                                                                                                               | classified          | slipjay-release-approvals                                                                                                                                 |
| apps/server/src/peers                                                                                                                                  | classified          | linked-environments                                                                                                                                       |
| apps/server/src/preview (Phi), mcp managed browser                                                                                                     | classified          | phi-browser-backend, managed-browser-roles                                                                                                                |
| apps/server/src/videoFrames                                                                                                                            | classified          | screen-recording-video                                                                                                                                    |
| apps/server/src/scheduledTasks, scheduling                                                                                                             | classified          | scheduled-tasks-extensions                                                                                                                                |
| apps/server/src/provider, usage, orchestration-v2 UsageLimitRecoveryWorker, packages/shared providerPools                                              | classified          | account-pools                                                                                                                                             |
| apps/server/src/persistence (Migrations 063–071, 073, 077, 078, 080; DatabaseStorage; nodeSqliteClient)                                                | classified          | migration numbering in compact-line/experiments constraints; perf-persistence-reads                                                                       |
| apps/server/src/auth, relay/AgentAwarenessRelay, terminal, sourceControl, textGeneration, ws.ts, serverSettings.ts, serverRuntimeStartup.ts, server.ts | unknown             | Edits hook fork features (settings, MCP auth, shell snapshots); not individually classified                                                               |
| apps/web components/chat (compact line, device composer, side chat, streaming, annotator, fast switch, return chip)                                    | classified          | compact-line, device-composer, image-annotation, side-chat, live-response-streaming, perf-markdown-blocks, web-client-customisation, subagent-return-chip |
| apps/web components/settings, routes settings.*                                                                                                        | classified (partly) | delegation-settings, experiments (settings), linked-environments, slipjay-settings; settings search and Projects entry: unknown                           |
| apps/web SlipJay*/buildItem/ThreadWorkflowChip/AgentRoleChip/scheduled/usage/snapShot components                                                       | classified          | slipjay-landing, build-items-hq, thread-workflow-chip, scheduled-tasks-extensions, account-pools, snapshot-overlay                                        |
| apps/web themes/sounds/lib (project themes, interface sounds, motion)                                                                                  | classified          | project-themes, web-client-customisation                                                                                                                  |
| apps/desktop (snapShot, preview, window, ipc, build config)                                                                                            | classified          | snapshot-overlay, screen-recording-video, desktop-fork-build; other ipc/electron edits: unknown                                                           |
| assets/nightly, apps/mobile nightly Android icons and colours, scripts/export-android-icons.ts                                                         | classified          | nightly-app-icon                                                                                                                                          |
| apps/mobile                                                                                                                                            | classified (partly) | mobile-fork-screens; Fast switch (#129) and pool account (#145) are open tracker items, not in this diff                                                  |
| packages/contracts, packages/shared, packages/client-runtime                                                                                           | classified (partly) | Support types for the entries above; individual files not mapped                                                                                          |
| packages/provider-core, provider-acp/opencode/pi/muse/cursor                                                                                           | unknown             | Small adapter edits (MCP session, orchestration instructions, subagent projection); not classified                                                        |
| scripts/fork-*, .agents/skills/t3-fork-rebase, fork/, AGENTS.md fork section                                                                           | classified          | fork-updater, fork-guidance                                                                                                                               |
| scripts/build-desktop-artifact.ts, scripts/lib, apps/server/scripts (migrate-dev-db), dev runner                                                       | classified          | desktop-fork-build, dev-state-tooling                                                                                                                     |
| native/screen-picker                                                                                                                                   | classified          | screen-recording-video                                                                                                                                    |
| docs/user, docs/internals, docs/operations, docs/orchestration-v2                                                                                      | excluded            | Describe entries above; update with the owning entry. docs/operations/agent-delegation.md is the operations reference for managed-delegation              |
| docs/operations/mobile-screens-fork.md                                                                                                                 | excluded            | Not changed since the upstream baseline; the Screens dependency is upstream-owned                                                                         |
| pnpm-lock.yaml, package.json/dependency edits                                                                                                          | excluded            | Mechanical; regenerate after reconciling                                                                                                                  |

## Entries

### compact-line

- **Kind:** durable extension
- **Why:** A thread's compaction point can differ from its provider's: a long research thread can run further, a noisy one can compact sooner. Compaction itself stays provider-native; T3 sends no context nudges (the earlier context-rollover nudges, holds, `/rollover`, settings and experiment lever were removed in #4361 after a nudge aborted a running compaction).
- **Requirements:** the context bar's auto-compact marker is draggable and sets the thread's compact-at point (`thread.compact-at.set`, null resets to the model's point (the server setting `modelCompactAt`, by model slug and so shared by every Claude instance, set per model in Settings → Providers → Models in thousands of tokens, 67k floor, and written to every environment under the All environments scope), else the provider's "Auto-compact after" setting); double-click or double-tap opens that provider's settings; the line shows pending until the provider reports the point applied, and with no reported point (Codex on its built-in default) a faded line at the top of the range is still draggable; the point is held to `compactAtBounds` (100k floor for Codex, as its setting has) wherever it is shown or applied. Claude maps the point to `autoCompactWindow` = point + 33k (Claude Code compacts at window − min(maxOutput, 20k) − 13k; window 100k–1M) and Claude Code reads it only at startup (`applyFlagSettings` leaves the live threshold unchanged), so a changed point reopens the session with resume at the next turn, unless background work is running in it; Codex sets `model_auto_compact_token_limit` (scope `total`) at session start or resume, so a live change waits for the next session. `autoCompactThreshold` reports the point the running process compacts at, not Claude's window, including Claude's default (model window − 33k). Stored rollover events, rows, run-setup records and experiment evidence still decode.
- **Integration points:** `compactAt` on the thread contract, the projection and its `compact_at` column; `compactAtBounds` in contracts, shared by server and clients; the Orchestrator's bounds check on `thread.compact-at.set`; `RuntimePolicyV2` resolving the model's point when the thread has none; `modelCompactAt` in `ServerSettings` and its patch (replaced whole), and the server's fold of the briefly shipped per-instance field into it; Claude and Codex adapters' runtime policy; `DeviceContextBar`.
- **Proof:** packages/contracts/src/orchestrationV2.test.ts (bounds), apps/server/src/orchestration-v2/Orchestrator.compact-at.test.ts, RuntimePolicy.test.ts (model default, thread override), serverSettings.test.ts (instance fold), Adapters/ClaudeAdapterV2.test.ts (per-thread compact-at, reopen on a changed point, reported thresholds), Adapters/CodexAdapterV2.test.ts; apps/server/src/persistence/Migrations/080_ThreadCompactAt.test.ts; apps/web/src/components/chat/device/compactLine.logic.test.ts; the landing gate runs them when a change reaches them.
- **Upstream:** upstream has the per-instance "Auto-compact after" setting and the marker (#18332); the per-thread point, drag and per-model point are the fork's.
- **Retire when:** upstream ships a per-thread compaction point.
- **Constraints:** fork migrations 063–071/073 sit before upstream's own: upstream migrations take the next free fork number in upstream order (`DropUnusedV1Projections` 072, `CanonicalizeThreadPullRequestLinks` 074, `CodexUsageNativeTurnIndex` 075, `RepairClientSettlementTimestamps` 076, `WebhookDedupe` 079), and released fork numbers never move. Migration 080 `ThreadCompactAt` (fork) copies each dragged band's hard point into `compact_at`, the projected thread and the stored thread events, so a projection rebuild keeps it; it cannot apply bounds, which have no model there. Old rollover columns stay in the database unused.
- **Decision:** `retain` (2026-10-21, #4361): context-rollover retired in favour of native compaction with a per-thread compact line.
- **Owner:** YardSmith HQ Build #4361.

### experiments

- **Kind:** durable extension
- **Why:** Measures model and instruction policy on normal work instead of guessing (rollover experiments are historical, read-only).
- **Requirements:** experiment enrolment before execution; recorded per-run setup and episode evidence; cut points when a thread's setup changes (correct across late capture and restart); instruction lever overlay; retrospective evidence accepted or refused with an actionable reason; inspectable and manageable from web and mobile settings; bundles captured for earlier fresh-session rollovers (#132) stay readable; nothing captures new ones.
- **Integration points:** `ExperimentService`, `InstructionOverlay`; `experiments` MCP toolkit; migrations 063/066/068; `experiments` contracts/RPC; Settings → Experiments; `migrate-dev-db` copy rules (filtered rows' children).
- **Proof:** apps/server/src/experiments/ExperimentService.test.ts, ExperimentWork.test.ts, InstructionOverlay.test.ts; apps/server/src/mcp/ExperimentWorkMcp.test.ts; the landing gate runs them when a change reaches them.
- **Upstream:** none known.
- **Retire when:** upstream ships an equivalent covering the requirements, or the owner retires experimentation.
- **Constraints:** assignment queries must use index-backed predicates (#140). Stored evidence must stay readable across schema changes.
- **Decision:** `retain` (seed, 2026-10-19): fork-only, in landing gate.
- **Owner:** pechhe/t3code#1, #16, #55, #58, #59, #130, #132 (closed); no open item.

### agent-policy-roles

- **Kind:** durable extension
- **Why:** Delegation uses validated, versioned role/model policy instead of ad-hoc model choice.
- **Requirements:** immutable policy snapshots validated before use; managed role resolution (role-first, caller may choose a model within a role; fresh reviewer may use author's model; different provider preferred for subagents); roles include scout (read-only exploration), researcher (read-only web) and browser/UI roles; refusals state a reason; policy models can carry fixed options; policy edited from Settings with a resolution preview; installed agent-config revision shown; `T3CODE_AGENT_POLICY_ROOT` reaches the server from the login shell.
- **Integration points:** `AgentPolicyService/Store/SettingsService`, `AgentRoleResolver`, `AgentConfigCheckout`; `agentPolicy*` contracts; migration 064; `validate-agent-policy.ts`; scheduled-task roles (migration 069).
- **Proof:** apps/server/src/agents/AgentPolicyService.test.ts, AgentRoleResolver.test.ts, AgentPolicySettingsService.test.ts; ScheduledTaskService.role.test.ts; the landing gate runs them when a change reaches them.
- **Upstream:** none known.
- **Retire when:** upstream ships an equivalent covering the requirements.
- **Decision:** `retain` (seed, 2026-10-19): fork-only, in landing gate.
- **Owner:** pechhe/t3code#2, #4, #5, #7, #9, #12, #19, #25 (closed); #146 open (cross-project pinned scout has no source-reading tools).

### managed-delegation

- **Kind:** durable extension
- **Why:** Agents delegate to managed subagents (advisors, readers, isolated writers) with enforced scope, independence and follow-up.
- **Requirements:** `delegate_task`/`followup` flows: any managed task can be followed up; advisors are reused and wait for published results; pinned read-only helpers share the lead's workspace but serialize with isolated writers; isolated writers validate their workspace at launch and hand back a revision; delegation to any registered project including No project chats; delegation skips models whose accounts are out of usage; idle advisors close per setting; a managed task's browser tabs close when it ends; agents can read their thread's terminal; default child permission level is a setting; pending background work of any kind, including a command left running, holds a thread's completion (it reads Waiting, not Ready) until it ends or is stopped, so a delegated result is not reported early.
- **Integration points:** `OrchestratorMcpService` and `orchestrator` toolkit; `ManagedAgentService`, `followup`, `writerWorkspacePreflight`, `workspaceIdentity`; `AdvisorIdleCloseReactor`; provider MCP session wiring (`provider-core`); docs/operations/agent-delegation.md.
- **Proof:** apps/server/src/mcp/OrchestratorMcpService.test.ts, ManagedDelegation.test.ts, ManagedFollowup.test.ts, TaskCancelNativeSubagent.integration.test.ts; apps/server/src/agents/ManagedAgentService.test.ts, writerWorkspacePreflight.test.ts; orchestration-v2/AdvisorIdleClose.test.ts; the landing gate runs them when a change reaches them.
- **Upstream:** upstream has the base orchestrator MCP and subagents; the managed layer is the fork's. Overlap risk is high on `OrchestratorMcpService`.
- **Retire when:** upstream ships equivalent managed scope and follow-up covering the requirements.
- **Decision:** `adapt` (v0.1.2-nightly.20261021.3473, 2026-10-21): upstream's stop-clears-stuck-delegate fix (#22653: `task_cancel` on a settled task still cancels its orphaned follow-up and reports `cancelled`) folded into the fork's exclusive cancellation, and its delegate finalisation when leftover work settles (#22709) kept under the fork's hold-everything completion rule. Earlier: `adapt` (v0.1.2-nightly.20261021.3457, 2026-10-21): upstream's repair for idle orphaned follow-ups (#22581: stopping an app-owned task whose child is idle cancels only that child's orphaned tasks) merged into the fork's managed cancellation, keeping recursive mode checks, queued-run cancellation and completion delivery (OrchestratorMcpService.test.ts "cancels an orphaned follow-up through its parent"). Earlier: `adapt` (v0.1.1-nightly.20261020.3399, 2026-10-20): upstream's delegated model-option inheritance (`target.options`), `pendingApproval` ending `mode=wait` (#20037), settled-leaf omission and result delivery without history handoffs (#22117) layered onto the role-based `delegate_task`; external agent results report `pendingApproval: null`. Upstream's command-kind exception to the completion hold (commands such as dev servers do not hold it) stays replaced by the fork's hold-everything rule; the mobile thread list test is aligned with it. Earlier: `adapt` (v0.1.1-nightly.20261020.3386, 2026-10-20): upstream's deduplicated terminal results and context transfers (#19759) combined with managed handoff evidence; ordinary Codex threads use upstream's dotted MCP overrides while managed tasks keep whole-table disabling. Earlier: `retain` (v0.1.1-nightly.20261019.3348, 2026-10-19): upstream's base fixes adopted into the managed paths: worktree delegation refuses a parent checkout outside the project (non-SlipJay base only), `task_cancel` cancels the task's queued turn, the setup script skips the main checkout as well as managed tasks, and the orchestration instructions are split into sections under Codex's 4,000-byte entry limit. Those instructions say only when and why to delegate; field mechanics live once, in the `delegate_task` description.
- **Owner:** pechhe/t3code#14, #15, #17, #18, #31, #40, #62, #93, #131 (closed); open: #123, #136, #146.

### t3-agent-cli

- **Kind:** durable extension
- **Why:** Agents outside T3 (other harnesses) take part in T3-managed work through a thin authenticated CLI.
- **Requirements:** `t3 agent` commands reach delegation with the caller's auth; external work is recorded and status reports no pending question; an external attach works for a project registered in a repository subdirectory.
- **Integration points:** `cli/agent.ts`, `AgentCliClient`, `ExternalAgentWorkService`; migration 065; MCP/OAuth auth path; docs/user/outside-agents.md.
- **Proof:** apps/server/src/cli/AgentCliClient.test.ts, agent.test.ts; apps/server/src/agents/ExternalAgentWorkService.test.ts.
- **Upstream:** none known.
- **Retire when:** upstream ships an equivalent external-agent CLI covering the requirements.
- **Decision:** `adapt` (v0.1.2-nightly.20261021.3473, 2026-10-21): upstream's `t3 thread` command (#22732, local token) sits beside `t3 agent` (OAuth); the bridge adopts upstream's shared `mcpToolSession` and keeps the exported `callAcpMcpTool` that `AgentCliClient` calls. Earlier: `retain` (v0.1.2-nightly.20261021.3457, 2026-10-21): upstream's removal of test-only exports (#22557) reverted for `callAcpMcpTool`, which `AgentCliClient` calls in production. Earlier: `retain` (seed, 2026-10-19).
- **Owner:** pechhe/t3code#6, #64 (closed); none open.

### run-setup-records

- **Kind:** durable extension
- **Why:** Each run's agent setup (role, model, skills, instructions) is recorded so experiments and reviews can read it.
- **Requirements:** `t3_thread_setup` answers small by default, reaches every run (including never-started and beyond the newest 50), reports invoked skills truthfully, and is readable by read-only Claude.
- **Integration points:** `RunSetupRecorder`; thread MCP toolkit; migration 071; `runSetup` contract.
- **Proof:** apps/server/src/agents/RunSetupRecorder.test.ts.
- **Upstream:** none known.
- **Retire when:** upstream ships an equivalent run-setup record.
- **Decision:** `retain` (seed, 2026-10-19).
- **Owner:** pechhe/t3code#55, #68, #87, #88 (closed).

### delegation-settings

- **Kind:** durable extension
- **Why:** Policy, pools and roles are editable by job from Settings on web and mobile.
- **Requirements:** job-based delegation settings with a resolution preview; fast-tier switch per model; role brief shown on hover; default child permission and idle-advisor closing; one editor under the environment picker (no project axis), where All environments saves one policy to every connected environment against each one's own revision.
- **Integration points:** Settings → Delegation route/components; agent-policy RPC; shared settings state.
- **Proof:** apps/web/src/components/settings/DelegationSettings.browser.test.tsx, DelegationSettings.logic.test.ts.
- **Upstream:** none known.
- **Retire when:** policy ceases to exist or upstream ships equivalent settings.
- **Decision:** `retain` (seed, 2026-10-19).
- **Owner:** pechhe/t3code#19, #20, #39 (closed).

### slipjay-workspaces

- **Kind:** durable extension
- **Why:** Threads run in SlipJay (Jujutsu) workspaces so parallel agent work lands through one guarded path.
- **Requirements:** Jujutsu VCS driver (status, diff, files, per-turn checkpoints, restore); jj repositories detected, including colocated checkouts and repositories whose checkout predates `slipjay.json`; repository detection stops at the nearest `.git` or `.jj`; new threads get an automatic workspace except explicit project-checkout launches; a launch with a Build item (`buildItem`) resumes that item's workspace or creates one attached to it, before the agent starts; a thread whose workspace SlipJay removed (landed, or idle with no unlanded work) gets a fresh workspace on its next message or terminal open, which takes its Build item (linked, or the one its workspace was attached to) only when no other workspace holds it, so it never joins another thread's checkout, and a turn and a terminal recovering it together keep the one checkout the thread is bound to, its agent is told on the first turn in the fresh checkout, and when no replacement can be allocated the turn runs on the project checkout instead of failing, with the thread bound there and its agent told to allocate a workspace before changing files, and the thread keeps its strip after the removal; a launch never removes a resumed workspace on cancel; a thread can move workspaces, and the turn the move detaches leaves none of its tool calls open (a run that ends without a provider terminal, by detach or stream failure, interrupts its open items with it, while a normal terminal still leaves background commands running), so the thread never sits on Waiting for a dead call; Codex isolated writers can write the repository store; SlipJay errors keep their cause, and a failed `slipjay` call adds only SlipJay's own error text, capped at its last 1,000 characters; one owner for SlipJay project rules.
- **Integration points:** `VcsDriver`/`VcsDriverRegistry`/`JjVcsDriver`/`SlipJayProject`; `WorkspaceProvider` (workspace tools, allocation); checkpoint services; `VcsStatusBroadcaster`; `RunExecutionService` finalisation after provider event ingestion ends without a terminal.
- **Proof:** apps/server/src/vcs/JjVcsDriver.test.ts, SlipJayProject.test.ts; apps/server/src/project/WorkspaceProvider.test.ts; apps/server/src/orchestration-v2/ThreadLaunchService.test.ts, WorkspaceRebind.integration.test.ts, RunExecutionService.test.ts; apps/server/src/mcp/toolkits/project/handlers.test.ts; apps/mobile/src/features/threads/git/jujutsuCheckout.test.ts.
- **Upstream:** none known (upstream VCS is Git).
- **Retire when:** upstream ships a VCS driver abstraction with Jujutsu/SlipJay workspace support covering the requirements, or the fork stops using SlipJay.
- **Constraints:** status refresh must not scale with landings × watched checkouts (see perf-landing-refresh).
- **Decision:** `adapt` (v0.1.1-nightly.20261020.3386, 2026-10-20): upstream's configured-remote worktree base (#21032) runs inside the fork's Git checkout plan; SlipJay allocation stays independent of Git remotes. Earlier: `retain` (v0.1.1-nightly.20261019.3373, 2026-10-19): upstream's "started threads show the machine as a label" rule (#19900) applied to the fork's details-panel run context; its composer-layout test adapted to the panel. Earlier (3348): the bootstrap thread keeps `rootIsDefault` under upstream's tolerant launch.
- **Owner:** pechhe/t3code#21–23, #41, #42, #45, #46, #50–54, #67 (closed); open: #108, #112, #125; Build #3352, #3368, #3412.

### slipjay-landing

- **Kind:** durable extension
- **Why:** Users see and act on what will land from a thread without leaving T3.
- **Requirements:** one SlipJay tag in the thread header: it leads with the thread's own landing (its Spec, linked to Build, stage and time, then the outcome with Log, Fix and Dismiss) and otherwise with what the runner is doing, named by Spec; its popover pins the thread's landing above the runner's lanes, each landing named by the Spec SlipJay recorded for it (SlipJay 3.40) or its submitting thread's; the tag opens what the runner recorded; land from the thread panel; cancel or fix a landing; runner panel separates queue and run times; landing state survives workspace removal; Release is greyed out when a project has no release branch.
- **Integration points:** `SlipJayLandings`, `slipJayLandingState`; `SlipJayTicket`/`SlipJayRunnerControl` components; landing-watch RPC stream.
- **Proof:** apps/server/src/project/SlipJayLandings.test.ts, slipJayLandingState.test.ts; packages/client-runtime/src/slipJayCheckout.test.ts.
- **Upstream:** none known.
- **Retire when:** SlipJay delivery is dropped; no upstream equivalent expected.
- **Decision:** `retain` (v0.1.1-nightly.20261020.3399, 2026-10-20): upstream's checkout lease (`withWorkspaceLease`) now wraps local pull request preparation; SlipJay landing runs inside it unchanged (GitWorkflowService.test.ts). Earlier: `retain` (seed, 2026-10-19).
- **Owner:** pechhe/t3code#24, #29, #30, #133 (closed); open: #107 (mobile ticket).

### slipjay-release-approvals

- **Kind:** durable extension
- **Why:** Releases from T3 need an approval card instead of silent publication.
- **Requirements:** review and promote a SlipJay release from T3; one approval card per repository, answered once, case-insensitive repository keys (open); scheduled-task prompts do not read as the user's.
- **Integration points:** `ReleaseApprovals`, `SlipJayReleases`; migration 073; `releaseApproval` contract; sidebar/thread card; mobile card; agent tool path.
- **Proof:** apps/server/src/releases/ReleaseApprovals.test.ts, ReleaseApprovalShell.test.ts; apps/server/src/project/SlipJayReleases.test.ts.
- **Upstream:** none known.
- **Retire when:** SlipJay delivery is dropped.
- **Decision:** `adapt` (v0.1.1-nightly.20261020.3386, 2026-10-20): upstream removed `RequestActionButton` (#21943); release approval cards use the same `Button` as upstream approval cards, keeping the duplicate-submit guard. Approval summaries sit beside upstream's nonblocking pending-request summaries (#15430). Earlier: `retain` (seed, 2026-10-19).
- **Owner:** pechhe/t3code#124 (closed); #141 open.

### slipjay-settings

- **Kind:** durable extension
- **Why:** Machine runner, spares and project policy are managed from T3 Settings.
- **Requirements:** machine runner and spare settings, project policy editing; Projects entry in settings sidebar opens the current project on every environment.
- **Integration points:** `SlipJaySettings`; Settings → Projects/SlipJay routes; project contracts.
- **Proof:** apps/server/src/project/SlipJaySettings.test.ts.
- **Upstream:** none known.
- **Retire when:** SlipJay delivery is dropped.
- **Decision:** `retain` (seed, 2026-10-19).
- **Owner:** pechhe/t3code#102 (closed).

### slipjay-delivery-config

- **Kind:** deliberate behaviour change
- **Why:** The fork's landing gate defines what must pass before anything reaches `t3peach`.
- **Requirements:** `slipjay.json` names `t3peach` as integration branch and lists the required landing verification (the budgeted affected-test selector `node scripts/test-landing.ts`, server and web typecheck, and the upstream receipt check `node scripts/fork-upstream-receipt.ts verify --landed origin/t3peach`), kept in SlipJay's settings through `slipjay policy set`, which also dropped the retired `parallelExecution` key; 8 spares ready; generated paths and evidence paths declared; all integration publication goes through SlipJay.
- **Integration points:** `slipjay.json`; SlipJay CLI contract; `.t3/userdata` generated path.
- **Proof:** scripts/test-landing.test.ts for the selector, including that the budget never defers a changed test, an invariant guard on an added or removed test, or a direct importer of a changed module, and that the deferred manifest reaches the runner's test report; the verification list itself otherwise.
- **Upstream:** `check:changed` (#22767, #22784) picks only changed and same-named tests and relies on CI running the full suites after merge; it compares against `origin/main` (the fork's is a stale upstream mirror, 5,687 files behind), and it has no hook for quarantine, the time budget or deferral to the nightly audit. The gate is the fork's only check before `t3peach`, so it keeps its import-graph selector (evaluated in Build #4449, accepted 2026-10-21); revisit if upstream's command gains import-graph selection or such hooks.
- **Retire when:** not applicable while the fork uses SlipJay.
- **Decision:** `retain` (v0.1.2-nightly.20261021.3473, 2026-10-21): the landing test selector drops tests upstream deleted (#22557 and earlier) and maps upstream's split ACP registry replay fixture (#22717); it lists each workspace's tests from that workspace's directory, since upstream's root config adds per-package projects only when run from the repository root (#22714). Earlier: `retain` (seed, 2026-10-19).
- **Owner:** pechhe/t3code#3, #122 (open), #112 (open).

### build-items-hq

- **Kind:** durable extension
- **Why:** Threads link to YardSmith HQ Build Specs/Tickets and agents act in HQ as themselves.
- **Requirements:** link a thread to a Build item with header display and cards; Build links and #numbers render as live chips with cards; unreachable mentions and links from a previous HQ report clearly; lead and worker thread links on cards; one HQ connection per environment, shared by every project; per-thread HQ MCP agent and lifecycle; a raw delegated child gets no HQ server; mobile shows the Build item. Unchanged summaries and cards back off HQ rereads from one to two to four to five minutes; visible changes and proxied agent writes reset the cadence. Browser and Electron display queries pause while the document is hidden and stop when unmounted; native clients without a document keep their existing lifecycle. Durable agent Build watches still poll without a client, through the same adaptive summary cache. The Build card's Accept and Send back record the person's decision through that same connection: only T3's server posts to HQ's `/api/build/decisions` with the stored delegation (no agent, RPC or MCP route reaches it), from one stored read for both destination and credential; a Send back delivery goes only to the HQ origin that recorded it; there is no separate decision token, and the retired `hq-build-decisions` store is removed at startup.
- **Integration points:** `hq/BuildWorkItems`, `hq/BuildHome`, `HqAgentConnections` (including `decide`), `buildHome` contract and its `buildHomeDecide` permission, `HqMcpRoute`, `HqAgentLifecycleReactor`; `buildWorkItem` contract; `shared/buildLinks`; web `buildItem/` components; client-runtime state.
- **Proof:** apps/server/src/hq/BuildWorkItems.test.ts, BuildHome.test.ts (decisions carry the delegation to `<origin>/api/build/decisions`, follow connect and disconnect, and deliver only to the recording origin), apps/server/src/auth/RpcAuthorization.test.ts, HqAgentConnections.test.ts, HqAgentLifecycleReactor.test.ts; packages/client-runtime/src/state/runtime.test.ts; packages/shared/src/buildLinks.test.ts; docs/user/build-items.md. Cadence tests use a controlled clock, including backoff while HQ keeps failing; no live HQ cost measurement is claimed. The Build Home poll is exempt from the slow-request toast, and a read after its cadence lapses answers from the last known Home while HQ is asked in the background.
- **Upstream:** none known.
- **Retire when:** HQ integration is dropped.
- **Decision:** `retain` (seed, 2026-10-19).
- **Owner:** pechhe/t3code#74, #78–82, #92, #109–111 (closed); YardSmith HQ Build #4296, #4367.

### repository-chips-hq

- **Kind:** durable extension
- **Why:** A repository has the same colour and icon in T3 projects and YardSmith HQ.
- **Requirements:** match the repository's owner/name or an explicit HQ key against the repositories HQ lists (only a person registers one in HQ, so an unlisted key is skipped); opt out with Local only; the first sync pushes the project's look to a repository HQ only registered, and adopts one someone edited; push local icon changes and pull newer HQ revisions; retry offline failures without blocking project edits. Emoji icons may carry a colour; old emoji records retain their derived colour.
- **Integration points:** `project` and `applicationEvent` contracts; `ProjectCommands`, `ProjectStore`, migration 077 and `ProjectService.recordHqSync`; `hq/HqRepositories` and `RepositoryChipSync`; `HqAgentConnections.connectionChanges`; shared `projectIdentity`; web project settings, icon picker and chips. Sync metadata stays internal. All wire additions are optional fields on existing structures and icon variants, so old decoders ignore them.
- **Proof:** contracts `project.test.ts`; `ProjectCommands.test.ts`, `ProjectStore.test.ts`, `ProjectService.test.ts`; `hq/RepositoryChipSync.test.ts`; client-runtime `commands.test.ts`. Integrated HQ and Browser-panel acceptance belongs to the lead after the HQ side is assembled.
- **Upstream:** no equivalent HQ integration in the integrated nightly 20261020.3411; retain upstream project icon rendering and extend it at the existing override boundary.
- **Retire when:** HQ integration is dropped or upstream supplies equivalent repository identity synchronisation.
- **Owner:** YardSmith HQ Build #3690.

### thread-workflow-chip

- **Kind:** durable extension
- **Why:** The governing workflow of a thread is visible and recorded.
- **Requirements:** workflow recorded per thread and shown as a chip (web, mobile) with menu; chip shows the unattended stance (moon); role chips on subagent rows and thread panel.
- **Integration points:** `client-runtime/threadWorkflow`; `ThreadWorkflowChip`, `AgentRoleChip`; thread metadata contract.
- **Proof:** none found for the chip itself (unverified: coverage in client-runtime tests).
- **Upstream:** none known.
- **Retire when:** upstream ships equivalent workflow metadata.
- **Decision:** `retain` (seed, 2026-10-19).
- **Owner:** pechhe/t3code#56, #57, #121 (closed).

### unattended-threads

- **Kind:** durable extension
- **Why:** Unattended threads keep working without asking and questions get the away answer.
- **Requirements:** thread keeps working after a completed run, but not while its own background work (commands, monitors, delegated tasks, watches) will wake it; questions are answered with the away answer whichever event arrives last; stance visible on the workflow chip and set by the device composer's Away key, including on a new thread through launch (narrow web and mobile composers have no Away key yet: the chip menu covers started threads); an agent's `set_workflow` keeps the stance unless it sets `unattended`.
- **Integration points:** `UnattendedReactor` (uses `derivePendingBackgroundWork`); pending-question/approval events; thread workflow metadata; `ComposerAwayKey`, draft `unattended`, launch input `workflow`; MCP `ThreadMetadataMcpWorkflow`.
- **Proof:** apps/server/src/orchestration-v2/UnattendedReactor.test.ts, ThreadLaunchService.test.ts (Away launch), apps/server/src/mcp/ThreadMetadataMcpService.test.ts (stance kept).
- **Upstream:** none known.
- **Retire when:** upstream ships an equivalent unattended mode.
- **Decision:** `adapt` (v0.1.1-nightly.20261020.3399, 2026-10-20): upstream's five-minute restart-loop window (#20306) adopted for restart continuations only; the shared fork/unattended continuation counter stays untimed (RestartContinuation.test.ts, UnattendedReactor tests). Earlier: `retain` (seed, 2026-10-19).
- **Owner:** pechhe/t3code#118, #119, #120 (closed).

### thread-watches

- **Kind:** durable extension
- **Why:** A thread can wait on another thread or a Build item with `watch` / `unwatch`, alongside upstream PR watches.
- **Requirements:** wake a thread when a watched thread finishes; no firing between a background task ending and its wake; wake quotes the right earlier turn and does not repeat a result already read; settling a thread ends its watches, kills its pending background work and tells its watchers "Finished"; the composer strip summarises every pending wait in one line ("Waiting on 8 · 6 threads · …") that expands to a row per item with its kind, a link and, for a watched thread, its live status; Lineage lists "Watching" and "Watched by" threads beside the relationship graph, not as graph edges, so the running count and mobile ignore them. Build watches wake once when waits and holds clear (or Dropped), or on Landed/Accepted/Dropped for closed; they require T3’s HQ connection and survive restarts.
- **Integration points:** `OrchestrationV2WatchTarget` and legacy watch decoding; `BuildWatchReactor` with the shared adaptive `BuildWorkItems` summary cache; `threadWatch`, `ThreadWatchReactor` (alongside upstream `PullRequestWatchReactor`); `shellThreadWatches` client state; `presentPendingBackgroundWork`, `BackgroundWorkStrip`, `deriveThreadWatchRelationships` and `selectThreadRelationshipShells`; `orchestrationV2PendingBackgroundWork`; `RunExecutionService` must ingest the published roster clear before detaching, even when the adapter's live roster has already cleared.
- **Proof:** apps/server/src/orchestration-v2/ThreadWatch.test.ts; packages/shared/src/orchestrationV2PendingBackgroundWork.test.ts; packages/client-runtime/src/state/threadExecution.test.ts and threadRelationships.test.ts; `claude_background_task_after_root` in apps/server/src/orchestration-v2/testkit/OrchestratorReplayFixtures.integration.test.ts.
- **Upstream:** PR watches exist upstream; thread and Build item watches are the fork's.
- **Retire when:** upstream ships equivalent thread and Build item waiting.
- **Decision:** `retain` (#4297, 2026-10-20): the background-work banner becomes the fork's summary strip with an expandable per-item list; subagent links appear only in that list, not inline in a long title. Watched-by moves from the composer to Lineage. Earlier: `retain` (v0.1.1-nightly.20261020.3411, 2026-10-20): upstream's revert of subagent links in long background-work banners (#22228, reverting #20054) adopted for the banner; the fork's watch links and shared link helper kept. Earlier: `retain` (v0.1.1-nightly.20261020.3399, 2026-10-20): upstream's blocked-on-thread-wait detection (#21499, #21500: a turn waiting only on `t3_thread_wait` or a blocking `delegate_task` reads Waiting) added beside the fork's watch logic in `orchestrationV2PendingBackgroundWork`. Earlier: `retain` (seed, 2026-10-19).
- **Owner:** pechhe/t3code#91, #97, #98, #101 (closed); #152 / #154 (thread and Build target watch surface).

### scheduled-tasks-extensions

- **Kind:** durable extension
- **Why:** Scheduled tasks need machines, projects, roles and webhooks beyond upstream's task model.
- **Requirements:** Scheduled page lists tasks beside an in-place editor; tasks span machines and projects and run as a subagent with a role; a task names the thread it posts into; run rows open their thread; webhook-started tasks (e.g. fork-nightly hand-off) work; scheduled prompts do not read as the user's.
- **Integration points:** `ScheduledTaskService`, `ScheduledTaskPrompt`; migration 069; `scheduledTask` contract; web `scheduled/` page; poll uses the SQLite reader.
- **Proof:** apps/server/src/scheduledTasks/ScheduledTaskService.role.test.ts; apps/web/src/components/scheduled/scheduledTasks.logic.test.ts.
- **Upstream:** upstream has scheduled tasks; the extension is a delta (unverified: webhook trigger origin, which may be partly upstream).
- **Retire when:** upstream ships equivalent machine/project/role scheduling.
- **Decision:** `adapt` (v0.1.1-nightly.20261020.3438, 2026-10-21): upstream's webhook event filters (#22194) and replay dedupe/coalescing (#22234) adopted on the server, contracts and client-runtime unchanged; their editor fields (filters, replay key, coalesce key and window) and the new delivery outcomes (filtered, duplicate, coalesced, pending window) are ported into the fork's Scheduled page, since upstream's settings panel stays deleted. Earlier: `adopt` (v0.1.1-nightly.20261020.3411, 2026-10-20): upstream's revert of server-timezone labels (#22230, reverting #18653) adopted, so the fork's Scheduled page drops the label it had ported; upstream's revert landed on its settings panel, which the fork already replaced. Earlier: `adapt` (v0.1.1-nightly.20261020.3399, 2026-10-20): upstream's deletion of thread-bound automations with their thread (#22070), `run_scheduled_task_now` returning the launched thread (#17458) and server-timezone labels (#18653) adopted; the timezone label is ported into the fork's Scheduled page, which replaced upstream's settings panel. Earlier: `adapt` (v0.1.1-nightly.20261019.3373, 2026-10-19: upstream's release of a webhook claim when acceptance fails (#18820) adopted unchanged; v0.1.1-nightly.20261019.3360): upstream's thread-bound runs follow the thread's current model adopted; a role (or the saved model) only picks the model of a fresh thread, so the editor locks the role picker for a bound task as it does the workspace.
- **Owner:** none.

### linked-environments

- **Kind:** durable extension
- **Why:** Agents and composers use threads across linked T3 environments.
- **Requirements:** link/unlink environments in both directions from Settings; short-lived read-only peer sessions renewed; search/list/read threads across environments; attach linked threads in the composer.
- **Integration points:** `PeerEnvironments`, `ThreadDirectory`; `peers` contract; migration none known; thread MCP toolkit.
- **Proof:** apps/server/src/peers/PeerEnvironments.test.ts, ThreadDirectory.test.ts.
- **Upstream:** upstream resolves unqualified thread links across connected environments (#21505) and refuses foreign thread attachments (#18310); peer sessions, thread directory and linked-thread attachments are the fork's.
- **Retire when:** upstream ships equivalent cross-environment thread access.
- **Decision:** `adapt` (v0.1.2-nightly.20261021.3473, 2026-10-21): upstream's thread-link chips in markdown (#22615) adopted; the chip still resolves environment-qualified links only in their own environment. Earlier: `adapt` (v0.1.1-nightly.20261020.3411, 2026-10-20): upstream's snooze semantics in the MCP thread tools (#22202), skill chips in the mobile thread feed (#22120) and reverted question previews (#22229) merged with the fork's cross-environment listing, qualified link resolution and environment-qualified answer projection; upstream's add-project-to-another-machine flow (#22254) and Connect reachability check (#22172) do not touch peer sessions. Earlier: `adapt` (v0.1.1-nightly.20261020.3386, 2026-10-20): upstream's cross-environment thread-link resolution (#21505) adopted for unqualified links (unique match only); explicitly environment-qualified links never fall back to another environment, and copied remote links carry their environment. Upstream's blanket refusal of foreign thread attachments (#18310) is not applied to linked peers. Earlier: `retain` (v0.1.1-nightly.20261019.3348, 2026-10-19): the MCP thread list and read descriptions carry both upstream's `pullRequests` note and the linked-environment text.
- **Owner:** pechhe/t3code#33–38 (closed).

### account-pools

- **Kind:** durable extension
- **Why:** Several subscriptions of one provider (Claude) act as one pool, spending allowance that would lapse soonest.
- **Requirements:** pooled turns go to the pool's preferred member (composer lamp on a new thread) while it has allowance, else by the pool's strategy: the member whose weekly allowance lapses soonest, weighted by plan, or the first in the pool's own order; a pool can disable members, keep a reserve (a member counts as out at X% used for new threads and failover, not for a running thread) and override the global switch-on-limit setting (`poolPolicy` on the instance and its snapshot, edited in Settings → Providers); a thread stays on its member while it has allowance, and clicking the composer lamp on a thread that has run moves it to the next account in the pool's order with usage left (`thread.model-selection.set`); switch to the next member when a limit is hit with a handoff naming accounts; chosen member's usage is refreshed before routing (also for delegated tasks); usage card beside the composer; Claude forks find threads in an account's own home.
- **Integration points:** `shared/providerPools`; `ProviderInstanceConfig.poolPolicy`/`ServerProvider.poolPolicy`; `ComposerPoolAccount`; `PoolAccountsSection`; `ProviderRegistry`/`ProviderInstanceRegistry`; `ProviderSwitchService`; `UsageLimitRecoveryWorker`; usage sources; web `usage/` card.
- **Proof:** packages/shared/src/providerPools.test.ts; apps/server/src/orchestration-v2/UsageLimitRecoveryWorker.test.ts; apps/web/src/components/settings/PoolAccountsSection.logic.test.ts.
- **Upstream:** upstream has provider instances and usage limits; pooling is the fork's.
- **Retire when:** upstream ships equivalent pooled routing.
- **Decision:** `adopt` (v0.1.1-nightly.20261020.3438, 2026-10-21): upstream's revert of pooled-limit labelling (#22395, reverting #19964) adopted, so the fork's narrowest-column label measurement goes too; labels follow upstream's container query on the capacity-weighted columns. Upstream's even-pace tick in a gap (#22408) merged unchanged. Earlier: `adapt` (v0.1.1-nightly.20261020.3399, 2026-10-20): upstream's pooled-limit labelling and resize handling (#19964) adopted on the capacity-weighted columns, the narrowest column deciding labels; upstream's stop of auto-resume for stopped usage-limit threads (#21114) kept beside the pool switch. Earlier: `adapt` (v0.1.1-nightly.20261020.3386, 2026-10-20): upstream's fork under an instance's own Claude home (#18662) adopted in place of the fork's fork-session helper, extended to honour a custom `HOME`; handoff rows show upstream's instance badges beside the fork's account names. Earlier: `adapt` (v0.1.1-nightly.20261019.3373, 2026-10-19): upstream's per-account even-pace marks (#14477) adopted on the fork's capacity-sized pool segments. Earlier (3360): upstream's empty session for an account with no weekly quota (members carry `refillPercent`) adopted; pool columns keep the plan `capacity`, and a reset restores its refill weighted by plan capacity rather than divided evenly.
- **Owner:** pechhe/t3code#103, #114, #115 (closed); #145 open (mobile pool account).

### phi-browser-backend

- **Kind:** durable extension
- **Why:** Browser tools can run on the Phi browser as a selectable backend.
- **Requirements:** agent browser selectable from web and mobile settings; preview tools route through Phi; separate Agents Space when Phi is remote; Phi user lane lets an agent continue in the user's tab; status probe tolerant of slow Phi; links open only Phi's kiosk window; Phi custody preserved through interrupted allocation.
- **Integration points:** `preview/PhiBrowser*`; `browserBackend` contract/shared; `PreviewAutomationBroker`; desktop preview manager.
- **Proof:** apps/server/src/preview/PhiBrowser.test.ts, PhiBrowserRunner.test.ts, PhiBrowserProtocol.test.ts; packages/shared/src/browserBackend.test.ts.
- **Upstream:** upstream has the built-in preview browser.
- **Retire when:** Phi is dropped.
- **Decision:** `adapt` (v0.1.1-nightly.20261019.3348, 2026-10-19): upstream moved Agent browser access into the single Integrations → Browser section; the fork's Agent browser (backend) picker moved there beside it. `t3_preview_close` reports a browser backend's own refusal, as upstream now does, through the broker's Phi-aware close.
- **Owner:** pechhe/t3code#27, #128 (closed); #26 open.

### managed-browser-roles

- **Kind:** durable extension
- **Why:** Managed browser/UI roles drive the shared browser tools within scope.
- **Requirements:** own MCP endpoint for managed browser; snapshots small enough for Haiku, scoped by locator; `preview_wait_for` waits for disappearance; wait and resize allowed for browser roles; read-only browser roles keep Phi.
- **Integration points:** `ManagedBrowserAccess`; `managedBrowser` toolkit; preview toolkit.
- **Proof:** apps/server/src/mcp/McpManagedBrowser.test.ts, ManagedBrowserAccess.test.ts.
- **Upstream:** none known.
- **Retire when:** managed roles are dropped or upstream ships equivalent role-scoped browser tools.
- **Decision:** `retain` (v0.1.2-nightly.20261021.3457, 2026-10-21): upstream's removal of test-only exports (#22592) reverted for `normalizePreviewOpenInput`, which the managed browser handler calls in production. Earlier: `adapt` (v0.1.1-nightly.20261020.3399, 2026-10-20): upstream's MCP token retention across long waits and idle days (#18552, #19491) adopted; the fork's release of a managed task's Phi session on expiry is kept through a `browserReleased` mark that a trusted touch clears (McpSessionRegistry.test.ts). Earlier: `retain` (seed, 2026-10-19).
- **Owner:** pechhe/t3code#32, #94–96 (closed); #26 open.

### screen-recording-video

- **Kind:** durable extension
- **Why:** Users record the screen from the composer and agents can see attached video.
- **Requirements:** record a screen/window from the composer on desktop and web (60 fps, pause, notch indicator, source change, kept across threads); stopping returns to the thread; attached video reaches agents as timestamped frames chosen where the screen changes; agents can request more frames over a time range; requires ffprobe; Record hidden in the SnapShot overlay.
- **Integration points:** `videoFrames/*`; provider turn message frames; desktop `ComposerDisplayMedia`, `ScreenRecordingIndicator`, `native/screen-picker`; `build-screen-picker.mjs`.
- **Proof:** apps/server/src/videoFrames/VideoFrames.test.ts, frameTimes.test.ts.
- **Upstream:** none known.
- **Retire when:** upstream ships equivalent recording and agent video input.
- **Decision:** `adapt` (v0.1.1-nightly.20261020.3386, 2026-10-20): OpenCode now sends pasted images as native files (upstream); sampled video frames keep their frame text beside them. Upstream's bounded recording warmup (#20085) sits beside the composer's main-window capture path. Earlier: `retain` (v0.1.1-nightly.20261019.3373, 2026-10-19): video frames still precede the prompt block under upstream's mid-sentence skill command handling (#15253).
- **Owner:** pechhe/t3code#84–86, #89, #90 (closed); #83 open.

### snapshot-overlay

- **Kind:** durable extension
- **Why:** SnapShot is extended with an overlay window that is the main composer over the screen.
- **Requirements:** global shortcut (Space accepted, Option+Space records) shows a compact overlay composer; captures attach; overlay hands its chat to the new-chat page; keeps its conversation until ended; capture helper pre-started on macOS and exits with T3 Code.
- **Integration points:** `desktop/snapShot/*`, `SnapShotOverlayWindow`, `SnapShotProcessPool`; web route `snap-shot` and `surface=snap-shot-overlay` boot style in `index.html`; `CaptureShortcutConfig`.
- **Proof:** apps/web/src/components/snapShot/snapShotOverlayDock.test.ts; apps/desktop/src/snapShot/snapShot.test.ts.
- **Upstream:** SnapShot itself is upstream; the overlay is the fork's.
- **Retire when:** upstream ships an equivalent overlay.
- **Decision:** `retain` (v0.1.2-nightly.20261021.3457, 2026-10-21): upstream's test pruning (#22557) deleted `ActiveWindow.test.ts`, which by then held only upstream's Windows cases, and unexported `macSnapShotArguments`; the fork's one-shot capture helper, its tests in MacSnapShot.test.ts and overlay state stay. Earlier: `retain` (v0.1.1-nightly.20261020.3411, 2026-10-20): upstream reverted its auxiliary macOS window skipping (#22222, reverting #12978) and the snapshot-thumbnail context change (#22231), so the earlier `defer` no longer has an upstream fix to port; the fork's helper still takes the frontmost app's first layer-0 window, now tracked as a fork-side fix (YardSmith HQ Build #3737, replacing #3683); the fork's one-shot capture helper stays; overlay window state and preparation kept beside upstream's reverted window startup. Earlier: `defer` (v0.1.1-nightly.20261020.3399, 2026-10-20): upstream's skipping of auxiliary macOS helper windows (#12978) applies to its `ActiveWindow` osascript lookup, which the fork replaced with the one-shot capture helper in `MacSnapShot.ts`; that helper still takes the frontmost app's first layer-0 window. Reassess when the port is verified on macOS (YardSmith HQ Build #3683). Upstream's renamed `SnapShotCoordinator.browser.test.ts` carries the fork's overlay-conversation case. Earlier: `adapt` (v0.1.1-nightly.20261020.3386, 2026-10-20): upstream's quit guards on window setup (#18380) adopted around the fork's overlay and display-media installation. Earlier: `adapt` (v0.1.1-nightly.20261019.3348, 2026-10-19): upstream's named macOS test-capture failures adopted on top of the fork's capture pool. The pool finds and captures the window in one helper, so a failed window lookup reports as a failed capture; upstream's separate window-lookup test does not apply and was dropped.
- **Owner:** pechhe/t3code#76 (open, overlay slice).

### device-composer

- **Kind:** durable extension
- **Why:** The fork's composer and sidebar use a machined, device-like look.
- **Requirements:** model slider and reasoning dial, machine switch, docked strips, lit screen, composer sounds (keycaps click down and up); context bar always reads usage and carries the draggable compact line; machined sidebar base; Fast switch on the composer; themes can dye the metal.
- **Integration points:** `ChatComposer`, `ComposerControl`, `ComposerFastSwitch`, `sidebarDevice.css`, `composerFinish`, `sendMotion`, `interfaceSounds`.
- **Proof:** none found for look/feel; unverified browser tests (e.g. apps/web/src/components/Sidebar.motion.test.ts covers motion only).
- **Upstream:** none known; composer and sidebar are high-churn upstream files, so merge conflicts are likely.
- **Retire when:** the owner replaces the design.
- **Decision:** `retain` (v0.1.1-nightly.20261020.3411, 2026-10-20): upstream's revert of idle server updates on environment controls (#22233, reverting #21950) matches the fork, which never mounted that strip; idle updates stay in the fork's banner. Upstream's revert of worktree branch-mismatch warnings (#22225) adopted in the fork's details-panel toolbar, which keeps its workspace and SlipJay controls. Earlier: `retain` (v0.1.1-nightly.20261020.3386, 2026-10-20): upstream's composer environment strip (#21950) is not mounted (its `BranchToolbarEnvironmentSelector` file is kept to avoid a modify/delete conflict); idle server updates stay in the fork's banner. Upstream's implementation-menu focus fix (#17111) ported to the fork's primary actions. Earlier: `retain` (v0.1.1-nightly.20261019.3348, 2026-10-19): visual identity of the fork; the composer host and workspace selectors stay removed, so upstream's shortcut tooltips on them do not apply.
- **Owner:** #117 (open, reasoning-effort step paths), #129 (open, mobile Fast switch).

### image-annotation

- **Kind:** durable extension
- **Why:** Users annotate composer images with numbered marks and notes.
- **Requirements:** numbered marks and notes with arrow tool, undo and kept focus; notes travel as their own context chip, survive reloads, leave with their chip, reach older servers as text and tell the agent the sent image's pixel size.
- **Integration points:** `lib/imageAnnotation`, `ImageAnnotator`; composer context chip contracts; `composerContextLegacySend`.
- **Proof:** apps/web/src/lib/imageAnnotation.test.ts; packages/shared/src/composerContextLegacySend.test.ts.
- **Upstream:** none known.
- **Retire when:** upstream ships equivalent image notes.
- **Decision:** `retain` (v0.1.2-nightly.20261021.3457, 2026-10-21): upstream's icon-only mobile chip presentation (#22518) adopted; the pencil chip uses it. Earlier: `retain` (v0.1.1-nightly.20261020.3438, 2026-10-21): upstream's mobile chip icons (#22169) adopted; the image-annotation chip gains a generated `pencil` icon in the same scheme. Earlier: `retain` (seed, 2026-10-19).
- **Owner:** none.

### side-chat

- **Kind:** durable extension
- **Why:** Users ask a quick question above the composer without the main agent seeing it.
- **Requirements:** side chat streams with thinking shimmer and answers briefly; renders assistant text through the main chat's component.
- **Integration points:** `SideChatCard`; side-chat thread/RPC (unverified: server seam).
- **Proof:** none found.
- **Upstream:** none known.
- **Retire when:** upstream ships an equivalent.
- **Decision:** `retain` (seed, 2026-10-19).
- **Owner:** none.

### no-project-chats

- **Kind:** durable extension
- **Why:** New threads start without a project and can move into one later.
- **Requirements:** new threads start as No project with a project chip; a No project chat moves into a project in place, keeping its id and history (agents can do it, with a continuation that starts its next turn there), into a workspace it already holds there or the project's default, which its next turn prepares as a first message would, with its scheduled tasks; Undo puts it back until it runs in the project; a thread that moves itself (project move or workspace handoff) shows one "Moved to …" marker for the turn the move ended and its continuation as a collapsed "Continued after the move" row, on web and mobile; a worktree request in the Scratch project runs in its own folder.
- **Integration points:** `ThreadProjectMoveService`, `thread.project.move`/`thread.project.move.undo`, `useMoveThreadToProject`, `useStartNewThread`, `resolveUserMessagePresentation`; project contracts.
- **Proof:** apps/server/src/orchestration-v2/ThreadProjectMoveService.test.ts, ThreadProjectMove.test.ts, WorkspaceAttachment.test.ts, ThreadLaunchService.test.ts, mcp/toolkits/thread/projectMove.test.ts, packages/client-runtime/src/userMessage.test.ts.
- **Upstream:** none known.
- **Retire when:** upstream ships equivalent.
- **Decision:** `retain` (v0.1.1-nightly.20261020.3411, 2026-10-20): upstream's restored grouped-project new-thread selector (#22242) not adopted: new threads still start as No project and pick a project through the chip row, so the command-palette submenu and `_chat.tsx` picker shortcut stay out and `useHandleNewThread` keeps in-place draft retargeting. Earlier: `retain` (v0.1.1-nightly.20261020.3399, 2026-10-20): upstream's "New thread in…" checkout choice (#15636: command palette submenu, sidebar shift-click, `_chat.tsx` shortcut) is not adopted, because the fork's new threads start as No project and pick a project through the chip row; its now-uncalled helpers (`countSidebarProjectChoices`, the picker's `expandCheckouts` branch, `buildProjectActionItems`'s `disabled`, `useNewThreadHandler`'s `environmentSelection`) and their tests are removed. v0.1.1-nightly.20261020.3386, 2026-10-20, `adapt`: upstream's Scratch normalisation (`isScratchProject`) replaces the fork's duplicate scratch-root check in launches and scheduled tasks; Claude native forks still omit `dir` (upstream now passes the cwd), so a moved thread's session is found under its earlier folder. Earlier: `retain` (v0.1.1-nightly.20261019.3348, 2026-10-19): upstream's draft-headline picker fixes (full No project label, middle truncation) target the dropdown the fork replaced with its project chip row; upstream's `DraftProjectName` is left unused rather than deleted, to avoid a modify/delete conflict on every update. v0.1.1-nightly.20261019.3373, 2026-10-19: upstream's NVDA fix for the headline picker (#17877) not ported; it fixes an interactive picker inside the labelled `h1`, and the fork's chips sit outside it.
- **Owner:** #76 (open, slice) ; #126 relates (updater started in No project).

### project-themes

- **Kind:** durable extension
- **Why:** Each project has its own theme.
- **Requirements:** per-project themes with light/dark picks from the gallery, crossfade between themes, painted live in project settings; tinted project chips.
- **Integration points:** `useProjectTheme`, `useThemeCards`, `themePalettes`; project settings.
- **Proof:** none found.
- **Upstream:** upstream has themes; per-project theme is the fork's.
- **Retire when:** upstream ships equivalent.
- **Decision:** `retain` (seed, 2026-10-19).
- **Owner:** none.

### fleet-summary

- **Kind:** durable extension
- **Why:** a fleet sweep needs one bounded state read across all projects and linked environments.
- **Requirements:** `t3_fleet_summary` returns unsettled, non-archived threads, rolls up subagents, reports watches, cached Build state, settlement eligibility, sender counts for the last hour, and landing/release/host health. No transcript text; unavailable peers retain their last known observation; opaque cursors return changed rows and removals.
- **Integration points:** fleet contracts and service, projection tables, BuildWorkItems adaptive summary reads, ThreadSettlementService rules, SlipJayLandings runner, release approval projection, HostResources, peer MCP allowlist and toolkit registration.
- **Proof:** `apps/server/src/fleet/FleetSummaryService.test.ts`.
- **Upstream:** no equivalent identified in the assigned source; remote upstream research unavailable in the worker sandbox.
- **Retire when:** upstream supplies an equivalent summary with cross-environment availability and delta semantics.
- **Constraints:** Build state is read through the shared adaptive summary cache; release verification is the approval's stored observation, not a fresh promotion plan. No performance claim; #135 owns performance measurement.
- **Decision:** `retain` (new, 2026-10-19).
- **Owner:** pechhe/t3code#153, Spec #152.

### live-response-streaming

- **Kind:** opt-in extension (default is upstream's)
- **Why:** Sentence-paced "live" streaming makes threads calmer to read, for whoever accepts its CPU cost.
- **Requirements:** upstream's "paragraph" streaming and plain "Working for …" row are the default; choosing "Stream as it's written" ("live", per environment or project) turns on the calm look: sentence reveal, eased height and the `DotMatrixSpinner` working row; separate Response font; a client that does not announce `liveResponseStreaming` on its socket is shown "paragraph" instead of "live" (settings and project overrides), because shipped clients reject the whole config snapshot on the unknown value.
- **Integration points:** `AssistantMessageText` (`calm`), `ChatMarkdown` (`revealWords`), `WorkingTimelineRow` (plain vs calm, via `calmStreaming`), `SideChatCard`, `assistantStreaming`; settings.
- **Proof:** none.
- **Upstream:** none known.
- **Retire when:** measurement shows unacceptable cost, or upstream ships equivalent.
- **Constraints:** measured renderer CPU (Build #3172 finding 8; production web build, one ~1,500-word reply streaming for ~16 s): live 95% of a core, paragraph 82%, turn 33% (the working indicators alone), idle about 1%. Turning off the reveal loop and eased height cut live by about 17 points; turning off the dot-matrix animation halved the working baseline (about 26% to 13%). Most of the remaining streaming cost is upstream behaviour: `ChatMarkdown` re-parses and re-renders the whole message on every text change, so live and paragraph cost about the same.
- **Decision:** `retain` (v0.1.1-nightly.20261020.3411, 2026-10-20): upstream's revert of the composer-banner fade wrapper (#22227, reverting #8034) adopted; the fork's eased follow is unchanged. Earlier: `retain` (v0.1.1-nightly.20261020.3386, 2026-10-20): upstream's math and completed-Mermaid rendering integrated beside the opt-in word reveal and eased height; a message with math renders whole (see perf-markdown-blocks). Earlier: `retain` as opt-in (v0.1.1-nightly.20261019.3373, 2026-10-19): upstream's open-at-newest-message fix (#19663) and composer-banner fade wrapper (#8034) adopted; the fork's eased follow still replaces upstream's smooth end pin while a turn runs. Earlier (2026-10-19, Build #3172): the default follows upstream ("paragraph", plain working row) after the measurements above; the calm look stays selectable in Settings. Earlier (v0.1.1-nightly.20261019.3348): assistant line breaks stay in `AssistantMessageText`; upstream's Windows-path markdown plugin adopted in the timeline; upstream's hide-when-the-provider-turn-ended rule applied to the fork's bottom working row.
- **Owner:** Build #3172 (formerly pechhe/t3code#135).

### web-client-customisation

- **Kind:** durable extension
- **Why:** A set of small client behaviours the owner relies on.
- **Requirements:** (unverified full list) thread IDs copied from title/pasted/dragged into composer; copy a cited selection to paste into another thread; inline code chips copy on click, run button on command blocks; sound for settling a thread; settings search; subagent hover cards (tokens, markdown briefs); selected sidebar row as raised card; once projects span machines, every sidebar thread row shows its machine icon in the corner, replacing upstream's machine-name line on Scratch rows.
- **Integration points:** chat components, settings route, sidebar (`SidebarThreadRow` machine icon, upstream's `scratchMachineLabel`).
- **Proof:** none systematic.
- **Upstream:** none known.
- **Retire when:** each item individually superseded.
- **Decision:** `adopt` (v0.1.1-nightly.20261020.3438, 2026-10-21): upstream's pinned-thread fix (#22303) adopted; the sidebar row's pin sits before the project chip so hover controls no longer move it. Earlier: `retain` (seed, 2026-10-19): unknown whether each item still has needed behaviour; reclassify on first overlap.
- **Owner:** none.

### mobile-fork-screens

- **Kind:** durable extension
- **Why:** Mobile shows the fork's thread features.
- **Requirements:** Build item/header and sheet; workflow badge; release approval card; Jujutsu checkouts shown instead of "Not a repo"; experiments and delegation settings entries; agent browser setting.
- **Integration points:** `apps/mobile/src/features/threads`, `settings`, `state/build-work-items`; shared client-runtime state.
- **Proof:** apps/mobile/src/features/threads/git/jujutsuCheckout.test.ts.
- **Upstream:** mobile is upstream; the Screens dependency (docs/operations/mobile-screens-fork.md) is unchanged since baseline and not a fork difference of this record.
- **Retire when:** the corresponding server features retire.
- **Decision:** `adapt` (v0.1.2-nightly.20261021.3457, 2026-10-21): upstream's thread action undo (#21401), background-work sheet and status actions (#21395), proposed plans and the rest of the mobile batch adopted; the settle confirmation that names the background work it stops still comes before the mutation and undo claim, the Build item route sits beside the background-work route, and release-approval activity sits beside proposed plans. Earlier: `adapt` (v0.1.1-nightly.20261019.3373, 2026-10-19: upstream's standard list rows in the Git sheet (#21785) and shared settings writer (#9356) adopted, with the Jujutsu labels and agent browser setting kept; v0.1.1-nightly.20261019.3348): upstream's React Compiler versions of the home actions, thread feed, git controls and composer state adopted, with the fork's settle confirmation, Jujutsu labels and Build links reapplied without manual memoisation; the fork-only Agents and Build item sheets stay on the manual-memo allowlist.
- **Owner:** #107, #129, #145 (open); #43 (closed).

### desktop-fork-build

- **Kind:** deliberate behaviour change
- **Why:** The fork is installed locally, not from upstream releases.
- **Requirements:** no update feed (no `GITHUB_REPOSITORY`/`T3CODE_DESKTOP_UPDATE_REPOSITORY` at build) so the app never self-updates to the official nightly; local stable-identity signing; T3 Connect enabled in the build without a hand-placed `.env` (open); macOS screen-picker library staged; `T3CODE_AGENT_POLICY_ROOT` passed from login shell; partial-clone fork identity retained.
- **Integration points:** `scripts/fork-nightly.sh` (build env), `scripts/build-desktop-artifact.ts` (screen picker staging), desktop shell environment, `docs/operations/connect-setup.md`.
- **Proof:** scripts/build-desktop-artifact.test.ts.
- **Upstream:** none known.
- **Retire when:** the fork stops shipping its own desktop build.
- **Decision:** `adopt` (v0.1.1-nightly.20261020.3386, 2026-10-20): upstream's partial-clone remote parsing (#16316) replaces the fork's identity regex; build identity, display media and overlay wiring retained. Earlier: `retain` (seed, 2026-10-19).
- **Owner:** pechhe/t3code#77, #144 (open).

### nightly-app-icon

- **Kind:** deliberate behaviour change
- **Why:** The fork's installed app, a nightly build, carries its own mark, drawn from the machined composer: a knurled dial with T3 engraved and a peach index.
- **Requirements:** the desktop, web, iOS, Linux and Windows nightly icons show the dial; a simplified dial for 16–32px keeps T3 legible; Android nightly shows the white wordmark on anodised black (#1F2125), with peach as its notification colour.
- **Integration points:** `assets/nightly` (`dial.svg`, `dial-small.svg`, the `app-icon.icon` raster layer and its outputs), `scripts/export-android-icons.ts` nightly background, `apps/mobile/app.config.ts` preview colours.
- **Proof:** none automated; outputs inspected by eye. Rendered without Icon Composer, so `vp run icons:check` reports the nightly outputs stale until they are exported with it.
- **Upstream:** none; upstream's nightly icon (night sky) is replaced. An upstream change to nightly assets or the Android exporter conflicts here.
- **Retire when:** Henry drops the fork's own mark.
- **Decision:** `retain` (2026-10-20): new.
- **Owner:** none.

### fork-updater

- **Kind:** durable extension
- **Why:** Upstream nightlies reach the owner's machines unattended, reconciled with the fork's behaviour, without trading away a usable app.
- **Requirements:** every new upstream tag, clean or conflicting, is reconciled against this record and lands only through `slipjay land` with a fresh receipt (no direct push); one attempt per tag is in flight, duplicate deliveries and restarts resume it, a superseded attempt cannot be claimed again, and while an unlanded attempt is claimed or waits for an owner decision no other unlanded tag can be claimed; a claim that goes quiet for a redispatch interval is notified once, whether it holds back a newer tag or a landed build, and an update that lands while blocked on publication keeps that block and its `retry` route; an owner decision holds newer tags until answered, staying with its holding thread through a late duplicate claim or take-over until Henry answers there or `retry` runs; builds run through the agent, which first checks that no agent turn is running on the VPS; only landed source with a passing receipt check is built and activated, selected by source commit rather than version text; the installed app is replaced only after a complete, signature-verified copy exists, and an interrupted replacement is repaired from the replaced or previous build, with a journal keeping each build's receipt with it; a VPS install that switched the runtime but did not finish, or gave no answer, holds Mac installs until a build confirms the VPS, even when an earlier install of the same version and source had succeeded; an explicit recovery target stays selected until the next build, and source from before receipts is built only as one; failing to keep the replaced app as previous does not undo a finished install, and the next staged build waits until it is kept, so the one-step rollback is always the build immediately before the installed one; a staged build that is no longer the selected target is never installed; the install-on-quit job, started by an agent inside the app, survives the app quitting or being force-quit; status separates selected, staged, installed and active builds per destination.
- **Integration points:** `scripts/fork-nightly.sh` (launchd job, `T3FORK_VPS_CLONE` for the VPS checkout path, `build`, `install --on-quit` LaunchAgent, `attempt`, `status`), `scripts/fork-vps-runtime.sh` (source-bound install, `.fork-source`, `state` readback), `scripts/fork-upstream-receipt.ts` in the landing gate, `.agents/skills/t3-fork-rebase`, the T3 Peach webhook scheduled task (unbound, so each run gets a fresh SlipJay workspace), `~/.t3fork` state (`attempts/`, `selected.json`, `active-*.json`, `staged/receipt.json`).
- **Proof:** scripts/fork-nightly.test.ts, scripts/fork-vps-runtime.test.ts, scripts/fork-upstream-receipt.test.ts; reviewer fixtures from scripts/fork-reconcile-fixtures.sh.
- **Upstream:** none known.
- **Retire when:** not applicable while the fork exists.
- **Decision:** `retain` (v0.1.1-nightly.20261020.3438, 2026-10-21): upstream now prunes unused completed runtimes when a boot-service server starts (#22253); on the VPS an older fork runtime unused for an hour can be removed, which only matters for an app older than the VPS runtime, and recovery to an older build reinstalls its VPS runtime through `fork-nightly.sh build`. `.official` copies and pending archives are not version directories and are untouched. Earlier: `retain` (2026-10-19, Spec #142): redesigned so a clean merge no longer bypasses review and publication failure cannot stage a build.
- **Owner:** pechhe/t3code#142 (#122, #126, #143, #144, #151).

### fork-guidance

- **Kind:** durable extension
- **Why:** Keeps fork changes adoptable when upstream catches up.
- **Requirements:** `AGENTS.md` points fork work at `fork/README.md`; every deliberate difference updates its entry here in the same change; performance claims separate measured results from hypotheses.
- **Integration points:** the `## T3peach fork` section appended to upstream's `AGENTS.md` (a likely merge-conflict point; keep it at the end of the file), `fork/`.
- **Proof:** none (guidance).
- **Upstream:** none known.
- **Retire when:** not applicable while the fork exists.
- **Decision:** `retain` (2026-10-19, Spec #142).
- **Owner:** pechhe/t3code#142.

### perf-persistence-reads

- **Kind:** deliberate behaviour change (upstreamable performance fixes)
- **Why:** Reads queued on the single SQLite writer and trace volume erased evidence (#135).
- **Requirements:** non-mutating projection reads, client thread snapshots and the live shell streams' thread reads use readers, and each live shell batch (active and archived) reads its threads in one shell-snapshot read filtered by `threadIds`, not one `getThreadShell` per thread (pool of up to four, started on overlap; a connection wait is as interruptible as its caller, so a cancelled request leaves and a finalizer still writes); command decisions stay on the writer; decode outside transactions; branch pull request discovery reads only unarchived thread records with a branch, not full thread shells, for its per-minute sweep and per-thread refreshes; the settlement sweep skips threads without a branch or pull request whose inactivity timer is not yet due (the shortest configured timer, in SQL); successful sub-1 ms spans are dropped (kept if waited ≥5 ms or warned); rotated server trace files are gzipped (`server.trace.ndjson.<n>.gz`, about a tenth of the size) and 360 are retained (plain backups from before shift with them and age out), about a day at the 19 October peak of 150 MB/h, and the trace diagnostics RPC and `t3 trace` read them; a WebSocket RPC's server span is a child of the client's RPC span (Effect RpcServer tracing on with the `ws.rpc` prefix, which upstream turns off), so client and server traces of one request join.
- **Integration points:** `shared/nodeSqliteClient`, `persistence/DatabaseStorage`, `ProjectionStore` (`ShellSnapshotOptions.threadIds`, `getBranchPullRequestThreads`, `getSettlementCandidates` timer prefilter), `ThreadPullRequestService`, `ThreadSettlementService`, `ws.ts` shell streams, `ProjectionMaintenance`, observability config, `makeAsyncRotatingFileSink` (`compressRotated`), `TraceDiagnostics` (`toRotatedTracePaths`, `streamTraceFileLines`), `RpcInstrumentation` (`RPC_SERVER_TRACING_OPTIONS`) and `WS_RPC_SERVER_OPTIONS`.
- **Proof:** packages/shared/src/nodeSqliteClient.test.ts; apps/server/src/persistence/DatabaseStorage.test.ts; packages/shared/src/observability.test.ts; packages/shared/src/logging.test.ts (gzipped rotation); apps/server/src/diagnostics/TraceDiagnostics.test.ts (gzipped backups); apps/server/src/observability/RpcInstrumentation.test.ts (server span parented on the client's); apps/server/src/orchestration-v2/ProjectionStore.test.ts (shell snapshots scoped to chosen threads) and ThreadPullRequestService.test.ts (branch pull request reads); ProjectionSettlement.test.ts (settle timer prefilter).
- **Upstream:** the base design is upstream; the fixes touch central persistence (merge cost medium); open upstream #21628 batches settlement decoding but does not narrow the candidates, so the timer prefilter still applies when it merges.
- **Retire when:** upstream ships equivalent reader routing and trace sampling (retire per item).
- **Constraints:** installed-build measurement of writer `db.lock_wait_ms` is pending (#135); the compaction pass still scans all history; the isolated replay benchmark has not been run.
- **Decision:** `adapt` (v0.1.1-nightly.20261020.3399, 2026-10-20): upstream's persisted compaction cadence (#21880, a `compacted-at` file beside the database) and reader-side compaction discovery (#21881) adopted in place of the fork's `event-store-compaction` metadata row, which is no longer written; a restored database copy without the file compacts once more. Earlier: `adapt` (v0.1.1-nightly.20261020.3386, 2026-10-20): upstream's borrower ownership through statement execution (#21798) combined with the reader leases and caller interruptibility; the settlement timer prefilter gains upstream's `createdAt` fallback for never-run threads (#15783). Earlier: `retain` (v0.1.1-nightly.20261019.3348, 2026-10-19): reader routing kept; upstream's empty-filter skip in thread reads adopted beside it.
- **Owner:** pechhe/t3code#135 (open); #137–#139, #149 (closed); Build #3417, #3419, #3446 under Spec #3172.

### perf-secret-reads

- **Kind:** deliberate behaviour change (upstreamable performance fix)
- **Why:** The agent awareness relay read four secret files on every thread event it published, and each read queued on Node's I/O pool behind other file work.
- **Requirements:** `ServerSecretStore.get` answers repeated reads, missing secrets included, from memory; a write, create or removal through the store forgets the cache, and any change in the secrets directory (such as `t3 connect` writing from another process) clears it; when the directory can't be watched, every read goes to disk.
- **Integration points:** `auth/ServerSecretStore` (`makeAtDirectory`).
- **Proof:** apps/server/src/auth/ServerSecretStore.test.ts ("serves repeated reads without rereading the file", "sees a secret another process writes").
- **Upstream:** none known; upstreamable.
- **Retire when:** upstream caches secret reads or the relay stops reading secrets per event.
- **Decision:** `adapt` (v0.1.2-nightly.20261021.3457, 2026-10-21): upstream's atomic secret creation (#22559: write a temp file, then `link` it into place) adopted; `create` still forgets the cache, and the cache tests drive a controlled watcher stream instead of real-clock polling, per upstream's new test rules. Earlier: `retain` (new, 2026-10-20).
- **Owner:** Build #3418 (Spec #3172).

### perf-landing-refresh

- **Kind:** temporary workaround
- **Why:** A landing-watch reconnect refreshed every watched checkout once per retained landing (283 serial refreshes observed).
- **Requirements:** buffered landing changes are taken as one batch; one refresh per watched checkout per pass; landing changes refresh only the checkouts concerned.
- **Integration points:** `VcsStatusBroadcaster`, `SlipJayLandings`.
- **Proof:** apps/server/src/vcs/VcsStatusBroadcaster.test.ts.
- **Upstream:** none known (fork-only files).
- **Retire when:** landing state no longer fans out per retained landing, or SlipJay watch is redesigned.
- **Constraints:** cost grows as landings × visible workspace rows.
- **Decision:** `retain` (seed, 2026-10-19): installed-app confirmation of one refresh per checkout still pending.
- **Owner:** pechhe/t3code#134 (closed), #135 (open).

### perf-persistence-writes

- **Kind:** deliberate behaviour change (upstreamable performance fix)
- **Why:** The backend wrote ~200 MB/min into `statev2.sqlite`: every event is its own commit of ~27 WAL pages, and each checkpoint rewrites the pages it touched at random offsets.
- **Requirements:** Claude and Codex persist streamed text, reasoning and plans at most every 400 ms per item (upstream 50 ms for text), under the web reveal's ~0.45 s lag; completion still flushes at once. Allocated event ids end in a time-ordered UUIDv7, so the unique `event_id` index grows at each stream's right edge. The checkpoint worker starts at 4000 WAL frames (upstream 1000); the writer's backstop stays 10 000 frames.
- **Integration points:** `PROVIDER_TEXT_FLUSH_INTERVAL_MS` in `ProviderTextDeltaCoalescer`; `IdAllocator` event ids (`randomUuidV7`); `CHECKPOINT_FRAMES` in `shared/nodeSqliteClient`.
- **Proof:** packages/provider-core/src/server/IdAllocator.test.ts; packages/shared/src/nodeSqliteClient.test.ts; Claude and Codex adapter streaming tests. Replaying 5,697 real events (11.7 min of live traffic) through `EventSink` on a copy of the 8.3 GB live database: ~1,184 MB written before, ~831 MB after (−30%, runs vary ±5%). Live, the installed app went from ~0.29 to ~0.27 MB written per event.
- **Upstream:** none known; all three are upstreamable.
- **Retire when:** upstream persists streaming text less often and stops writing one commit per event.
- **Constraints:** ACP-based adapters (Antigravity, Grok, ACP registry agents) still persist one turn-item update per chunk; OpenCode and Cursor were not checked. Index maintenance is not the remaining cost: replaying 4,000 live events with eight unused indexes dropped wrote the same ~160 KB per event. Sharing one commit across 3/10/30 events saved 26/43/54%, so group commit in `EventSink` is the only large remaining lever. `orchestration_events` is the live log (rebuild, catch-up, command replay), so streaming events cannot skip it. Token-usage `provider-turn.updated` reports are ~20% of events (~30 per Claude turn) and could be held back now that no rollover reactor reads every report. Shrinking the existing database with a one-off migration is a non-goal: disk has room, and it rewrites live data for no write-rate gain.
- **Decision:** `adapt` (v0.1.1-nightly.20261020.3399, 2026-10-20): upstream's non-blocking WAL checkpointing (#21799: admission control, truncate handshake, writer-borrow fairness) adopted with the fork's 4000-frame start and 10 000-frame backstop kept (nodeSqliteClient.test.ts). Earlier: `retain` (new, 2026-10-19).
- **Owner:** YardSmith HQ Build #3350.

### perf-markdown-blocks

- **Kind:** deliberate behaviour change (upstreamable performance fix)
- **Why:** Every streamed update re-parsed and re-rendered the whole message, and the renderer context changed with the text, so finished paragraphs, links and code blocks rendered again on every token.
- **Requirements:** a message renders as its top-level markdown blocks, each memoised, so an update re-renders only the block it changed; a message whose meaning crosses blocks (link or footnote definitions, raw HTML, headings sharing an id, CRLF, extra remark plugins) renders whole; the calm word fade-in still covers only the newest two blocks; task checkboxes report offsets into the whole message; the file-link maps keep their identity while the message's links and code spans are unchanged.
- **Integration points:** `ChatMarkdown` (`ChatMarkdownBlock`, `ChatMarkdownTextContext`, `resolveMarkdownFileLinks`); `splitMarkdownBlocks` in `shared/markdownBlocks`, which takes upstream's incremental parser (`markdown-incremental`) for the parse that finds blocks.
- **Proof:** packages/shared/src/markdownBlocks.test.ts (block-by-block render equals whole render, for every prefix); apps/web/src/components/ChatMarkdown.browser.test.tsx ("does not re-render finished blocks", "later block" task edit, "fades in streamed words"). Replaying a ~1,200-word reply with headings, lists, code and links into `ChatMarkdown` in the browser test runner (dev build): 332 token updates took ~1.9 s before, ~0.85 s after; 39 paragraph updates ~250 ms before, ~190 ms after.
- **Upstream:** pingdotgg/t3code#21194 (open) caches settled messages' parsed trees; it does not cover streaming. Both are upstreamable and touch the same render call.
- **Retire when:** upstream renders streaming markdown incrementally.
- **Constraints:** finding the blocks still parses the whole message per update (incrementally once a closed code fence exists).
- **Decision:** `adapt` (v0.1.1-nightly.20261020.3386, 2026-10-20): upstream's math rendering integrated; a message with math or extra markdown plugins renders whole, since math can span blocks. Earlier: `retain` (new, 2026-10-19).
- **Owner:** Build #3172.

### agent-process-ledger

- **Kind:** deliberate behaviour change (upstreamable)
- **Why:** Claude Code runs each command in its own process group and stops them when it gets SIGTERM, but a server that crashes or is killed after the desktop's 5 s quit grace leaves the CLI running, and a CLI killed outright leaves its commands running (builds, `tail -f`, dev servers).
- **Requirements:** Claude, OpenCode, detached ACP runtimes (Grok and Antigravity), Pi, Codex app-server sessions and terminal PTY session leaders are recorded under the state directory and forgotten when they exit; at server start, and after the desktop has stopped its servers on quit (waiting up to 3 s for a server it stopped whose stop timed out to exit, and not at all for a live server it did not start), a recorded group whose owning server is gone gets SIGTERM, then SIGKILL after 2 s; a recycled pid (start time, group or command line differ) is never signalled. Codex keeps piped stdio and owns a detached POSIX group through the Effect spawner's POSIX default. Each adopter except OpenCode records its group through `trackUntilExit`, in the background, so spawning never waits on the process-table read; OpenCode keeps upstream's `OpenCodeServerLedger`, which records while the server starts and forgets when its scope closes.
- **Integration points:** `ProcessGroupLedger` in `provider-core/server` (upstream's OpenCode ledger, generalised; entries in `<stateDir>/provider-processes`); `OpenCodeServerLedger` wraps it; `layerQueryRunner`'s `spawnClaudeProcessGroup` in `ClaudeAdapterV2`; `AcpSessionRuntime`; Pi's `rpc.ts`; `CodexAdapterV2` client factories; terminal `Manager.trySpawn`; server layer in `server.ts`; the quit finalizer in desktop `DesktopApp.ts`.
- **Proof:** apps/server/src/orchestration-v2/Adapters/ClaudeAgentSdkQueryRunner.test.ts ("asks a CLI left by a server that died to stop, so it stops its commands"); packages/provider-opencode/src/server/OpenCodeServerLedger.test.ts; apps/server/src/provider/acp/AcpJsonRpcConnection.test.ts; packages/provider-pi/src/server/rpc.test.ts; apps/server/src/orchestration-v2/Adapters/CodexProcessGroup.test.ts; apps/server/src/terminal/Manager.test.ts.
- **Upstream:** upstream records only OpenCode servers (`opencode-servers`; an entry left there by an older build is not reaped).
- **Retire when:** upstream records every provider process group it starts.
- **Constraints:** Cursor now uses an in-process SDK, not an ACP CLI: its internal command spawns expose no owned child group here and are deliberately not recorded. Non-detached ACP children and Windows are not recorded, because their pid is not an owned POSIX group. Codex discovery probes are short-lived scoped processes and are not recorded. Pi's installed RPC SIGTERM handler kills its tracked detached commands; Codex's installed JS launcher forwards SIGTERM to its native child. Cleanup of commands that leave an ACP/Codex group depends on the CLI's own shutdown handling, which is not guaranteed here. A terminal's shell group is recorded because the manager cannot reattach its PTY after a crash, despite its Linux scope surviving restarts; shell job-control groups and deliberately detached jobs are not covered.
- **Decision:** `retain` (v0.1.2-nightly.20261021.3457, 2026-10-21): upstream's removal of a test-only export in `DesktopApp.ts` adopted; the quit finalizer still returns the stopped servers' pids for reaping. Earlier: `retain` (v0.1.1-nightly.20261020.3411, 2026-10-20): upstream's revert of its lifecycle-shutdown fix (#22222, reverting #20303) restores the 5 s desktop stop budget this entry assumes; the quit finalizer still collects stopped servers' pids for reaping. Earlier: `retain` (v0.1.1-nightly.20261020.3399, 2026-10-20): upstream keeps helper processes from outliving the backend for text generation (#12513) and traces the OpenCode ledger; the fork's generalised `ProcessGroupLedger` is kept and OpenCode still wraps it. Earlier: `retain` (new, 2026-10-19).
- **Owner:** Build #3416 and #3443 under Spec #3172.

### dev-state-tooling

- **Kind:** deliberate behaviour change
- **Why:** Dev work happens in many SlipJay workspaces and migrates live data.
- **Requirements:** deterministic dev port runner for multi-instance local workflows; `migrate-dev-db` keeps stopped lead families and tolerates foreign-key pruning; dev state should isolate per jj workspace (open, currently not recognised).
- **Integration points:** `scripts/dev-runner.ts`, `apps/server/scripts/migrate-dev-db.ts`.
- **Proof:** apps/server/scripts/migrate-dev-db.test.ts.
- **Upstream:** dev runner is upstream (unverified extent of fork edits).
- **Retire when:** upstream dev runner recognises jj workspaces.
- **Decision:** `adapt` (v0.1.2-nightly.20261021.3473, 2026-10-21): upstream's dev seeding (#22744, #22776) runs `migrate-dev-db` for a worktree home, and its rule keeping settled (unarchived) threads is adopted; the fork's family limits and foreign-key pruning still apply. Earlier: `retain` (seed, 2026-10-19).
- **Owner:** pechhe/t3code#66, #105, #127 (open); #49, #104, #106, #113 (closed).

### quiet-run-read-state

- **Kind:** durable extension
- **Why:** an agent turn with nothing to report finishes without raising its thread.
- **Requirements:** #155 / Spec #152: agents can finish a no-change sweep without making its bound thread unread or sending completion notifications. Failed/interrupted runs remain visible; explicit mark-unread overrides the quiet request. A completion alert waits 5 s and is dropped if the thread starts working again (a subagent return or queued message wakes it straight after a run ends).
- **Integration points:** `t3_thread_organize.mark_read`, ThreadManagementService, `thread.mark-read` / existing `thread.visited` event, optional `readOnCompletionRunId` in thread contracts and shell projection; shared client unread derivation, web notification decisions, shared mobile agent-awareness projection. The run-bound request survives restarts and is evaluated with completion, avoiding a second command's notification race.
- **Proof:** focused quiet-run cases in server `runtimeLayer.test.ts`, client-runtime projection and unread tests, web notification decision tests, and shared agent-awareness tests.
- **Upstream:** existing read/visit command path reused; live upstream lookup unavailable in this network-restricted workspace. A focused mark-read reverse is suitable for upstream consideration.
- **Retire when:** upstream supports successful-turn-bound read requests, explicit unread reversal, and quiet completion notification suppression on both clients.
- **Decision:** `retain` (v0.1.2-nightly.20261021.3457, 2026-10-21): upstream's silencing of notifications for a stopped run (#22615, `latestRunStopRequested` on the thread shell) added beside quiet completion in `agentAwareness` and `ThreadNotificationCoordinator`; it covers only manual stops, not the run-bound read request or unread reversal. Earlier: `retain` (v0.1.1-nightly.20261019.3373, 2026-10-19): upstream now sets a read watermark on a thread's first fresh dispatch so its completion shows unread (#15607); the run-bound quiet request still marks it read at completion.
- **Owner:** pechhe/t3code#155, Spec #152.

### subagent-return-chip

- **Kind:** deliberate behaviour change
- **Why:** upstream draws a subagent's finish notification as a second subagent card, so one subagent reads as two.
- **Requirements:** Spec #4329, #4360: each subagent shows once, as its start card updating in place, and the card stays visible after the response settles. Returns are chips (small avatar with status dot, title, verb by outcome, time, ↑) in timeline order outside the fold; adjacent chips share one wrapping row, and a batched delegated-task notification shows one chip per subagent. A chip highlights the card on hover and on click scrolls the virtualised timeline to it, expanding a collapsed parallel-subagent group when needed, then highlighting the card. Neither a response fold nor a superseded-attempt fold hides a card or a chip. The verb reports the notification's outcome even if the subagent later resumed; the card carries the live status. Inside an opened fold a wake shows as a quiet "woken by" divider above its row. One prompt's response shows only its last reply outside "Worked for N · N runs"; compaction dividers never fold. A notification naming no subagent the parent knows keeps the plain log row; a card in no loaded row opens the child thread instead. Mobile keeps upstream's plain rows.
- **Integration points:** `SubagentReturnChip` (finds its subagent by `subagentId` or `childThreadId`) and `SubagentTimelineLink` (`data-subagent-id`) in `V2LifecycleRow.tsx`; `SubagentReturnsTimelineRow`, `SubagentReturnChips`, `NotificationReturnChips`, `WakeDivider`, `SimpleWorkEntryRow`, `V2SubagentGroup` and the timeline's jump/highlight handlers in `MessagesTimeline.tsx`; `deriveTurnFolds`, `deriveSupersededAttemptFolds`, the `subagent-returns` row and `findSubagentCardRow` in `MessagesTimeline.logic.ts`.
- **Proof:** apps/web/src/components/chat/V2LifecycleRow.logic.test.ts, MessagesTimeline.logic.test.ts (`findSubagentCardRow`, "one request reads as one response").
- **Upstream:** reverses upstream #15281 (notification as subagent card) and supersedes #18099 (resumed subagent's notification shows live status).
- **Retire when:** upstream stops duplicating the subagent card for its notification.
- **Decision:** `retain` (#4329, 2026-10-20; extended by #4360, 2026-10-21).
- **Owner:** Spec #4329, Spec #4360.
