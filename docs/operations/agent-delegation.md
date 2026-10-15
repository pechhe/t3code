# Managed agent delegation

`t3 agent` and the delegation tools resolve roles and models from a central
agent policy kept outside T3 Code, in the agent-config repository
(`roles/policy.json` and the role briefs in `roles/`). Nothing is enabled until
the server is told where that checkout is.

## Turn it on

Set `T3CODE_AGENT_POLICY_ROOT` to the absolute path of the agent-config
checkout in the environment of the T3 Code server, then restart the server:

```sh
T3CODE_AGENT_POLICY_ROOT=/path/to/agent-config t3 serve
```

The desktop app reads the variable from your login shell, so export it there
(for example in `~/.zprofile`) and quit and reopen the app.

Without the variable, managed delegation is not configured: `t3 agent` commands
that need a policy fail with `policy`, and unmanaged delegation behaves as
before. Running trials are unaffected either way, and installing the code starts
no trial.

## Check a policy before pointing a server at it

On web and desktop, **Settings → Agents · Delegation** edits the configured
source policy. Settings permission is required; agents have no MCP tool to edit
it. Choose allowed models and preferences, set each role's effort and narrower
task-class lists, and preview the resolver's selection without starting a model.
Briefs remain read-only. A reviewer can additionally require a different provider
from the author's; when the author is unknown that requirement refuses the review.

Save validates the choices against the policy rules and installed model catalog,
advances the revision, and writes the policy file. Running tasks retain their
recorded snapshot. A concurrent source edit refuses the save and reloads the
current values. The page reports uncommitted source changes until you publish
agent-config through its normal workflow; saving does not commit or land it.
Unavailable accounts remain visible, and preview explains refusals. Removing a
demanding effort makes that model ineligible for demanding tasks.

```sh
node apps/server/scripts/validate-agent-policy.ts /path/to/agent-config
```

This reads and hashes the manifest and every role brief offline. It starts no
provider, signs in nowhere and touches no database. It prints the policy hash,
its revision and the seven role names, or the reason the policy is refused.

## What the server enforces

- Each task records the policy hash, brief hash and requested, assigned and
  effective selections when it is accepted. Editing the policy later does not
  change accepted work; it can only revoke authority at launch or resume.
- Claude reader roles use a restricted native tool list with no shell or T3
  tools. Claude writers require the destination owner's trusted-writer opt-in
  and a Full access child within the caller's permission ceiling. Codex writers
  keep their workspace sandbox with network access disabled. The Phi-based
  `browser` and `ui-verifier` roles remain unavailable.
- While a readable policy is configured, a delegation or reviewer trial is
  refused at creation, and again when it is started, if one of its arms uses a
  model no pool allows. Without a readable policy the check is skipped; dispatch
  still refuses the model.
- While a readable policy is configured, `delegate_task` delegates by role. A
  call without `agentTask` is refused unless it gives an `offPolicyReason`,
  which is logged as a deviation from the policy. Without a policy, unmanaged
  delegation is unchanged.
- An `isolated` task runs in its own registered workspace of the lead's
  repository on this computer, never the lead's checkout or the project's main
  checkout, and is refused while another thread is writing there. Its child
  thread launches, resumes and checkpoints in that workspace, and a finished
  writer reports the revision it hands back.
- A thread without an explicit workspace binding can delegate read-only work
  in its project's canonical root. Pass that exact root as `workspacePath`;
  other paths and isolated helpers still require an assigned workspace.
  Source-writing tasks require the lead's explicit workspace binding.
- A pool prefers a model from a different provider than the caller's (Codex for
  a Claude caller and the reverse), ahead of its own preference order; the
  caller's own account earns no preference. Set `"crossProvider": false` on a
  pool to use its preference order alone. `agent_roles` resolves for the same
  caller, so it shows the model a launch will use. If only one provider is
  eligible it is used.
- A follow-up to a task launched on a source revision must state the revision
  its workspace is at now. A task launched without one, as outside a
  repository, continues without one.
- A reviewer task must declare a `change` or `spec` review scope and its
  coverage. A new reviewer trial names the scopes it compares. A trial created
  before scopes existed admits only reviews that declare none, so the two kinds
  of review are never pooled.
- Reviews always use fresh independent context and enforced read-only source
  access. Keep `authorModel` truthful: the default prefers a different eligible
  model, but an explicit `target.model` may select the author's model when the
  reviewer pool, task classification, tools, source binding and caller permissions
  allow it. Check the choice with `agent_roles` using `model` and `authorModel`.
  After a runtime quota failure, a caller may start a fresh managed review with
  another allowed choice, including the author's model; quota failure does not
  widen the pool or automatically choose a fallback.

On **Settings → Agents → Delegation**, runtime behavior is stored in each T3
server’s settings, separately from the agent-config policy. Children inherit the
caller’s permission level by default. A configured default is capped at the
caller’s level; explicit requests above that ceiling are still refused. A change
applies to new delegations and leaves running children alone.

Idle advisor closing is off by default. Set a period in minutes to close advisors
whose final result has been delivered and which have no running or queued work.
The server checks every minute, including after a restart. Closed advisors remain
readable under Previous agents; start a new advisor for further work.

## Trusted Claude writers

On the destination server's **Settings → Agents → Delegation**, an owner can
allow trusted Claude writers. It is off on existing and new installations until
explicitly enabled. The effective child mode must also be **Full access**;
lower configured child defaults still apply. Eligible policy roles and accounts
remain required. The setting grants no publication authority.

Trusted host access lets Claude edit files and run shell commands with the
session's host permissions, including networking and access outside the assigned
checkout. The assigned workspace still limits the task's authorised work; T3
does not claim to confine that process to it. Managed native tools exclude
child-agent launch, inherited plugins, hooks, settings and MCP authority. This
controls the supported tools, not arbitrary commands a trusted shell could run.

Each task records its execution requirement and actual boundary. Set
`executionRequirement: "sandbox-required"` in a task request when host access
would be unacceptable. It cannot be satisfied by the trusted Claude route.
Legacy tasks retain restrictive semantics; a retry or reconnect cannot widen
them. Start newly authorised work to use the broader route. Disabling the owner
setting refuses subsequent trusted starts and continuations; running turns keep
their original treatment and can be cancelled explicitly.

All managed writers are checked for regular files with multiple hard links
before admission and protected starts. A refusal identifies the linked file.
This is a point-in-time guard against accidental alias corruption, not proof of
containment: external processes can change the filesystem after the scan.
The scan skips `.git`, `.jj` and `node_modules` at any depth: version control and
package managers hard-link those stores by design (pnpm does on Linux), and a
writer that edits inside them is not protected by this guard.
