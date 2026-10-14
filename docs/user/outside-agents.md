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

- **An agent on your own computers** can use any address that computer reaches
  the environment at: a LAN or Tailscale address, T3 Connect, or `localhost` on
  the host. See [remote access](./remote-access.md).
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
browser already signed in to the environment as an administrator can approve
without a code.

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

## Remove an agent

Approved agents appear under **Settings → Connections** like other clients.
Revoke one there to cut off its access immediately. A sign-in lasts 30 days;
after that the agent asks you to approve it again.

## Delegate from a terminal agent

`t3 agent` lets a standalone Claude Code or Codex session submit a bounded task
without starting a second lead agent. The destination must have a model policy
configured by its maintainer. Sign in with its MCP URL:

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
models and unsupported execution boundaries before you submit.

Keep the same work and attempt IDs when retrying a submission, including after a
disconnect or server restart. Use a new attempt ID for new execution of that work,
after the previous writer has stopped. The response includes a task ID, selections
and any experiment assignment IDs. `status`, `wait`, `cancel` and `evidence` take
that task ID. Waiting is bounded and does not cancel work when its timeout expires;
disconnecting the terminal also leaves accepted work running. `outcome` records
the owning caller's claim against a returned assignment ID as self-report.

Revoking the sign-in in Connections, or allowing it to expire, stops its owned
work and denies further access. `t3 agent logout` removes the local credential;
it does not revoke the server grant. After expiry, log out and sign in again.
A new sign-in has a new owner and cannot adopt the old sign-in's tasks.
