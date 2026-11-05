# Settings and project overrides

On web and desktop, the "Applying settings for …" sentence at the top of Settings pages picks
the project and environment a change applies to. Pages that only hold device preferences, such as
Appearance, don't show it. They start at **All projects** and **All environments**
and stay selected as you move between categories or search for a setting.

**Settings → Projects** holds a project's own settings, such as its name, icon, checkouts and
actions. It opens on the project you were working in; pick another in the sentence at the top.

When connected to Weave, a project's colour and icon sync with its repository in Weave.
Repositories match automatically from the Git remote. Weave lists only repositories a person has
registered in Weave under **Settings → Repositories**; a project whose repository is not registered there
does not sync. Set **Repository (Weave)** to a registered `owner/name` key to link a project by hand; clear it to restore automatic matching. Enable **Local only**
to keep a project's appearance independent. Changes sync when you edit them and every five
minutes; an offline connection retries when it is available again.

Preferences saved on this device, such as appearance, confirmations and browser profiles, always
show and ignore the selection. Everything else is stored on a server. Choose one environment to
edit its settings, or leave **All environments** to edit every connected environment at once.
Offline environments keep their current values; this is a bulk edit, not a synced global default.

Choose a project to override settings for it on the selected environments. A layers icon beside
each server row's title shows where the value comes from: the built-in default, the environment,
or a project override. Click it to see that chain on every selected environment. An override can
be reset to inherit again. Settings that cannot be overridden by a project are shown read-only
while a project is selected.

When the selected environments disagree, the control shows **Mixed** in place of a value and the
layers icon turns amber. Picking a value applies it to every selected environment.

Changing an environment value never touches a project's own override. When projects override the
setting you are editing, the layers icon counts them and the chain lists each one with its value:
click a project to jump to it, or **Reset all** to make those projects follow the environment
again.

Providers and diagnostics are per machine: they show one environment at a time, the primary
one until you pick another. Every other setting fans out to the selection.

With a project selected, a provider's switch in **Settings → Providers** turns it on or off for
that project only, in either direction: a provider off on the machine can be used in one project,
and one on everywhere can be kept out of another. That project's model pickers follow the switch,
and no new turn there can start on a provider it turned off, including queued messages and
follow-ups from delegated tasks. A turn already running when the switch flips finishes. A delegated
task's result still lands in its parent thread, which sees it on its next turn. Reset returns the project to the
machine's setting. Every other provider setting stays per machine.

On mobile, open **Settings** and use the filter in its header to choose connected environments
and a project. The filter stays available in server-setting pages. With **All projects** selected,
the server-setting pages, such as Threads, Source control and Worktrees, edit the selected
environments' defaults. Choosing a project edits its overrides on the selected
environments. Use **Use defaults** in a page to remove that page's project overrides.
Open **Settings → Projects** to rename the project across its selected
connected checkouts and see where those checkouts live.
Settings that are environment-wide stay read-only while a project is selected. When selected
targets disagree, a control shows **Mixed** until you choose one value. Appearance, keyboard,
and other phone-only settings ignore the filter.

## Pin and archive projects

Pinned projects come first in the project pickers: the project picker on a new thread, the
new-thread list, the command palette, the sidebar project filter, and mobile. In the boring sidebar, pinned projects get the top
folders, even with no active threads. Pin or unpin a project from its row in any of those lists,
or press the thread pin shortcut (`mod+shift+p` by default) on the highlighted row. **Pin
project** in the command palette and **Settings → Projects** work too. A list keeps its order
while it is open, so a new pin moves up the next time you open it.

Archive a project you are done with in **Settings → Projects**. It leaves the project pickers.
Its threads, settings, and files stay as they are, and archived projects still show in the
Settings project list, marked **Archived**. Choose one there and select **Unarchive** to bring it
back. On mobile, both are in **Settings → Projects → Organize**.

A project on several machines must have every machine connected to pin or archive it.

## Worktree branch names

