# Claude

T3 Code uses Claude Code's login and configuration. Start with the default provider
for one account; [provider setup](./install.md#providers) covers installation and
shared provider settings.

## Separate accounts or configurations

Use a separate Claude config directory for each account. This also works for named
presets that need different Claude settings or a router connection.

Keep your existing account in the default directory. On the environment's machine,
create the second login:

```bash
mkdir -p ~/.claude_personal
CLAUDE_CONFIG_DIR=~/.claude_personal claude auth login
```

Add another Claude instance in **Settings > Providers**:

| Instance        | Binary path | CLAUDE_CONFIG_DIR path |
| --------------- | ----------- | ---------------------- |
| Claude Work     | `claude`    | Leave empty            |
| Claude Personal | `claude`    | `~/.claude_personal`   |

An empty config-directory setting uses Claude Code's normal configuration. The
custom setting changes `CLAUDE_CONFIG_DIR`, leaving `HOME` and the system keychain
location intact. Use the same variable for the login command. Setting `HOME`
instead can put credentials where this provider will not find them.

Check the account reported in provider settings after signing in. Existing
threads can switch only between Claude instances with the same config directory.
Separate account directories stay isolated, including their local conversation
state. Claude does not have Codex's shared-home and shadow-home arrangement.

For presets that differ only in API keys or endpoints, use the instance's
**Environment variables**. Variable assignments do not belong in **Launch arguments**.

Claude Code's verbose mode can stay enabled when you use Claude for text generation, including
thread titles, branch names, commit messages, and pull request descriptions. On a remote connection,
T3 Code uses the Claude configuration on the connected server.

## Pool several accounts

A pool is one entry in the model picker that runs each new thread on the account
whose usage would otherwise go to waste soonest, skipping accounts that have run
out. An account that has used less of its weekly limit than the share of the week
that has passed would reset with usage left, so it goes first, starting with
whichever of its 5-hour or weekly limits resets sooner. Accounts on track to use
their weekly limit come next, soonest weekly reset first. Delegated tasks that
name the pool are routed the same way.

Set up each account as its own Claude instance first, then add the pool to
`providerInstances` in `settings.json`, listing the member instance ids:

```json
"claude_pool": {
  "driver": "claudeAgent",
  "displayName": "Claude (pooled)",
  "pool": ["claude_work", "claude_personal"]
}
```

A thread keeps its account while that account has usage left. When it runs out,
T3 Code continues the thread on the next account in that order, with the same
model. If every account is at a limit, the thread waits for the
reset as usual. This applies to any thread running on one of the pool's accounts,
including one you picked that account for directly. Pick the pool again in the
model picker to move a thread yourself.

Open the pool in **Settings → Providers** to change how it works:

- **How the pool picks:** the default spends the allowance that would lapse
  soonest. **My order** uses the first account in your list that has usage left.
- **Accounts:** drag to set your order, and switch an account off to keep it out
  of the pool without removing it.
- **Keep in reserve:** count an account as out once it is this much used, so new
  threads and switches leave the rest alone. A running thread stays until the
  account's real limit.
- **When an account hits its limit:** switch at once, wait for the reset, or
  follow **Settings → General → Switch pooled account on limit**.

On the composer, the lamp beside the model slider shows the account the next
message uses. Click it to prefer an account for new threads: it goes first while
it has usage left, whichever way the pool picks.

## Compact long conversations

Set **Auto-compact after** in the Claude provider settings to an integer between
`100000` and `1000000`. Claude Code compacts about 30,000 to 40,000 tokens below
this size, so `300000` means roughly 260,000 to 270,000 tokens. This changes when compaction happens, not the model's context
window. Leave it empty for Claude Code's default. With **Context rollover** on in
General settings, the agent is also asked to reach a stopping point before this
happens.

You can also send `/compact` in an existing conversation. Web and desktop offer
**Compact context** from the context meter. When you return to a large thread
after Claude's prompt cache expires, a **Compact** chip with the thread's token count shows
next to the send button. While it is on, Enter summarizes the history first, then
sends your message. Click the chip to switch it to **Full** and keep the full
history for that message. The cache lasts about an hour on a Claude
subscription and 5 minutes with an API key, Bedrock, or Vertex. See [commands and skills](./composer.md#commands-and-skills) for using
composer commands.

## Usage limits

If your Claude subscription runs out of usage mid-turn, the thread shows which
limit was reached and the remaining wait when Claude provides a reset time.
Claude Code holds the turn until that window reopens, so it can keep showing as
working. Wait for the reset, or stop the turn and continue later. The warning's
timestamp shows when the displayed wait started.

## Skills

Claude skills come from the config directory's `skills` folder and the project's
`.claude/skills` folder. If both define the same name, the config-directory copy
wins. Skills disabled in Claude's settings do not appear in the composer.

Use `$` in the composer to select a skill. Enabled installed Claude plugins also
contribute skills under names such as `plugin:review`. Skills marked `disable-model-invocation`
can still be started by you. Invoke those one per message: Claude directly runs
only the last named skill and may try to start earlier ones through its Skill
tool, which refuses skills reserved for manual invocation.

## Task lists

To show Claude task lists in the web and desktop apps, add
`CLAUDE_CODE_ENABLE_TODO_TOOLS=1` under **Variables** in the Claude instance's
**Environment** section in **Settings > Providers**. Unfinished tasks stay visible
between turns in the same Claude session.

## OpenRouter

Create a Claude instance with its own config directory, such as
`~/.claude_openrouter`, and keep **Binary path** set to `claude`. In that instance's
**Environment variables**, use:

| Variable               | Value                                     |
| ---------------------- | ----------------------------------------- |
| `ANTHROPIC_BASE_URL`   | `https://openrouter.ai/api`               |
| `ANTHROPIC_AUTH_TOKEN` | Your OpenRouter API key, marked Sensitive |
| `ANTHROPIC_API_KEY`    | An explicitly empty value                 |

If that Claude config directory has a cached Anthropic login, run `/logout` in a
Claude Code session using that directory before starting the router setup. Cached
login credentials can conflict with the router token.

Select the model you want in T3 Code. For an OpenRouter model outside the built-in
list, open that Claude instance in **Settings > Providers** and add its full model
ID with **Add custom model**. Then select it in the chat model picker.
`ANTHROPIC_DEFAULT_*_MODEL` variables map Claude Code aliases such as `sonnet`; they
do not replace the explicit model ID selected in T3 Code. Custom models may have
fewer effort, thinking, or context controls than built-in models.

Verify the model used in OpenRouter's activity dashboard. For current compatibility
requirements, use the
[OpenRouter Claude Code guide](https://openrouter.ai/docs/cookbook/coding-agents/claude-code-integration).

## Other routers

A local router uses an ordinary Claude provider instance. Give it a separate
config directory and put the router's endpoint and credential variables in that
instance's **Environment variables**. The router must run where the environment
can reach it. Follow the [Claude Code Router instructions](https://github.com/musistudio/claude-code-router)
for its installation and routing configuration.
