# Usage and limits

Open **Usage** from the sidebar or the command palette, or press `mod+u` on web and
desktop when the terminal is not focused. Customize `usage.open` in
**Settings → Keybindings**.

## Understand your usage

**Usage** combines Codex, Claude Code, Grok Build, OpenCode, Antigravity, Pi, and Cursor history
from your connected environments. It shows token use, cache savings, model breakdowns, and estimated API-equivalent
cost, split by token type and by speed. These estimates are not your subscription bill.
**Premium** is what Fast and Ultrafast requests cost above standard rates. Cost that cannot be
split, such as a provider-reported cost for a model without public rates, shows as **Other**.
Select a model under **Breakdown** to see its trend, cache hit rate, and cost per million tokens.

Totals depend on the history available on each server. Grok turns without a saved completed-turn
record are missing from the totals.

OpenCode reads its SQLite database and older JSON history. Antigravity reads local conversation
databases, including T3-managed profiles. Set `OPENCODE_DATA_DIR` or `ANTIGRAVITY_DATA_DIR` on the
server to read a different data directory; comma-separated paths read multiple directories.

Cursor reads account usage from Cursor's dashboard API using the CLI login saved on the server.
This includes headless T3 sessions and desktop usage across machines; the same account counts
once across connected environments. Without an accessible CLI login, T3 shows a
notice instead of incomplete local totals. T3 does not estimate missing tokens from conversation text.
On macOS, choose **Enable Cursor usage** on Usage to allow T3 to read your existing CLI login
from Keychain. You can turn it off in **Settings → Providers → Usage providers**. macOS may ask
you to allow access on the server Mac.

Usage includes each configured account's history, including disabled accounts. Custom homes follow
the account's home setting or its `CODEX_HOME`, `CLAUDE_CONFIG_DIR`, or `GROK_HOME` environment
variable. Pi reads `~/.pi/agent/sessions`, or the `sessions` directory under
`PI_CODING_AGENT_DIR`. Set `PI_CODING_AGENT_SESSION_DIR` to read a different session directory.
To include sessions saved through `--session-dir` or Pi's `sessionDir` setting, set this environment
variable to the same directory. Pi includes recorded tool and summary costs under `Tools/summaries`.
Use absolute paths or `~/` paths in the account's environment settings; relative environment paths
depend on each project's working directory and cannot be reliably discovered by Usage. Accounts
sharing a history directory count once.

When your app and server support different providers, usage totals may cover only the providers
your app understands. Update the app to include newly supported providers.

On web and desktop, use the environment dropdown to filter costs, tokens, and limits. All
environments are selected by default. The dropdown shows which environments are still scanning;
results appear as each one responds, and figures still updating are dimmed. Cursor shows its last
saved totals first, then updates them when Cursor's API responds.

If recent work is missing or a new model shows no cost, refresh to rescan session history and
update model pricing.

## Set custom model prices

On web or desktop, open the environment dropdown on **Usage**, then choose **Model prices** to add,
edit, or reset a model's estimated price. **Apply to** starts with your current Usage filter;
choose all environments or select individual destinations. Enter the exact model ID and USD
rates per million input and output tokens. You can enter any model ID, including models
without public pricing. When a model on **Usage** has no known price, select it under
**Breakdown** and choose **Set price** to open this table with that model added.

Cache read and cache write rates are optional and use the input rate when blank. Enter `0` for
tokens that are free. Saved prices replace automatic pricing for all of that environment's
history and are shared with clients connected to it. When environments have different prices,
cells show **Mixed**. Edit rates directly in the table, then choose **Save changes** to apply all
edited rows. Untouched cells keep each environment's rate. Select one environment to inspect its
prices. **Reset to automatic** marks a model's override for removal when you save; you can undo
it before saving.

To count one model as another, such as a preview model under its released name, enter the target
model ID under **Map to**. The mapped model no longer appears on **Usage**: its tokens and cost
move to the target model and use the target's price. Clear **Map to** or reset the row to show
the model on its own again.

