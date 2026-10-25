# Outside agents

Agents that T3 Code did not start can work with an environment through its MCP
server. They can read projects and threads, start and message threads, and
check which providers and models are available. This covers Claude Code or
Codex in your own terminal, ChatGPT, and bots that support MCP. Each agent signs
in once, and you choose what it may do.

## Get the MCP URL

In **Settings → Connections**, open a saved environment's menu and choose
**Copy MCP URL**. The URL is the environment's address followed by `/mcp`, for
example:

```text
https://<environment-address>/mcp
```

The copied URL uses the route this device is connected over, so an agent on the
same device can reach it.

- **An agent on your own computers** can use `localhost` on the host, T3
  Connect, or any `https` address, such as
  [Tailscale HTTPS](./remote-access.md#tailscale-https). Signing in sends the
  agent's credentials to the environment, and agents only do that over `https`
  or to `localhost`. A plain-`http` LAN or Tailscale address, like
  `http://100.x.y.z:3773`, lets an agent find the environment but not finish
  signing in.
- **A hosted agent**, such as ChatGPT or a bot running in the cloud, must reach
  the environment from the internet. Use the T3 Connect address. A Tailscale
  address only works from your own tailnet.

## Approve a sign-in

The first time an agent connects, it opens a sign-in page on the environment.
The page names the agent and where its access goes:

- For an agent on your computer, approval returns to a `localhost` address on
  the computer that opened the page.
- For a hosted agent, approval goes to that service, such as `chatgpt.com`.
  Anyone who runs that service gets the access.

Only approve a sign-in you just started. To approve, enter a pairing code from
**Settings → Connections** or from `t3 auth pairing create` on the host. A
browser already signed in to the environment with permission to manage access
can approve without a code.

Then choose what the agent may do:

- **Read only** is the default. The agent can read projects and threads and see
  the available providers and models. It cannot change anything.
- **Supervised** through **Full access** also let it start, message and stop
  threads in every project. A thread it starts or steers cannot run with more
  permissions than the mode you chose.

## Claude Code

```sh
claude mcp add --transport http t3 https://<environment-address>/mcp
claude mcp login t3
```

`claude mcp login` opens the sign-in page in your browser. On a machine
without a browser, add `--no-browser`, open the printed URL elsewhere, and
paste the final URL back when asked. `claude mcp list` shows `t3` as connected
once you approve.

## Codex

```sh
codex mcp add t3 --url https://<environment-address>/mcp
codex mcp login t3
```

`codex mcp login --no-browser` prints the sign-in URL instead of opening it.
`codex mcp list` shows `t3` with OAuth once you approve.

## ChatGPT

Add the environment as a custom MCP app in ChatGPT's apps settings:

1. Create a new app or plugin with a custom MCP server.
2. Set the server URL to `https://<environment-address>/mcp`, using the T3
   Connect address.
3. Choose **OAuth** for authentication. ChatGPT discovers the rest; you do not
   need a client ID or secret.
4. Create the app, then approve the sign-in page that opens.

## Other agents and bots

Any agent that supports remote MCP servers over HTTP with OAuth can connect. Give
it the MCP URL and choose OAuth, and the agent finds the sign-in settings itself.
Agents without OAuth support cannot connect.

## Scripts on the host

On the machine that runs the environment, `t3 thread` uses the same tools
without a sign-in:

```sh
id=$(t3 thread start . "Find why the tests are slow")
t3 thread send "$id" "Now fix it" --wait
t3 thread show "$id"
t3 thread list
```

`.` means the project that contains the current folder; a project id also
works. A new thread uses the project's default model and permission mode, and
runs in the project folder unless you pass `--worktree <base-branch>`. `send`
never interrupts: a busy thread gets the message as its next turn. Pass `-` as
the message to read it from stdin.

`--wait` prints the agent's reply. It exits 1 when the run fails or stops, and
2 when the agent waits for an answer you give in the app. Add `--json` for a
result that always includes the thread id.

## Remove an agent

Approved agents appear under **Settings → Connections** like other clients.
Revoke one there to cut off its access immediately. A sign-in lasts 30 days;
after that the agent asks you to approve it again.

## Delegate from a terminal agent

`t3 agent` lets a standalone Claude Code or Codex session submit a bounded task
without starting a second lead agent. The environment's maintainer must have set
up a model policy; see [managed agent delegation](../operations/agent-delegation.md).
Sign in with its MCP URL:

```sh
t3 agent login --endpoint https://<environment-address>/mcp
t3 agent attach --endpoint https://<environment-address>/mcp --request-file session.json
t3 agent roles --endpoint https://<environment-address>/mcp --request-file roles.json
t3 agent submit --endpoint https://<environment-address>/mcp --request-file task.json
```

Open the login URL printed in the terminal and approve that sign-in. Credentials
stay in a private local store; they are never part of the task file. Use
`--request-file -` for JSON on stdin. Each command's `--help` lists its options.

The session file identifies the project, external session and exact workspace
on the destination computer. Use the assigned SlipJay workspace when the project
uses SlipJay. T3 rejects paths on the wrong host or from another repository.
The returned session key goes in subsequent role and task requests. A task carries
a canonical role, task class, work ID, attempt ID and transport request ID;
review tasks also pin the source revision. Role discovery explains unavailable
models and unsupported execution boundaries before you submit. Claude writers
require the destination owner's trusted-writer opt-in (**Settings → Delegation →
Let Claude helpers write with full access**) and an effective Full access child. This allows shell networking and host filesystem access beyond
the assigned checkout; the task's authorised scope remains its assigned work.
Use `"executionRequirement": "sandbox-required"` when that access is unacceptable.
Browser and visual-check roles remain unavailable through this route. See
[trusted Claude writers](../operations/agent-delegation.md#trusted-claude-writers)
for enablement and migration semantics.

The session's workspace is the lead's own. To run a helper at the same time as
the lead, allocate it a separate workspace of the same repository (with SlipJay,
its own workspace) and submit with `"workspaceAssignment": "isolated"` and that
path. T3 refuses the lead's own checkout, the project's main checkout, a
subdirectory, another repository and a workspace another task is already writing
in. The helper stays owned by the same session. When it finishes, `status`
returns a `handoff` with the exact revision to adopt and whether the workspace
was clean. Adopting it into the lead's candidate is the lead's job and is not a
landing.

A review task pins the candidate as `sourceRevision` and declares `review`:
`"scope": "change"` for a candidate landing, with its `baseRevision` and the
`includedChanges` attributed to it, or `"scope": "spec"` for a Spec's integrated
outcome, with `specRef` and the `specRevision` of the body read. `coverage` says
whether the review covers the whole landing or Spec (`complete`) or only part
(`partial`). A follow-up review of material changes since an earlier one sets
`priorReview` to that review's work ID and source revision, with the same source
as its `baseRevision`. Use `ticket-reviewer` for a change and `spec-reviewer`
for a Spec; both run read-only with fresh context. Codex and Claude enforce that
read-only access natively; another provider's reviewer runs under its account's
own permissions.

Keep the same work and attempt IDs when retrying a submission, including after a
disconnect or server restart. Use a new attempt ID for new execution of that work,
after the previous writer has stopped. The response includes a task ID, selections
and any experiment assignment IDs. `status`, `wait`, `cancel` and `evidence` take
that task ID. Waiting is bounded and does not cancel work when its timeout expires;
disconnecting the terminal also leaves accepted work running. `outcome` records
the owning caller's claim against a returned assignment ID as self-report.

To continue a task of any role in its existing conversation, submit
`followup` containing one of its task IDs as `taskId`, the workspace's current
`sourceRevision` and the `changes` since its previous task. Keep
`externalSessionKey`, supply a new stable `clientRequestId`, and put the question or
correction in `task`; omit `agentTask` and target or runtime overrides. Use it for
repeated advice on one piece of work, to send a worker its corrections instead
of starting a fresh one, and to finish a reviewer or UI verifier that stopped partway. The same conversation, model, workspace and permissions
are reused, with a separate task ID and result for each follow-up. Tasks originally started
with a source revision are checked against the
follow-up's revision. Workers started without a pin stay unpinned as they write.
Finish one task before starting the next. Cancel any of its task
IDs when the work ends; this closes the whole conversation and prevents further
reuse. A verified-completion or cancellation outcome for experimental work also
prevents further follow-ups; reported failures can still be corrected.
A new review round started fresh, with the prior findings in the brief, is the caller's choice when it wants an independent judgement.
Conversation reuse reduces repeated briefing, but prompt caching and its savings
depend on the provider and timing.

Revoking the sign-in in Connections, or allowing it to expire, stops its owned
work and denies further access. `t3 agent logout` removes the local credential;
it does not revoke the server grant. After expiry, log out and sign in again.
A new sign-in has a new owner and cannot adopt the old sign-in's tasks.

## Enroll work before choosing how to execute it

An explicitly authorised orchestration-policy experiment compares `inline-first`
with `delegate-earlier`. Creating a draft or installing this code does not start
one. Both arms retain the same parent selection and effort, central agent policy,
review and verification revisions, and concurrency limit. Running worker-model
trials cannot overlap this treatment in the same eligible project scope; historical
reviewer trials and observational imports keep their original route and provenance.

Use `t3 agent work-enroll --endpoint <server> --request-file <json>` before choosing
inline or delegated execution. Supply `workId`, `description`, `taskCategory`,
the attached `externalSessionKey`, and `reportedOrchestratorSelection` (including
its effort option). Set `alreadyStarted` for work that has begun: it is excluded
from prospective assignment. `sourceRevision` can pin the source for child work.
The returned unit includes its `assignedPolicies` and controls, immutable policy
snapshot and assignment IDs. Repeating the same request returns that original
assignment across reconnects or retries; changing its work description or source
under the same identity is refused.

Record the choice with `work-allocate`: `id`, `workUnitId`, `allocation` (`inline`
or `delegated`), a practical `reason`, and nullable `deviationReason`. A changed
allocation or exception to the assigned policy needs a reason. For delegated work,
include the unit ID as `agentTask.workUnitId` in `submit`. T3 pins that policy and
checks the workspace and source before the task starts. Inline implementation needs no implementation task or artificial child. Optional
advisor and independent reviewer tasks can link to the same unit without changing
its implementation allocation; their usage remains part of the total. Advice can
inform allocation after enrollment, and review follows an allocation decision.

`work-evidence` records parent attribution and intervals for briefing, startup,
wait, execution, inspection, rework, verification or advice. External parent usage
must have a stable `externalSegmentId`; it remains a self-report. In a T3 parent,
whole-turn attribution names its own `threadId` and `providerTurnId`: the server
uses provider counters and refuses reuse of that turn for another unit. If a turn
interleaves Tickets, enroll a coherent wave/session or mark the attribution partial
rather than charging the full turn to each Ticket. Child telemetry comes from the
linked tasks automatically, including their attempts and continuations.

`work-outcome` records an outcome against an enrollment's assignment ID without a
task ID. CLI and MCP model claims remain `self-report`; they cannot establish
independent acceptance. Evidence-linked human or independent acceptance uses the
existing trusted experiment outcome service. Failures, cancellations, rework,
constraint misses and later validated defects remain attached to the assigned unit.

`work-read` returns parent/child coverage, observed usage and total-usage missingness,
requested/assigned/effective child bindings, actual allocation and deviations.
Parallel activity is unioned rather than summed as elapsed completion; observed
overlap does not prove useful work. Missing parent counters are not zero. Partial
coverage leaves complete total token counts null, while retaining observed subtotals.
Experiment reports preserve the full intention-to-treat denominator and exclusions
when detailed work is paginated. These are descriptive samples, not significance,
subscription charges or an automatically promoted winner.

## Read a workspace

An agent attached to a workspace (`t3 agent attach`, or `agent_session_attach` over
MCP) can inspect that exact checkout without starting a helper, opening a shell or
getting write access. It needs a **Read only** sign-in or better and the session key
from the attach. Nothing is copied: each tool reads the checkout as it is now.

1. `workspace_read_context` returns the VCS type (Git or Jujutsu), the current
   revision and parents, uncommitted changes, and a **token**.
2. `workspace_search`, `workspace_read_file`, `workspace_vcs_status`,
   `workspace_vcs_log` and `workspace_vcs_diff` take the session key and that token.
3. `workspace_test_evidence` shows the SlipJay landing result already recorded for
   the workspace. It runs nothing.

If the workspace changes after the token was issued, every call fails with
`stale_source`; call `workspace_read_context` again. Paths are relative to the
workspace root. Ignored files, binary or oversized files, credential and key
files, runtime stores such as `.t3`, `.git` and `.jj`, and files containing secret
material are refused, and diffs leave them out. Results are capped (about 20 KiB
per call) and continue with a `nextCursor`.

A Jujutsu working copy is read without snapshotting it, so `snapshotAt` shows when
jj last recorded it. Edits made since are found by comparing the disk with that
snapshot and are marked `disk` in the change list. This is bounded: only files
modified at or after the snapshot are compared, at most 25 by content (the rest
are listed as modified), and a very large tree or an unreadable ignore list sets
`observationComplete` to false. A file rewritten with its old modification time
(`cp -p`, `rsync -a`) is not noticed in jj. Git working copies are exact.

Linked environments cannot use these tools. `workspace_test_evidence` reports
the SlipJay landing recorded for the workspace, with its checks and the commit it
published. `sourceMatch` is `current` only when that landing published exactly
this clean revision, `stale` for a finished landing of other source, `unverified`
for one still running, and `none` when nothing was recorded. A command you ran
inside T3 is not part of this record.