In **Settings → Worktrees → Worktree branch naming**, choose a static prefix,
a model-selected semantic prefix such as `feat/` or `fix/`, or custom instructions
for the complete name. The static prefix defaults to `t3/`; a trailing slash is
optional, and an empty prefix adds nothing. Invalid characters in a static prefix
are replaced with hyphens. Custom instructions are appended to
the naming prompt and can specify issue IDs, namespaces, and casing.

These settings apply to automatically named new worktree branches. Select a project
to override its environment defaults. Worktree directories keep their original names.
If generation fails, or a custom name is invalid or already taken, the temporary
branch name remains.

## Champions

Use **Champions** to give an agent an ongoing responsibility for a project, such
as keeping page loads fast or tests reliable. Each champion shows the measurements
it tracks and an activity feed of findings, work and results.

Create a champion with a purpose and project, then ask it to propose metrics.
Setup and recurring checks follow separate agent classes from your role policy.
Changing that policy updates future attempts; work already accepted keeps its original selection. Review the suggested metrics,
edit them if needed, and accept them before enabling checks. Advanced settings
control the cadence, agent classes and the limits on automatic repairs. Older
fixed-model champions keep their choices until you select **Follow role policy instead**.

Expand a metric to inspect its source and history. Missing measurements are
unknown, not zero. Changing what a metric measures starts a separate series;
earlier readings remain available. **Ask AI to review metrics** asks the setup model for a
new proposal without silently changing the accepted definitions.

A champion can delegate bounded repairs within its instructions and limits.
Larger work goes through normal Spec shaping and delivery. Ordinary checks stay
out of the chat list; decisions and interrupted work come to your inbox. The
activity feed links to the underlying work. A champion can compare a small set of
read-only research options and bring you a recommendation with its trade-offs.
Answer on the finding to authorize the stated scope. If the recommendation changes
while you type, your draft is kept for you to reconsider.

Learning appears as dated activity notes. Expand one for its evidence and the
conditions for looking again. Older conclusions stay available; a note due for
review is uncertain, not deleted, and does not start another investigation by itself. A returned change or a landing alone
does not prove improvement: the champion needs comparable measurements of the
running version.

Pausing stops new scheduled checks, research and repair dispatch, while existing work
continues. **Cancel research** requests a stop; the page waits for confirmation.
A manual check while paused measures only. Resuming starts from the
next due time rather than replaying every missed check. Retiring stops future
checks and preserves the history and any unfinished work.

On native mobile, open **Settings → Champions** to see current readings, manage
checks and respond to findings or decisions. Create champions and edit metric
definitions on web or desktop; those clients also show the complete activity
history.

## Scheduled tasks

On web and desktop, open **Scheduled** from the sidebar's bottom row, next to Usage.
Your tasks are listed on the left; select one to edit it in place, or choose
**New task**, which opens the same view empty.

A task reads as a sentence: when it runs, which machines and projects it runs on,
where each run works, and which subagent role runs it. Pick several machines or
projects to run the same task in each: every machine runs its own copy, in each
chosen project it has. A project a machine lacks is skipped, and the editor says so.

- **A fresh workspace** gives each run its own checkout: a SlipJay workspace in a
  project with `slipjay.json`, a Git worktree elsewhere. **The project checkout**
  runs in the project folder itself, in a SlipJay project too.
- **The role** (such as implementation-worker) picks the model and effort from your
  delegation policy on each machine at every run, so a policy change reaches the
  task without editing it. The editor shows the model the role prefers.

The Scheduled icon shows a dot while a task runs and a count of failed runs you
have not opened yet; its tooltip gives the next run time.

A run's prompt appears in its thread as a **Scheduled task** message rather than
as yours, and the agent is told it is a routine trigger, not a new instruction or
an answer from you.

## Scheduled tasks on mobile

Open **Settings → Scheduled tasks** to create scheduled tasks or manage existing
ones across your connected environments. Use the settings filter to narrow the
list by environment or project. Each task runs on the environment you choose,
using its project, model, and workspace settings. Fixed-time schedules use that
environment's time zone, which may differ from your phone's. Choose **Once**
to run a task a single time at a date and time in your own time zone. If the
environment is offline then, the task runs when it is back.

