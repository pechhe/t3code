# Pi

T3 Code can use your existing Pi coding agent installation while keeping Pi's models, auth,
extensions, skills, context files, and native session history.

## Set Up Pi

1. Install [Pi](https://pi.dev) on the machine running the T3 Code server. Pi requires Node.js
   22.19 or newer; its platform installers can install Node if needed. T3 Code supports Pi
   1.0.4 or newer.
2. Run `pi` in a terminal, then `/login` to connect your model provider or configure its API key.
3. Open T3 Code Settings, enable Pi, and refresh the provider.

For an npm installation, use:

```sh
npm install -g --ignore-scripts @earendil-works/pi-coding-agent
```

If `pi` is not on the server's `PATH`, set Pi's binary path to the executable. Provider environment
variables and launch arguments are also available for installations that need a custom agent
directory, endpoint, or model configuration. `--provider` must be paired with `--model`. T3 Code
rejects launch arguments that change Pi's execution mode or select a session because T3 owns those
parts of the process lifecycle.

On a remote or headless server, connect to that machine over SSH and run `pi`, then `/login`.
Open the authorization URL on your own computer. If the callback cannot reach the server,
paste the final redirect URL or authorization code back into Pi when prompted. You can also
set your model provider's API-key environment variable in the Pi instance's settings; mark
secret values as sensitive.

Update installer-managed Pi with `pi update`. If another package manager owns the installation,
update it through that manager instead. For example, a Nix profile installation uses
`nix profile upgrade pi`.

## What Carries Over

T3 Code discovers the models reported by Pi and exposes their supported thinking levels. The
thinking picker marks the discovered active model's configured level as its default without
overriding it. Other models keep their Pi defaults when no level is selected. A model that lists
`serviceTiers` (for example `[{ "id": "priority", "name": "Fast" }]`) in its Pi definition gets
a speed picker with Standard plus those tiers. A chosen tier is sent as the request's
`service_tier`; Standard sends none and leaves the endpoint's default. Threads
use Pi's native session files for resume, rollback, and forks within the same Pi instance. Forks
preserve the native conversation through the selected turn in the destination workspace.
Switching providers uses portable conversation context. Extension
dialogs appear in the T3 Code composer, and the thread details context window follows Pi's own usage
reporting while a response streams and after it settles.

With **Compact idle threads** set to **Before the cache expires (beta)**, an idle Pi thread on a
Claude model compacts shortly before its prompt cache expires, as a Claude thread does (see
[Claude](./providers-claude.md)). Pi caches Claude requests for 5 minutes unless
you add `PI_CACHE_RETENTION=long` to the Pi provider's environment variables in **Settings →
Providers**, which makes it an hour. Models whose cache reports no lifetime, such as OpenAI's, are
never compacted this way, and **When you return** does not apply to Pi.

Pi skills appear in the composer's `$` menu. This includes user skills and project skills that Pi
loads for the current workspace; selecting one uses Pi's native skill expansion.

Pi loads its normal user extensions, and project extensions once the folder is trusted in Pi.
Blocking `select`, `confirm`, `input`, and `editor` dialogs work in T3 Code. Notifications appear in
the work log. The web client does not surface the status text extensions publish near the composer.
Terminal titles and generic widgets do not have a T3 Code equivalent.

## Permission Modes

T3 Code applies the composer permission mode through Pi's blocking tool hook:

- **Supervised** asks before commands, file changes, and extension tools. Read-only tools continue.
- **Auto-accept edits** allows Pi's edit and write tools, but asks before commands and extension
  tools.
- **Full access** allows tools without T3 Code approval prompts.

The **Auto** option is not shown for Pi because Pi does not expose an AI approval reviewer.
Threads that already stored Auto before Pi support was added behave and display as Supervised.

Changing the mode restarts the Pi provider session and resumes the same native conversation. The
policy covers Pi tool calls; it is not an operating-system sandbox, and code that a trusted Pi
extension runs outside a tool call remains governed by Pi's own extension trust model.

T3 Code's `delegate_task` tool creates durable child threads in the shared subagent UI. If the user
installs Pi's example `subagent` extension, T3 Code also shows its task progress and results in that
UI. Pi runs those children without a session, so they cannot be opened or resumed as T3 Code
threads.

## Model Pools

A model pool lets you pick one model by name, such as "Opus 5.5", and have T3 Code choose which
account pays for it. A pool can draw on the same model through several Pi sub-provider accounts and
through other providers, for example Opus on two Claude subscriptions in Pi and on a native Claude
instance.

Create one in **Settings → Providers → Model pools** with **New pool**, then **Add an account** for
each account and model it should use. Drag the accounts into your order, switch one off to keep it
out without removing it, and choose how the pool picks (**My order** or **Spend allowance that would
lapse**), what to keep in reserve, and what happens when an account hits its limit. These work as
they do for account pools.

The pool appears in the model picker on the **Favorites** tab, marked **Pool**, with its accounts
beneath its name; search finds it too. A thread on a pool stays on its account while that account
has allowance. When the account runs out, the thread continues on the next account with allowance if
the pool switches on limit, handing the conversation over when the next account is another provider;
otherwise it waits for the reset. An account with no usage reading counts as available.

Delegation can use a pool wherever it names a model: pick it in a job's model list in **Settings →
Delegation**. Under **Models**, a pool and any of its accounts' models listed in jobs share one row
and one note. Subagents and scheduled tasks that run as a role skip an account a subscription conservation rule
is holding back when they start.

## Troubleshooting

- If Pi is unavailable, confirm that the configured binary runs on the server machine, then refresh
  the provider in Settings.
- If no models appear, open Pi directly and confirm its authentication and model configuration.
- If discovery cannot complete, T3 Code keeps Pi available with the `Pi default` model. Start a
  thread to let the interactive Pi session handle any startup prompt.
- If Pi skips project settings, extensions, skills, prompts, MCP servers, or system prompt files
  because the folder is not trusted, the thread shows a notice on the first turn of the Pi session.
  Run the configured Pi binary in that folder on the server machine, using the same provider
  environment, including `PI_CODING_AGENT_DIR` if set. Trust the folder or its parent with `/trust`,
  then start a new thread using that same worktree. Launch arguments with `--no-approve` keep
  project files off without the notice.
- To see context usage on web and desktop, turn on **Context window** in **Settings → Appearance →
  Thread details**. It appears once Pi reports usage for the thread. Some model providers only
  report usage when a response completes, so it can wait for the first reply.
