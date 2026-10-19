# Fork differences

This record lists the material, deliberate differences between the T3peach fork (pechhe/t3code, branch `t3peach`) and upstream (pingdotgg/t3code): capabilities, behaviour changes and temporary workarounds, with the requirements that must survive an upstream update. Every fork change that adds or changes a deliberate difference updates its entry in the same change; upstream reconciliation reads this file to decide retain, adopt, adapt or defer. Entries state requirements and seams, not file catalogues; history lives in git, and tracker items (pechhe/t3code#N) own the work.

## Baseline

- Upstream: v0.1.1-nightly.20261019.3360 (`1451e7cb23034d29774338608368a15d8845df36`)
- Fork: `0b9a778d6e02dd97fab9808be606939a6562f467`

## Coverage

Seeded from `git diff 9c161462c9 d1d4354daf` (≈813 files, 265 non-merge commits) by directory and commit subject. "Classified" means mapped to an entry below; it does not mean every file in the area was read. Unverified items are marked in entries.

| Area                                                                                                                                                   | Status              | Entries or reason                                                                                                                            |
| ------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| apps/server/src/orchestration-v2 (rollover, watches, unattended, project move, advisor close)                                                          | classified          | context-rollover, thread-watches, unattended-threads, no-project-chats, managed-delegation                                                   |
| apps/server/src/orchestration-v2 (other edits: adapters, run/turn services, outbox, projection, recovery)                                              | unknown             | Many small edits (≈50 files) that hook the entries above or carry perf fixes; not individually classified                                    |
| apps/server/src/experiments, mcp/toolkits/experiments                                                                                                  | classified          | experiments                                                                                                                                  |
| apps/server/src/agents, cli/agent*, scripts agent-policy validator                                                                                     | classified          | agent-policy-roles, managed-delegation, t3-agent-cli, run-setup-records                                                                      |
| apps/server/src/mcp (service, toolkits)                                                                                                                | classified          | managed-delegation, run-setup-records, managed-browser-roles, build-items-hq, thread-terminal-read (in managed-delegation)                   |
| apps/server/src/hq                                                                                                                                     | classified          | build-items-hq                                                                                                                               |
| apps/server/src/vcs, project/SlipJay*, project/WorkspaceProvider, slipjay.json                                                                         | classified          | slipjay-workspaces, slipjay-landing, slipjay-release-approvals, slipjay-settings, slipjay-delivery-config                                    |
| apps/server/src/releases                                                                                                                               | classified          | slipjay-release-approvals                                                                                                                    |
| apps/server/src/peers                                                                                                                                  | classified          | linked-environments                                                                                                                          |
| apps/server/src/preview (Phi), mcp managed browser                                                                                                     | classified          | phi-browser-backend, managed-browser-roles                                                                                                   |
| apps/server/src/videoFrames                                                                                                                            | classified          | screen-recording-video                                                                                                                       |
| apps/server/src/scheduledTasks, scheduling                                                                                                             | classified          | scheduled-tasks-extensions                                                                                                                   |
| apps/server/src/provider, usage, orchestration-v2 UsageLimitRecoveryWorker, packages/shared providerPools                                              | classified          | account-pools                                                                                                                                |
| apps/server/src/persistence (Migrations 063–071, 073; DatabaseStorage; nodeSqliteClient)                                                               | classified          | migration numbering in context-rollover/experiments constraints; perf-persistence-reads                                                      |
| apps/server/src/auth, relay/AgentAwarenessRelay, terminal, sourceControl, textGeneration, ws.ts, serverSettings.ts, serverRuntimeStartup.ts, server.ts | unknown             | Edits hook fork features (settings, MCP auth, shell snapshots); not individually classified                                                  |
| apps/web components/chat (rollover band, device composer, side chat, streaming, annotator, fast switch)                                                | classified          | context-rollover, device-composer, image-annotation, side-chat, live-response-streaming, web-client-customisation                            |
| apps/web components/settings, routes settings.*                                                                                                        | classified (partly) | delegation-settings, experiments (settings), linked-environments, slipjay-settings; settings search and Projects entry: unknown              |
| apps/web SlipJay*/buildItem/ThreadWorkflowChip/AgentRoleChip/scheduled/usage/snapShot components                                                       | classified          | slipjay-landing, build-items-hq, thread-workflow-chip, scheduled-tasks-extensions, account-pools, snapshot-overlay                           |
| apps/web themes/sounds/lib (project themes, interface sounds, motion)                                                                                  | classified          | project-themes, web-client-customisation                                                                                                     |
| apps/desktop (snapShot, preview, window, ipc, build config)                                                                                            | classified          | snapshot-overlay, screen-recording-video, desktop-fork-build; other ipc/electron edits: unknown                                              |
| apps/mobile                                                                                                                                            | classified (partly) | mobile-fork-screens; Fast switch (#129) and pool account (#145) are open tracker items, not in this diff                                     |
| packages/contracts, packages/shared, packages/client-runtime                                                                                           | classified (partly) | Support types for the entries above; individual files not mapped                                                                             |
| packages/provider-core, provider-acp/opencode/pi/muse/cursor                                                                                           | unknown             | Small adapter edits (MCP session, orchestration instructions, subagent projection); not classified                                           |
| scripts/fork-*, .agents/skills/t3-fork-rebase, fork/, AGENTS.md fork section                                                                           | classified          | fork-updater, fork-guidance                                                                                                                  |
| scripts/build-desktop-artifact.ts, scripts/lib, apps/server/scripts (migrate-dev-db), dev runner                                                       | classified          | desktop-fork-build, dev-state-tooling                                                                                                        |
| native/screen-picker                                                                                                                                   | classified          | screen-recording-video                                                                                                                       |
| docs/user, docs/internals, docs/operations, docs/orchestration-v2                                                                                      | excluded            | Describe entries above; update with the owning entry. docs/operations/agent-delegation.md is the operations reference for managed-delegation |
| docs/operations/mobile-screens-fork.md                                                                                                                 | excluded            | Not changed since the upstream baseline; the Screens dependency is upstream-owned                                                            |
| pnpm-lock.yaml, package.json/dependency edits                                                                                                          | excluded            | Mechanical; regenerate after reconciling                                                                                                     |

## Entries

### context-rollover

- **Kind:** durable extension
- **Why:** Long threads continue in a fresh provider session carrying a handoff note, so context limits do not end work.
- **Requirements:** `/rollover` (bare opens an option menu; `on|off|pause|status`); per-thread hold and thresholds draggable on the composer band; soft and hard points; the agent writes a rollover note and is asked again if a turn ends without one; the note and T3's requests show as system rows; notes carry into queued user turns; rollover continues past a held queue and never re-rolls a fresh session before it grows; managed browser tasks have the note tool.
- **Integration points:** `ContextRollover*` services/reactor in orchestration-v2; `rollover` MCP toolkit; `contextRollover` settings; context-handoff services; `usage` events (reactor runs per usage report); experiment assignment lookups.
- **Proof:** apps/server/src/orchestration-v2/ContextRollover.test.ts, ContextRollover.integration.test.ts, ContextRolloverReactor.test.ts, ContextRolloverThresholdService.test.ts; apps/web/src/components/chat/rolloverCommand.test.ts; also in slipjay.json required verification.
- **Upstream:** none known. Upstream has context handoff (provider switching), which rollover builds on.
- **Retire when:** upstream ships an equivalent covering the requirements above.
- **Constraints:** per-usage-report work must stay cached per attempt (#140, #135 finding 7); upstream now also reports Claude context usage from stream message deltas, so reports per turn rose. Fork migrations 063–071/073 sit before upstream's own: upstream migrations take the next free fork number in upstream order (`DropUnusedV1Projections` 072, `CanonicalizeThreadPullRequestLinks` 074), and released fork numbers never move.
- **Decision:** `retain` (v0.1.1-nightly.20261019.3360, 2026-10-19): no upstream equivalent. Upstream now releases a held queue when the user sends from a client (#21473); rollover's own sends are agent/server and leave it held, so the held-queue integration test starts its run from an agent.
- **Owner:** none open (rollover work predates the tracker; #140 closed).

### experiments

- **Kind:** durable extension
- **Why:** Measures rollover, model and instruction policy on normal work instead of guessing.
- **Requirements:** experiment enrolment before execution; recorded per-run setup and episode evidence; cut points when a thread's setup changes (correct across late capture and restart); instruction lever overlay; retrospective evidence accepted or refused with an actionable reason; inspectable and manageable from web and mobile settings; rollover reviews capture instructions and full handoff (#132).
- **Integration points:** `ExperimentService`, `InstructionOverlay`; `experiments` MCP toolkit; migrations 063/066/068; `experiments` contracts/RPC; Settings → Experiments; `migrate-dev-db` copy rules (filtered rows' children).
- **Proof:** apps/server/src/experiments/ExperimentService.test.ts, ExperimentWork.test.ts, InstructionOverlay.test.ts; apps/server/src/mcp/ExperimentWorkMcp.test.ts; in slipjay.json verification.
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
- **Proof:** apps/server/src/agents/AgentPolicyService.test.ts, AgentRoleResolver.test.ts, AgentPolicySettingsService.test.ts; ScheduledTaskService.role.test.ts; in slipjay.json verification.
- **Upstream:** none known.
- **Retire when:** upstream ships an equivalent covering the requirements.
- **Decision:** `retain` (seed, 2026-10-19): fork-only, in landing gate.
- **Owner:** pechhe/t3code#2, #4, #5, #7, #9, #12, #19, #25 (closed); #146 open (cross-project pinned scout has no source-reading tools).

### managed-delegation

- **Kind:** durable extension
- **Why:** Agents delegate to managed subagents (advisors, readers, isolated writers) with enforced scope, independence and follow-up.
- **Requirements:** `delegate_task`/`followup` flows: any managed task can be followed up; advisors are reused and wait for published results; pinned read-only helpers share the lead's workspace but serialize with isolated writers; isolated writers validate their workspace at launch and hand back a revision; delegation to any registered project including No project chats; delegation skips models whose accounts are out of usage; idle advisors close per setting; a managed task's browser tabs close when it ends; agents can read their thread's terminal; default child permission level is a setting.
- **Integration points:** `OrchestratorMcpService` and `orchestrator` toolkit; `ManagedAgentService`, `followup`, `writerWorkspacePreflight`, `workspaceIdentity`; `AdvisorIdleCloseReactor`; provider MCP session wiring (`provider-core`); docs/operations/agent-delegation.md.
- **Proof:** apps/server/src/mcp/OrchestratorMcpService.test.ts, ManagedDelegation.test.ts, ManagedFollowup.test.ts, TaskCancelNativeSubagent.integration.test.ts; apps/server/src/agents/ManagedAgentService.test.ts, writerWorkspacePreflight.test.ts; orchestration-v2/AdvisorIdleClose.test.ts; in slipjay.json verification.
- **Upstream:** upstream has the base orchestrator MCP and subagents; the managed layer is the fork's. Overlap risk is high on `OrchestratorMcpService`.
- **Retire when:** upstream ships equivalent managed scope and follow-up covering the requirements.
- **Decision:** `retain` (v0.1.1-nightly.20261019.3348, 2026-10-19): upstream's base fixes adopted into the managed paths: worktree delegation refuses a parent checkout outside the project (non-SlipJay base only), `task_cancel` cancels the task's queued turn, the setup script skips the main checkout as well as managed tasks, and the orchestration instructions are split into sections under Codex's 4,000-byte entry limit. Those instructions say only when and why to delegate; field mechanics live once, in the `delegate_task` description.
- **Owner:** pechhe/t3code#14, #15, #17, #18, #31, #40, #62, #93, #131 (closed); open: #123, #136, #146.

### t3-agent-cli

- **Kind:** durable extension
- **Why:** Agents outside T3 (other harnesses) take part in T3-managed work through a thin authenticated CLI.
- **Requirements:** `t3 agent` commands reach delegation with the caller's auth; external work is recorded and status reports no pending question; an external attach works for a project registered in a repository subdirectory.
- **Integration points:** `cli/agent.ts`, `AgentCliClient`, `ExternalAgentWorkService`; migration 065; MCP/OAuth auth path; docs/user/outside-agents.md.
- **Proof:** apps/server/src/cli/AgentCliClient.test.ts, agent.test.ts; apps/server/src/agents/ExternalAgentWorkService.test.ts.
- **Upstream:** none known.
- **Retire when:** upstream ships an equivalent external-agent CLI covering the requirements.
- **Decision:** `retain` (seed, 2026-10-19).
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
- **Requirements:** job-based delegation settings with a resolution preview; fast-tier switch per model; role brief shown on hover; default child permission and idle-advisor closing.
- **Integration points:** Settings → Delegation route/components; agent-policy RPC; shared settings state.
- **Proof:** apps/web/src/components/settings/DelegationSettings.browser.test.tsx, DelegationSettings.logic.test.ts.
- **Upstream:** none known.
- **Retire when:** policy ceases to exist or upstream ships equivalent settings.
- **Decision:** `retain` (seed, 2026-10-19).
- **Owner:** pechhe/t3code#19, #20, #39 (closed).

### slipjay-workspaces

- **Kind:** durable extension
- **Why:** Threads run in SlipJay (Jujutsu) workspaces so parallel agent work lands through one guarded path.
- **Requirements:** Jujutsu VCS driver (status, diff, files, per-turn checkpoints, restore); jj repositories detected, including colocated checkouts and repositories whose checkout predates `slipjay.json`; repository detection stops at the nearest `.git` or `.jj`; new threads get an automatic workspace except explicit project-checkout launches; a landed thread gets a fresh workspace on its next message and keeps its strip after removal; a thread can move workspaces; Codex isolated writers can write the repository store; SlipJay errors keep their cause without raw CLI output; one owner for SlipJay project rules.
- **Integration points:** `VcsDriver`/`VcsDriverRegistry`/`JjVcsDriver`/`SlipJayProject`; `WorkspaceProvider` (workspace tools, allocation); checkpoint services; `VcsStatusBroadcaster`.
- **Proof:** apps/server/src/vcs/JjVcsDriver.test.ts, SlipJayProject.test.ts; apps/server/src/project/WorkspaceProvider.test.ts; apps/mobile/src/features/threads/git/jujutsuCheckout.test.ts.
- **Upstream:** none known (upstream VCS is Git).
- **Retire when:** upstream ships a VCS driver abstraction with Jujutsu/SlipJay workspace support covering the requirements, or the fork stops using SlipJay.
- **Constraints:** status refresh must not scale with landings × watched checkouts (see perf-landing-refresh).
- **Decision:** `retain` (v0.1.1-nightly.20261019.3348, 2026-10-19): the bootstrap thread keeps `rootIsDefault` under upstream's tolerant launch.
- **Owner:** pechhe/t3code#21–23, #41, #42, #45, #46, #50–54, #67 (closed); open: #108, #112, #125.

### slipjay-landing

- **Kind:** durable extension
- **Why:** Users see and act on what will land from a thread without leaving T3.
- **Requirements:** landing ticket above the composer and landing chip with live state; chip opens what the runner recorded; land from the thread panel; cancel or fix a landing; runner panel separates queue and run times; landing state survives workspace removal; Release is greyed out when a project has no release branch.
- **Integration points:** `SlipJayLandings`, `slipJayLandingState`; `SlipJayTicket`/`SlipJayLandingChip`/`SlipJayRunnerControl` components; landing-watch RPC stream.
- **Proof:** apps/server/src/project/SlipJayLandings.test.ts, slipJayLandingState.test.ts.
- **Upstream:** none known.
- **Retire when:** SlipJay delivery is dropped; no upstream equivalent expected.
- **Decision:** `retain` (seed, 2026-10-19).
- **Owner:** pechhe/t3code#24, #29, #30, #133 (closed); open: #107 (mobile ticket).

### slipjay-release-approvals

- **Kind:** durable extension
- **Why:** Releases from T3 need an approval card instead of silent publication.
- **Requirements:** review and promote a SlipJay release from T3; one approval card per repository, answered once, case-insensitive repository keys (open); scheduled-task prompts do not read as the user's.
- **Integration points:** `ReleaseApprovals`, `SlipJayReleases`; migration 073; `releaseApproval` contract; sidebar/thread card; mobile card; agent tool path.
- **Proof:** apps/server/src/releases/ReleaseApprovals.test.ts, ReleaseApprovalShell.test.ts; apps/server/src/project/SlipJayReleases.test.ts.
- **Upstream:** none known.
- **Retire when:** SlipJay delivery is dropped.
- **Decision:** `retain` (seed, 2026-10-19).
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
- **Requirements:** `slipjay.json` names `t3peach` as integration branch and lists the required landing verification (MCP orchestrator, experiments, agent policy, server and web typecheck, rollover tests, and the upstream receipt check `node scripts/fork-upstream-receipt.ts verify --landed origin/t3peach`), kept in SlipJay's settings through `slipjay policy set`, which also dropped the retired `parallelExecution` key; 8 spares ready; generated paths and evidence paths declared; all integration publication goes through SlipJay.
- **Integration points:** `slipjay.json`; SlipJay CLI contract; `.t3/userdata` generated path.
- **Proof:** the verification list itself (run via `pnpm exec vp test run …` as in slipjay.json); no separate test.
- **Upstream:** none known.
- **Retire when:** not applicable while the fork uses SlipJay.
- **Decision:** `retain` (seed, 2026-10-19).
- **Owner:** pechhe/t3code#3, #122 (open), #112 (open).

### build-items-hq

- **Kind:** durable extension
- **Why:** Threads link to YardSmith HQ Build Specs/Tickets and agents act in HQ as themselves.
- **Requirements:** link a thread to a Build item with header display and cards; Build links and #numbers render as live chips with cards; unreachable mentions and links from a previous HQ report clearly; lead and worker thread links on cards; per-thread HQ MCP connection and lifecycle; a raw delegated child gets no HQ server; mobile shows the Build item.
- **Integration points:** `hq/BuildWorkItems`, `HqAgentConnections`, `HqMcpRoute`, `HqAgentLifecycleReactor`; `buildWorkItem` contract; `shared/buildLinks`; web `buildItem/` components; client-runtime state.
- **Proof:** apps/server/src/hq/BuildWorkItems.test.ts, HqAgentConnections.test.ts, HqAgentLifecycleReactor.test.ts; packages/shared/src/buildLinks.test.ts; docs/user/build-items.md.
- **Upstream:** none known.
- **Retire when:** HQ integration is dropped.
- **Decision:** `retain` (seed, 2026-10-19).
- **Owner:** pechhe/t3code#74, #78–82, #92, #109–111 (closed).

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
- **Requirements:** thread keeps working after a completed run; questions are answered with the away answer whichever event arrives last; stance visible on the workflow chip.
- **Integration points:** `UnattendedReactor`; pending-question/approval events; thread workflow metadata.
- **Proof:** apps/server/src/orchestration-v2/UnattendedReactor.test.ts.
- **Upstream:** none known.
- **Retire when:** upstream ships an equivalent unattended mode.
- **Decision:** `retain` (seed, 2026-10-19).
- **Owner:** pechhe/t3code#118, #119, #120 (closed).

### thread-watches

- **Kind:** durable extension
- **Why:** A thread can wait on another thread or a Build item with `watch` / `unwatch`, alongside upstream PR watches.
- **Requirements:** wake a thread when a watched thread finishes; no firing between a background task ending and its wake; wake quotes the right earlier turn and does not repeat a result already read; settling a thread ends its watches, kills its pending background work and tells its watchers "Finished"; UI shows Watching label, links, and "Watched by". Build watches wake once when waits and holds clear (or Dropped), or on Landed/Accepted/Dropped for closed; they require the watcher’s project HQ connection and survive restarts.
- **Integration points:** `OrchestrationV2WatchTarget` and legacy watch decoding; `BuildWatchReactor` with the shared one-minute `BuildWorkItems` summary cache; `threadWatch`, `ThreadWatchReactor` (alongside upstream `PullRequestWatchReactor`); `shellThreadWatches` client state; `orchestrationV2PendingBackgroundWork`.
- **Proof:** apps/server/src/orchestration-v2/ThreadWatch.test.ts; packages/shared/src/orchestrationV2PendingBackgroundWork.test.ts.
- **Upstream:** PR watches exist upstream; thread and Build item watches are the fork's.
- **Retire when:** upstream ships equivalent thread and Build item waiting.
- **Decision:** `retain` (seed, 2026-10-19).
- **Owner:** pechhe/t3code#91, #97, #98, #101 (closed); #152 / #154 (thread and Build target watch surface).

### scheduled-tasks-extensions

- **Kind:** durable extension
- **Why:** Scheduled tasks need machines, projects, roles and webhooks beyond upstream's task model.
- **Requirements:** Scheduled page lists tasks beside an in-place editor; tasks span machines and projects and run as a subagent with a role; a task names the thread it posts into; run rows open their thread; webhook-started tasks (e.g. fork-nightly hand-off) work; scheduled prompts do not read as the user's.
- **Integration points:** `ScheduledTaskService`, `ScheduledTaskPrompt`; migration 069; `scheduledTask` contract; web `scheduled/` page; poll uses the SQLite reader.
- **Proof:** apps/server/src/scheduledTasks/ScheduledTaskService.role.test.ts; apps/web/src/components/scheduled/scheduledTasks.logic.test.ts.
- **Upstream:** upstream has scheduled tasks; the extension is a delta (unverified: webhook trigger origin, which may be partly upstream).
- **Retire when:** upstream ships equivalent machine/project/role scheduling.
- **Decision:** `adapt` (v0.1.1-nightly.20261019.3360, 2026-10-19): upstream's thread-bound runs follow the thread's current model adopted; a role (or the saved model) only picks the model of a fresh thread, so the editor locks the role picker for a bound task as it does the workspace.
- **Owner:** none.

### linked-environments

- **Kind:** durable extension
- **Why:** Agents and composers use threads across linked T3 environments.
- **Requirements:** link/unlink environments in both directions from Settings; short-lived read-only peer sessions renewed; search/list/read threads across environments; attach linked threads in the composer.
- **Integration points:** `PeerEnvironments`, `ThreadDirectory`; `peers` contract; migration none known; thread MCP toolkit.
- **Proof:** apps/server/src/peers/PeerEnvironments.test.ts, ThreadDirectory.test.ts.
- **Upstream:** none known.
- **Retire when:** upstream ships equivalent cross-environment thread access.
- **Decision:** `retain` (v0.1.1-nightly.20261019.3348, 2026-10-19): the MCP thread list and read descriptions carry both upstream's `pullRequests` note and the linked-environment text.
- **Owner:** pechhe/t3code#33–38 (closed).

### account-pools

- **Kind:** durable extension
- **Why:** Several subscriptions of one provider (Claude) act as one pool, spending allowance that would lapse soonest.
- **Requirements:** pooled turns go to the member whose weekly allowance lapses soonest, weighted by plan; a thread stays on its member while it has allowance; switch to the next member when a limit is hit with a handoff naming accounts; chosen member's usage is refreshed before routing (also for delegated tasks); usage card beside the composer; Claude forks find threads in an account's own home.
- **Integration points:** `shared/providerPools`; `ProviderRegistry`/`ProviderInstanceRegistry`; `ProviderSwitchService`; `UsageLimitRecoveryWorker`; usage sources; web `usage/` card.
- **Proof:** packages/shared/src/providerPools.test.ts; apps/server/src/orchestration-v2/UsageLimitRecoveryWorker.test.ts.
- **Upstream:** upstream has provider instances and usage limits; pooling is the fork's.
- **Retire when:** upstream ships equivalent pooled routing.
- **Decision:** `adapt` (v0.1.1-nightly.20261019.3360, 2026-10-19): upstream's empty session for an account with no weekly quota (members carry `refillPercent`) adopted; pool columns keep the plan `capacity`, and a reset restores its refill weighted by plan capacity rather than divided evenly.
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
- **Decision:** `retain` (seed, 2026-10-19).
- **Owner:** pechhe/t3code#32, #94–96 (closed); #26 open.

### screen-recording-video

- **Kind:** durable extension
- **Why:** Users record the screen from the composer and agents can see attached video.
- **Requirements:** record a screen/window from the composer on desktop and web (60 fps, pause, notch indicator, source change, kept across threads); stopping returns to the thread; attached video reaches agents as timestamped frames chosen where the screen changes; agents can request more frames over a time range; requires ffprobe; Record hidden in the SnapShot overlay.
- **Integration points:** `videoFrames/*`; provider turn message frames; desktop `ComposerDisplayMedia`, `ScreenRecordingIndicator`, `native/screen-picker`; `build-screen-picker.mjs`.
- **Proof:** apps/server/src/videoFrames/VideoFrames.test.ts, frameTimes.test.ts.
- **Upstream:** none known.
- **Retire when:** upstream ships equivalent recording and agent video input.
- **Decision:** `retain` (seed, 2026-10-19).
- **Owner:** pechhe/t3code#84–86, #89, #90 (closed); #83 open.

### snapshot-overlay

- **Kind:** durable extension
- **Why:** SnapShot is extended with an overlay window that is the main composer over the screen.
- **Requirements:** global shortcut (Space accepted, Option+Space records) shows a compact overlay composer; captures attach; overlay hands its chat to the new-chat page; keeps its conversation until ended; capture helper pre-started on macOS and exits with T3 Code.
- **Integration points:** `desktop/snapShot/*`, `SnapShotOverlayWindow`, `SnapShotProcessPool`; web route `snap-shot` and `surface=snap-shot-overlay` boot style in `index.html`; `CaptureShortcutConfig`.
- **Proof:** apps/web/src/components/snapShot/snapShotOverlayDock.test.ts; apps/desktop/src/snapShot/snapShot.test.ts.
- **Upstream:** SnapShot itself is upstream; the overlay is the fork's.
- **Retire when:** upstream ships an equivalent overlay.
- **Decision:** `adapt` (v0.1.1-nightly.20261019.3348, 2026-10-19): upstream's named macOS test-capture failures adopted on top of the fork's capture pool. The pool finds and captures the window in one helper, so a failed window lookup reports as a failed capture; upstream's separate window-lookup test does not apply and was dropped.
- **Owner:** pechhe/t3code#76 (open, overlay slice).

### device-composer

- **Kind:** durable extension
- **Why:** The fork's composer and sidebar use a machined, device-like look.
- **Requirements:** model slider and reasoning dial, machine switch, docked strips, lit screen, composer sounds; context bar always reads usage and marks rollover soft/hard points; machined sidebar base; Fast switch on the composer; themes can dye the metal.
- **Integration points:** `ChatComposer`, `ComposerControl`, `ComposerFastSwitch`, `sidebarDevice.css`, `composerFinish`, `sendMotion`, `interfaceSounds`.
- **Proof:** none found for look/feel; unverified browser tests (e.g. apps/web/src/components/Sidebar.motion.test.ts covers motion only).
- **Upstream:** none known; composer and sidebar are high-churn upstream files, so merge conflicts are likely.
- **Retire when:** the owner replaces the design.
- **Decision:** `retain` (v0.1.1-nightly.20261019.3348, 2026-10-19): visual identity of the fork; the composer host and workspace selectors stay removed, so upstream's shortcut tooltips on them do not apply.
- **Owner:** #117 (open, reasoning-effort step paths), #129 (open, mobile Fast switch).

### image-annotation

- **Kind:** durable extension
- **Why:** Users annotate composer images with numbered marks and notes.
- **Requirements:** numbered marks and notes with arrow tool, undo and kept focus; notes travel as their own context chip, survive reloads, leave with their chip, reach older servers as text and tell the agent the sent image's pixel size.
- **Integration points:** `lib/imageAnnotation`, `ImageAnnotator`; composer context chip contracts; `composerContextLegacySend`.
- **Proof:** apps/web/src/lib/imageAnnotation.test.ts; packages/shared/src/composerContextLegacySend.test.ts.
- **Upstream:** none known.
- **Retire when:** upstream ships equivalent image notes.
- **Decision:** `retain` (seed, 2026-10-19).
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
- **Requirements:** new threads start as No project with a project chip; a No project chat moves into a project (agents can do it; moved Claude chats start); a worktree request in the Scratch project runs in its own folder.
- **Integration points:** `ProjectMoveReactor`, `useMoveThreadToProject`, `useStartNewThread`; project contracts.
- **Proof:** apps/server/src/orchestration-v2/ThreadProjectMove.test.ts, ProjectMoveReactor.test.ts.
- **Upstream:** none known.
- **Retire when:** upstream ships equivalent.
- **Decision:** `retain` (v0.1.1-nightly.20261019.3348, 2026-10-19): upstream's draft-headline picker fixes (full No project label, middle truncation) target the dropdown the fork replaced with its project chip row; upstream's `DraftProjectName` is left unused rather than deleted, to avoid a modify/delete conflict on every update.
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
- **Integration points:** fleet contracts and service, projection tables, BuildWorkItems once-a-minute summary reads, ThreadSettlementService rules, SlipJayLandings runner, release approval projection, HostResources, peer MCP allowlist and toolkit registration.
- **Proof:** `apps/server/src/fleet/FleetSummaryService.test.ts`.
- **Upstream:** no equivalent identified in the assigned source; remote upstream research unavailable in the worker sandbox.
- **Retire when:** upstream supplies an equivalent summary with cross-environment availability and delta semantics.
- **Constraints:** Build state is read through the shared once-a-minute summary cache; release verification is the approval's stored observation, not a fresh promotion plan. No performance claim; #135 owns performance measurement.
- **Decision:** `retain` (new, 2026-10-19).
- **Owner:** pechhe/t3code#153, Spec #152.

### live-response-streaming

- **Kind:** deliberate behaviour change (performance under investigation)
- **Why:** Sentence-paced "live" streaming makes threads calmer to read.
- **Requirements:** setting for response streaming (live vs paragraph); separate Response font; a client that does not announce `liveResponseStreaming` on its socket is shown "paragraph" instead of "live" (settings and project overrides), because shipped clients reject the whole config snapshot on the unknown value.
- **Integration points:** `AssistantMessageText`, `assistantStreaming`; settings.
- **Proof:** none.
- **Upstream:** none known.
- **Retire when:** measurement shows unacceptable cost, or upstream ships equivalent.
- **Constraints:** suspected renderer cost (rAF reveal loop, height transition, per-sentence markdown re-render); unmeasured A/B pending in #135.
- **Decision:** `retain` (v0.1.1-nightly.20261019.3348, 2026-10-19): assistant line breaks stay in `AssistantMessageText`; upstream's Windows-path markdown plugin adopted in the timeline; upstream's hide-when-the-provider-turn-ended rule applied to the fork's bottom working row.
- **Owner:** pechhe/t3code#135.

### web-client-customisation

- **Kind:** durable extension
- **Why:** A set of small client behaviours the owner relies on.
- **Requirements:** (unverified full list) thread IDs copied from title/pasted/dragged into composer; copy a cited selection to paste into another thread; inline code chips copy on click, run button on command blocks; sound for settling a thread; settings search; subagent hover cards (tokens, markdown briefs); selected sidebar row as raised card.
- **Integration points:** chat components, settings route, sidebar.
- **Proof:** none systematic.
- **Upstream:** none known.
- **Retire when:** each item individually superseded.
- **Decision:** `retain` (seed, 2026-10-19): unknown whether each item still has needed behaviour; reclassify on first overlap.
- **Owner:** none.

### mobile-fork-screens

- **Kind:** durable extension
- **Why:** Mobile shows the fork's thread features.
- **Requirements:** Build item/header and sheet; workflow badge; release approval card; Jujutsu checkouts shown instead of "Not a repo"; experiments and delegation settings entries; agent browser setting.
- **Integration points:** `apps/mobile/src/features/threads`, `settings`, `state/build-work-items`; shared client-runtime state.
- **Proof:** apps/mobile/src/features/threads/git/jujutsuCheckout.test.ts.
- **Upstream:** mobile is upstream; the Screens dependency (docs/operations/mobile-screens-fork.md) is unchanged since baseline and not a fork difference of this record.
- **Retire when:** the corresponding server features retire.
- **Decision:** `adapt` (v0.1.1-nightly.20261019.3348, 2026-10-19): upstream's React Compiler versions of the home actions, thread feed, git controls and composer state adopted, with the fork's settle confirmation, Jujutsu labels and Build links reapplied without manual memoisation; the fork-only Agents and Build item sheets stay on the manual-memo allowlist.
- **Owner:** #107, #129, #145 (open); #43 (closed).

### desktop-fork-build

- **Kind:** deliberate behaviour change
- **Why:** The fork is installed locally, not from upstream releases.
- **Requirements:** no update feed (no `GITHUB_REPOSITORY`/`T3CODE_DESKTOP_UPDATE_REPOSITORY` at build) so the app never self-updates to the official nightly; local stable-identity signing; T3 Connect enabled in the build without a hand-placed `.env` (open); macOS screen-picker library staged; `T3CODE_AGENT_POLICY_ROOT` passed from login shell; partial-clone fork identity retained.
- **Integration points:** `scripts/fork-nightly.sh` (build env), `scripts/build-desktop-artifact.ts` (screen picker staging), desktop shell environment, `docs/operations/connect-setup.md`.
- **Proof:** scripts/build-desktop-artifact.test.ts.
- **Upstream:** none known.
- **Retire when:** the fork stops shipping its own desktop build.
- **Decision:** `retain` (seed, 2026-10-19).
- **Owner:** pechhe/t3code#77, #144 (open).

### fork-updater

- **Kind:** durable extension
- **Why:** Upstream nightlies reach the owner's machines unattended, reconciled with the fork's behaviour, without trading away a usable app.
- **Requirements:** every new upstream tag, clean or conflicting, is reconciled against this record and lands only through `slipjay land` with a fresh receipt (no direct push); one attempt per tag is in flight, duplicate deliveries and restarts resume it, and an owner decision holds newer tags until answered, staying with its holding thread through a late duplicate claim or take-over until Henry answers there or `retry` runs; builds run through the agent, which first checks that no agent turn is running on the VPS; only landed source with a passing receipt check is built and activated, selected by source commit rather than version text; the installed app is replaced only after a complete, signature-verified copy exists, and an interrupted replacement is repaired from the replaced or previous build, with a journal keeping each build's receipt with it; a VPS install that switched the runtime but did not finish, or gave no answer, holds Mac installs until a build confirms the VPS, even when an earlier install of the same version and source had succeeded; an explicit recovery target stays selected until the next build, and source from before receipts is built only as one; failing to keep the replaced app as previous does not undo a finished install, and the next staged build waits until it is kept, so the one-step rollback is always the build immediately before the installed one; a staged build that is no longer the selected target is never installed; the install-on-quit job, started by an agent inside the app, survives the app quitting or being force-quit; status separates selected, staged, installed and active builds per destination.
- **Integration points:** `scripts/fork-nightly.sh` (launchd job, `build`, `install --on-quit` LaunchAgent, `attempt`, `status`), `scripts/fork-vps-runtime.sh` (source-bound install, `.fork-source`, `state` readback), `scripts/fork-upstream-receipt.ts` in the landing gate, `.agents/skills/t3-fork-rebase`, the T3 Peach webhook scheduled task (unbound, so each run gets a fresh SlipJay workspace), `~/.t3fork` state (`attempts/`, `selected.json`, `active-*.json`, `staged/receipt.json`).
- **Proof:** scripts/fork-nightly.test.ts, scripts/fork-vps-runtime.test.ts, scripts/fork-upstream-receipt.test.ts; reviewer fixtures from scripts/fork-reconcile-fixtures.sh.
- **Upstream:** none known.
- **Retire when:** not applicable while the fork exists.
- **Decision:** `retain` (2026-10-19, Spec #142): redesigned so a clean merge no longer bypasses review and publication failure cannot stage a build.
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
- **Requirements:** non-mutating projection reads, client thread snapshots and the live shell streams' per-event thread reads use readers (pool of up to four, started on overlap; a connection wait is as interruptible as its caller, so a cancelled request leaves and a finalizer still writes); command decisions stay on the writer; decode outside transactions; event-store compaction completion is persisted so restarts do not rescan within 6 h; branch pull request discovery reads only unarchived thread records with a branch, not full thread shells, for its per-minute sweep and per-thread refreshes; the settlement sweep skips threads without a branch or pull request whose inactivity timer is not yet due (the shortest configured timer, in SQL); successful sub-1 ms spans are dropped (kept if waited ≥5 ms or warned), 60 trace files retained.
- **Integration points:** `shared/nodeSqliteClient`, `persistence/DatabaseStorage`, `ProjectionStore` (`getBranchPullRequestThreads`, `getSettlementCandidates` timer prefilter), `ThreadPullRequestService`, `ThreadSettlementService`, `ws.ts` shell streams, `ProjectionMaintenance`, observability config.
- **Proof:** packages/shared/src/nodeSqliteClient.test.ts; apps/server/src/persistence/DatabaseStorage.test.ts; packages/shared/src/observability.test.ts; apps/server/src/orchestration-v2/ProjectionStore.test.ts and ThreadPullRequestService.test.ts (branch pull request reads); ProjectionSettlement.test.ts (settle timer prefilter).
- **Upstream:** the base design is upstream; the fixes touch central persistence (merge cost medium); open upstream #21628 batches settlement decoding but does not narrow the candidates, so the timer prefilter still applies when it merges.
- **Retire when:** upstream ships equivalent reader routing, compaction watermark and trace sampling (retire per item).
- **Constraints:** installed-build measurement of writer `db.lock_wait_ms` is pending (#135); the compaction pass still scans all history; the isolated replay benchmark has not been run.
- **Decision:** `retain` (v0.1.1-nightly.20261019.3348, 2026-10-19): reader routing kept; upstream's empty-filter skip in thread reads adopted beside it.
- **Owner:** pechhe/t3code#135 (open); #137–#139, #149 (closed).

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

### perf-rollover-usage

- **Kind:** temporary workaround
- **Why:** Rollover reloaded runs and resolved experiment assignments on every usage report (638×/10 min).
- **Requirements:** active run cached per attempt; re-enrol only when inputs change; index-backed assignment predicates.
- **Integration points:** `ContextRolloverReactor.onUsage`, experiment assignment queries.
- **Proof:** apps/server/src/orchestration-v2/ContextRolloverReactor.test.ts (unverified: cache behaviour covered).
- **Upstream:** none known.
- **Retire when:** rollover usage handling is event-driven rather than per-report.
- **Decision:** `retain` (seed, 2026-10-19).
- **Owner:** pechhe/t3code#140 (closed), #135.

### perf-persistence-writes

- **Kind:** deliberate behaviour change (upstreamable performance fix)
- **Why:** The backend wrote ~200 MB/min into `statev2.sqlite`: every event is its own commit of ~27 WAL pages, and each checkpoint rewrites the pages it touched at random offsets.
- **Requirements:** Claude and Codex persist streamed text, reasoning and plans at most every 400 ms per item (upstream 50 ms for text), under the web reveal's ~0.45 s lag; completion still flushes at once. Allocated event ids end in a time-ordered UUIDv7, so the unique `event_id` index grows at each stream's right edge. The checkpoint worker starts at 4000 WAL frames (upstream 1000); the writer's backstop stays 10 000 frames.
- **Integration points:** `PROVIDER_TEXT_FLUSH_INTERVAL_MS` in `ProviderTextDeltaCoalescer`; `IdAllocator` event ids (`randomUuidV7`); `CHECKPOINT_FRAMES` in `shared/nodeSqliteClient`.
- **Proof:** packages/provider-core/src/server/IdAllocator.test.ts; packages/shared/src/nodeSqliteClient.test.ts; Claude and Codex adapter streaming tests. Replaying 5,697 real events (11.7 min of live traffic) through `EventSink` on a copy of the 8.3 GB live database: ~1,184 MB written before, ~831 MB after (−30%, runs vary ±5%).
- **Upstream:** none known; all three are upstreamable.
- **Retire when:** upstream persists streaming text less often and stops writing one commit per event.
- **Constraints:** ACP-based adapters (Antigravity, Grok, ACP registry agents) still persist one turn-item update per chunk; OpenCode and Cursor were not checked. Most remaining cost is per-commit index maintenance (eight `orchestration_events` indexes, six or more on turn items).
- **Decision:** `retain` (new, 2026-10-19).
- **Owner:** YardSmith HQ Build #3350.

### dev-state-tooling

- **Kind:** deliberate behaviour change
- **Why:** Dev work happens in many SlipJay workspaces and migrates live data.
- **Requirements:** deterministic dev port runner for multi-instance local workflows; `migrate-dev-db` keeps stopped lead families and tolerates foreign-key pruning; dev state should isolate per jj workspace (open, currently not recognised).
- **Integration points:** `scripts/dev-runner.ts`, `apps/server/scripts/migrate-dev-db.ts`.
- **Proof:** apps/server/scripts/migrate-dev-db.test.ts.
- **Upstream:** dev runner is upstream (unverified extent of fork edits).
- **Retire when:** upstream dev runner recognises jj workspaces.
- **Decision:** `retain` (seed, 2026-10-19).
- **Owner:** pechhe/t3code#66, #105, #127 (open); #49, #104, #106, #113 (closed).

### quiet-run-read-state

- **Kind:** durable extension
- **Why:** an agent turn with nothing to report finishes without raising its thread.
- **Requirements:** #155 / Spec #152: agents can finish a no-change sweep without making its bound thread unread or sending completion notifications. Failed/interrupted runs remain visible; explicit mark-unread overrides the quiet request.
- **Integration points:** `t3_thread_organize.mark_read`, ThreadManagementService, `thread.mark-read` / existing `thread.visited` event, optional `readOnCompletionRunId` in thread contracts and shell projection; shared client unread derivation, web notification decisions, shared mobile agent-awareness projection. The run-bound request survives restarts and is evaluated with completion, avoiding a second command's notification race.
- **Proof:** focused quiet-run cases in server `runtimeLayer.test.ts`, client-runtime projection and unread tests, web notification decision tests, and shared agent-awareness tests.
- **Upstream:** existing read/visit command path reused; live upstream lookup unavailable in this network-restricted workspace. A focused mark-read reverse is suitable for upstream consideration.
- **Retire when:** upstream supports successful-turn-bound read requests, explicit unread reversal, and quiet completion notification suppression on both clients.
- **Decision:** `retain` (new, 2026-10-19).
- **Owner:** pechhe/t3code#155, Spec #152.