Deleting a thread also deletes tasks that post into that thread. Tasks that start
a new thread on each run survive deletion of their previous threads.

You can edit, pause, resume, run immediately, or delete a task from the list.
Webhook tasks only run when their URL is called, so they can't be run
immediately.
Leaving an edited form asks before discarding unsaved changes.

## Webhook automations

In **Scheduled** in the sidebar (on mobile, **Settings → Scheduled tasks**), choose
**When a webhook arrives** as a task's trigger to run it whenever another service calls its URL, such as
GitHub on a new pull request or a CI job that failed. A public URL needs a
[T3 Connect](remote-access.md) managed tunnel; after you save the task, copy
its URL from the editor. Without one, the editor shows only the URL's path.
**Rotate** replaces the URL and the old one stops working.

The prompt decides what the agent sees. Placeholders pull values out of the
request: `{{body.path}}` for a JSON or form field, `{{headers.name}}`,
`{{query.name}}`, `{{body}}` for the raw body, and `{{request}}` for everything.
For example, `Review this PR: {{body.pull_request.html_url}}` sends only the
pull request link. A placeholder with no value is left empty.

Each value reaches the agent wrapped in `<webhook-data-…>` tags and marked as
untrusted request data. This helps the agent tell it apart from your
instructions, but it doesn't guarantee the agent ignores what the text says.
Inside a value, every `$`, other currency sign and `@`, and a `/` that starts
a lone word, gets an invisible character after it, so mentions like `$skill`,
`@file` and `/command` don't act. Text copied from a value, such as an email
address or a command, carries that character too. Without a signature, anyone
with the URL can start a run with any content. A signature only proves which
service sent the request: a GitHub payload still carries text written by any
GitHub user.

Each machine a webhook task runs on has its own URL. For GitHub, turn on **Require signature**, keep the header
`x-hub-signature-256`, hex encoding and the `sha256=` prefix, and enter the
same secret in the repository's webhook settings with content type
`application/json`. Requests without a valid signature are rejected. Set this
up on desktop or web; mobile keeps an existing signature check but can't turn
one on.

To run only for some requests, add **Filters**. Each one tests a value named
like a placeholder, without the braces, such as `headers.x-github-event` equals
`pull_request` or `body.action` is one of `opened, reopened`. A task runs only
when every filter matches; other requests are answered normally, logged as
**Filtered** with the first filter that failed, and start nothing. Values
compare as text, and a value that is an object or a list only passes
**exists**. Separate **is one of** values with commas; a value can't contain
a comma or start or end with a space.

To suppress repeated deliveries, set a **Duplicate request key** template, such as
`{{headers.delivery-id}}`. The same key is ignored for seven days per task.
To combine a burst, set a **Coalesce key**, such as `{{body.id}}`, and a window
of 10–3600 seconds (120 by default). One run uses the latest body, headers,
and query when the window from the first delivery closes; later requests
do not extend it. Pending windows survive a server restart. Keys must contain
request placeholders; if any placeholder is missing, or the render is empty,
that key's rule is skipped. Clear the templates to turn dedupe off.

Duplicate and coalesced log entries share a limit of 10 per task per minute.
Additional deliveries are accepted without a log entry, and coalesced deliveries
always replace the persisted payload. Coalesced updates count toward a separate
60-per-minute validation limit; exceeding it receives HTTP 429.

On desktop and web, pick **Deliveries** from a task's menu to see recent
requests and the prompt each one produced.

If the environment is offline, the sender gets an error and nothing runs;
redeliver from the sender, such as GitHub's **Recent Deliveries**, once it is
back. To have T3 Connect keep requests instead, turn on **Hold webhooks while
offline** in **Settings → Sharing & access**. T3 Connect then stores requests to a
T3 Connect URL for up to 24 hours and delivers them when the environment
returns. Leave it off if you don't want request bodies stored outside your
machine. To skip requests that waited too long, set **Skip requests older
than** on the task.