Each destination reports whether the change saved. Offline or unavailable environments are
marked **Not saved**. Reconnect them and choose **Retry failed saves** to finish the same change
without writing again to environments that already saved. Changes are not queued after you close
the dialog.

## Track subscription limits

**Usage → Limits** pools every subscription account it can see per provider, so with several Codex
or Claude accounts across your environments and hubs you read one number per window rather than a
list. Each window card shows how much of the pool is left and a bar with one segment per account,
kept in the same column across windows. Accounts count by plan size: a segment is as wide as its
plan's multiplier (Max 20x is twenty times a Pro account), so the pooled figure is what is left of
your combined allowance, not an average of percentages. Accounts are ordered by their next 5-hour
refill, soonest first. For an account with no weekly quota left, this is when its session becomes
usable again. The first available window is used when no account reports a 5-hour limit. A gap means the
account does not report that window. When the provider reports reset times, the card also says
when the next reset lands and how much it hands back. The hatched
part of a segment is what that reset restores. Tap a segment or account row for the account's plan,
where it is signed in, and its reset time. On web, you can hover too. Codex and Claude accounts
with banked reset credits show a ticket count and the **Use reset** action in the account details.
Claude resets are not available when the server runs on macOS, where Claude keeps its login in the
Keychain. On narrow screens, numbered rows below
the bar show each account's quota, countdown, and credits. Tap a row to open its details.

The same account signed in on more than one environment, or reported by a hub as well, counts once.

In a thread, the same pooled 5-hour and weekly limits sit beside the composer when the window is
wide enough to fit them. Hover a segment for that account, or click **Usage left** to open this page.
Filter with the environment dropdown to see what a single machine has.

When a Claude or Codex account has no overall weekly quota left, its pooled session contribution
shows 0% left. The next refill depends on both reset times: an exhausted session must also reset,
and a partly spent session may only regain its unused portion when the week resets. Missing or
stale reset times have no refill estimate; refresh Limits for a new reading. Claude's
model-specific weekly allowances keep their reported values.

Opening Limits checks the selected connected environments automatically. Each client waits at
least five minutes between automatic checks of an environment, including after a failed check.
If a window still looks stale, refresh Limits to re-check every provider and hub.

Pick `/usage-limits` from the composer's command menu, or send it as a message, to check the
current model's limits without leaving the conversation. The result opens above the composer and
closes when you dismiss it or send your next message. It uses the same snapshot as **Usage → Limits**, so it does not run the agent or refresh
anything. The command is offered only for providers that appear under **Usage → Limits**.

OpenCode Go reports its session, weekly, and monthly allowance when OpenCode runs locally in
the environment. T3 cannot report limits for external OpenCode servers because their credentials
belong to the remote server. Limits need an OpenCode Go API key. A Console sign-in alone
does not report them. Add your Go API key as `OPENCODE_API_KEY` in the OpenCode instance's
**Environment variables**, then refresh provider status. Cursor reports
its monthly allowance, including separate Auto and API usage, using the CLI login or
`CURSOR_AUTH_TOKEN`. On macOS, this includes the default Keychain login after you enable Cursor
usage. Keychain login is used for limits only with Cursor's default API endpoint. If you configure
a custom Cursor endpoint, use an explicit token or file-based CLI login for limits.

Grok reports the remaining subscription allowance and reset time for its current billing period
after signing in with `grok login`. Explicit `XAI_API_KEY` connections and custom authentication
or endpoint configurations do not report subscription limits.

API-key accounts may not report subscription limits. This also applies to Claude connections
using a proxy through `ANTHROPIC_AUTH_TOKEN`.

## Connect a CLIProxyAPI hub

To see pooled accounts, open **Settings → Providers → Usage providers → Add hub**. Choose the
environment that will connect to the hub and enter its URL and management key.

The accounts appear under **Usage → Limits**. Codex accounts show banked reset credits; select an
account and choose **Use reset** to redeem one. No hub plugin is required.

This connection supplies usage information; configure
the provider separately to send agent requests through the hub. Remove the hub from the same
settings section when you no longer need it.