## Defaults and inheritance

Threads contains the model and workspace for new threads. Browser controls agent browser
access. Source control contains automatic pull, the default pull request merge method and text
generation. The same rows edit environment defaults or project overrides depending on the
project crumb.

The Projects category, under Code, holds the project's name, icon, actions,
checkouts and removal. Actions belong to a project: editing them creates the project's own list
on each selected environment, and reset returns to the environment's shared list. A project's
`t3.json` actions can be imported there.

Settings a repository can also declare in `t3.json`, such as the workspace for new threads,
resolve in one order: a project override, then the environment setting, then `t3.json`, then the
built-in default. Leave a setting on **Inherit** to let the next tier decide.
Browser access changes apply when an agent session next starts. Backend choices can allow the
integrated browser, Phi, or both, with one enabled browser as the default. Existing installations
keep the integrated default. An open tab keeps its original browser and profile when defaults
change.

Phi opens pages outside T3 Code's browser panel. Private checks use isolated incognito windows;
work needing your sign-in uses the shared Agents Space and waits when you take control. Hand
control back before asking the agent to resume. When you ask, an agent can also work in your own
window: it carries on in the tab you have selected, or opens a new tab beside it. It never closes
a tab it did not open there, and it needs Phi's Settings > Developer > "Allow agents to operate
your Spaces". If Phi is unavailable, the agent reports that failure rather than opening the page
in another browser.

Delegated browser, UI-verifier and UI-worker agents use Phi through T3 Code's browser tools only.
They have no shell, only the UI worker can change files, and none can touch another task's tabs.
They are refused up front,
with the reason, when browser access is off for the project, Phi is not enabled, the Phi skill is
missing, or Phi cannot be reached. Turning access off mid-task stops their browser actions, but
they can still close their own tabs.

Phi's key helper supports ordinary keys and Shift selection, but native Meta shortcuts are
unavailable. Agents replace text with `preview_type` and `clear=true` instead. Custom click and
typing deadlines are also unavailable; navigation accepts a deadline.
Servers with the skill installed elsewhere can set `phiBrowserSkillDirectory` in server settings;
the default is `~/.agents/skills/phi-browser`. New sessions use the changed directory.

### Bounded browser tasks

A delegated browser or UI-verifier agent on the integrated browser can hand a defined job to
`preview_task` instead of driving each step: reach a page, fill a form with values it supplies, or
capture one element. It runs only when the agent asks, and Phi tasks are refused. The agent names
the fields, the only clicks or URLs allowed, an explicit submit target and the checks that define
success; the supplied fields are filled directly, Jev only picks among the other steps, and the result is `passed` only when every check holds
on the final page. A run defaults to 12 actions, 16 decisions and 60 seconds, up to 24, 32 and 120
seconds. It holds the tab exclusively while it runs. Afterwards the agent keeps working in the same
tab, reading the page first if an action's outcome is `uncertain`, since a cancelled or unanswered
action may still have taken effect. A server restart ends the tab, so retrying the task is refused
rather than run again; the agent reads the page in a new tab first. It never enters passwords or
writes text of its own.

New worktrees initialize git submodules recursively. If that step is slow because the repository
declares many nested submodules, set **Submodules** in **Settings → Worktrees** under Advanced (with the project
selected to override it there) to **Top level only** to stop at the ones the repository declares
itself, or **Skip** to leave them for a setup script. It resolves in the same order as the
workspace default: a `"worktreeSubmodules"` value in the `t3.json` of the branch being checked out
applies when the project and environment are both on **Inherit**.

## Worktree location

New worktrees go in the `worktrees` folder of the T3 home directory. To put them somewhere else,
such as another drive, set **Settings → Worktrees → Worktree location** to an absolute path like
`D:\worktrees` or `~/worktrees`. The setting is per machine. Existing worktrees stay where they
are, and cleanup covers both the default folder and the custom one.

## Storage cleanup

Open **Settings → Worktrees → Cleanup** to enable automatic cleanup on one machine or all connected
environments. Policies are off by default and run on the server at startup, when changed, and
hourly. Offline machines keep their existing policies.

Select a project to set **Automatic worktree cleanup** to **Inherit**, **Off**, or **Custom**.
Inherit follows each machine's rules; Off keeps that project's worktrees until you remove them
manually. Custom applies separate worktree rules to the selected project or checkout. Browser
captures and log retention remain machine-wide.

Worktrees can be removed after a chosen number of inactive days, after a thread settles, after
merging, or when they have no commits beyond the default branch. Set settled retention to 0 days
to remove a worktree at the next cleanup after settlement. In repositories without remotes,
unchanged-worktree cleanup compares against the branch checked out in the project workspace;
if that checkout has a detached HEAD, the worktree is kept. Only T3-managed worktrees are eligible.
Active sessions and shared worktrees prevent removal. **Keep worktrees with local changes** defaults
to **Uncommitted changes**, which protects tracked edits and untracked files but deletes ignored
files such as `.env` and build output. **Any local files** also protects ignored files other than
`node_modules`. **Edited tracked files** protects only tracked edits and allows untracked and
ignored files to be deleted. Branches and thread history stay; starting another turn recreates the checkout.
Merge cleanup requires a merged pull request whose commits are included in the remote default
branch. A squash or rebase merge on GitHub also counts when the pull request targeted the default
branch and the worktree is still at the pull request's last commit.

Enable **Delete worktrees with deleted threads** to remove safe worktrees after their last
thread is deleted, including archived threads and worktrees left by earlier deletions. The
server waits for sessions and terminals to stop and retries skipped worktrees after restart.
Existing prompts for deleting a worktree manually remain available when this policy is off.

Choose **Delete now** to run the enabled rules immediately. The latest results show which
worktrees were removed or kept and why, plus any failures.
Results also list folders in the worktree folder that no thread uses, with their sizes; cleanup never removes them, so remove them manually if you want.

Browser captures and rotated logs have separate retention periods. Expired capture links stop
working. Current logs, message attachments, and browser profiles are kept.

## Project icons

Select the project and open Project to choose an icon, emoji, monogram, or image. The choice applies to
every checkout in the project group and appears on connected clients. Choose **Automatic** to let
T3 Code detect an icon again.

Choose **Monogram** in the icon picker to set one or two letters or numbers and a color.

When no image is found, web and desktop show a two-character monogram with a color
from the icon palette, derived from the saved project name. For example, `Nebula` becomes `NA`,
`Silver Orchard` becomes `SO`, and `M7 Forge` becomes `M7`.

## SlipJay policy

In a SlipJay project, select the project and open Project to see **SlipJay policy**: the settings
committed to the project's integration branch, which every machine and agent uses.

- Change the spare workspace count, the process level (**Standard** or **Light**) or the landing
  checks, then choose **Save**. Saving lands one change through the runner without running the
  landing checks; the section shows its place in the queue, then its landing, then the outcome.
- If someone changed the policy since you opened it, the save is refused as stale and the section
  shows the policy now in force. A check whose command does not exist on the runner is refused too,
  with SlipJay's reason, and nothing changes.
- **This machine's spares** lowers the spare count on the machine running your T3 Code server only.
  Choose **At most 0** to keep no spares there.
- The release branch, tracker, shared paths and generated paths are shown but are changed in
  `slipjay.json`.

Saving needs SlipJay 3.27.0 or later on the machine running your T3 Code server.

## Keep the default branch current

In Source control, enable **Automatically pull** to keep the default-branch checkout up to date
with its configured upstream. Choose an environment to set the default or a project to override it.
On mobile, use **Settings → Source control** to change selected environment defaults or project overrides.

T3 Code only pulls when it can fast-forward and the checkout has no changed files, untracked files,
or local commits. It skips checkouts on another branch or without an upstream. If a checkout has
local work, resolve it yourself before automatic pulls can resume.