## Subscription usage widget

Add **Subscription usage** from your iOS or Android widget gallery to see remaining Codex and
Claude quotas. Tap it to open **Usage → Limits**; on Android this works while T3 is running in
the background, otherwise open the app from the launcher. On iOS, use **Edit Widget** to choose
Session, Weekly, or both for each provider. Reopen T3 to refresh expired readings.

## Keyboard shortcuts

On web and desktop, open Usage from the command palette. While on Usage,
press `C`, `T`, or `L` for Cost, Tokens, or Limits while not typing in a field.
Use `Ctrl+Shift+1/2/3/4` (`Cmd+Shift+1/2/3/4` on macOS) for the past
24 hours, 7 days, 30 days, or 90 days. Period shortcuts do nothing on Limits.
Press `Escape` to return to the previous page. Customize these shortcuts in
**Settings → Keybindings**.

## Compare configurations on normal work

Open **Settings → Experiments** on the environment where your agents run. Create a draft with a question, eligible projects or models, variants, an end date and a sample limit. Starting it assigns eligible new work to variants; it does not replay tasks or replace your defaults. A rollover experiment stays with its thread, while reviewer and delegation experiments stay with their delegated task. An instruction experiment, created by an agent with `t3_experiments_create`, also stays with its thread: each variant names a version of a skill or instruction section by source path, agent-config revision and SHA-256, and Claude and Codex threads receive their variant on top of their usual instructions on every run. Each run's setup record names the hash it received; your `~/.agents` checkout is never changed. A review task is one delegated to `ticket-reviewer` or `spec-reviewer`.

The rollover draft uses your environment's current policy as the control, keeps the same hard limit in both variants and moves one soft warning earlier. If your models use different rollover rules, narrow the eligible models to a shared policy first. The warning asks for a natural break; completing work without a handoff does not restart it. Provider-reported context capacity may reduce the effective thresholds to leave room for a safe handoff.

An orchestration-policy draft compares inline-first with delegate-earlier on non-UI work packages. Choose the parent model and effort, and enter the agent policy hash from `t3 agent roles` plus the reviewer policy and verification revisions; both arms hold these fixed. Each work package is assigned when its parent enrolls it, before the parent chooses inline or delegated execution (see [Enroll work before choosing how to execute it](outside-agents.md#enroll-work-before-choosing-how-to-execute-it)). Its report lists every assignment and exclusion, the assigned policy beside the actual allocation, parent and child usage coverage, and any child route that was refused before launch.

Pause stops new assignments. Resume admits new work again. Stop ends enrollment permanently. Existing assignments retain their settings through pauses, stops, retries and rollovers, so changing a trial's status does not silently change work already under way. Thread rollover holds still take precedence.

On mobile, open **Settings → Experiments** to inspect assigned variants and pause or stop enrollment. Create trials and compare full reports on web or desktop.

Judge the results using evidence of useful completion, corrections and rework alongside time and usage. Reports preserve original thread links, incomplete telemetry and assigned versus actual model selections. Context recovered is not billed tokens saved. Subscription token usage is not a monetary charge. Record outcomes with their evidence and distinguish human review from an automated judgement. Historical imports remain observational and are counted separately from randomized work.

Experiment reports list evidence episodes separately from outcomes. Agents can read their bounded, immutable bundles with `t3_experiments_read_evidence`, append evidence with `t3_experiments_record_evidence`, and record a versioned assessment with `t3_experiments_record_evaluation`. Follow pagination and missing-evidence markers. Rollover bundles capture warning policies, recent activity, submitted notes, delivery evidence and resumed work; their rubric requires unknown findings when the necessary evidence is absent. Evaluations can supersede earlier assessments without deleting them, and evaluator usage remains separate from the work being compared. Recording an assessment does not launch an evaluator or start enrollment.

Agents can use the `t3_experiments_*` tools to create drafts, control enrollment, inspect reports, record outcomes and import historical assignments. An experiment does not automatically promote a winning configuration.
