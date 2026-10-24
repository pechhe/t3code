# Voice bridge

Ask T3 Code from FluidVoice's notch. FluidVoice's Command window already turns a
dictated instruction into an OpenAI chat request; this bridge answers that request
by starting a real T3 thread and streaming the agent's answer back into the same
window.

The bridge is a small local service you run. It changes nothing in FluidVoice: the
app is used exactly as installed, with one provider entry pointing at it.

## Before you start

- FluidVoice on the same Mac, with its notch, dictation and Command window.
- T3 Code running, and this CLI signed in to it once. The endpoint is the
  environment's MCP address — the URL behind **Copy MCP URL** in
  **Settings → Connections**, which ends in `/mcp`:

  ```sh
  t3 agent login --endpoint http://127.0.0.1:3773/mcp
  ```

  The bridge reuses that credential, so there is nothing else to sign in to.
- That sign-in approved in **Settings → Connections** with **Supervised** access or
  above. Read-only access can list models but cannot start threads.

## Run it

```sh
t3 voice-bridge --endpoint http://127.0.0.1:3773/mcp
```

| Flag | Default | What it does |
|---|---|---|
| `--port` | `4319` | Port the bridge listens on |
| `--host` | `127.0.0.1` | Address it listens on; keep it on loopback |
| `--capture` | on for macOS | Attach a capture of the window that had focus |
| `--poll-ms` | `600` | How often it reads the thread for new text |
| `--wait-seconds` | `900` | How long one answer streams before it points at the thread |

## Connect FluidVoice

In FluidVoice, open **AI Providers**, add a provider and fill in:

- **Name:** T3
- **Server URL:** `http://127.0.0.1:4319/v1`
- **API key:** any value; the bridge ignores it

Select **Fetch models**. T3's providers and their models appear, as they are
configured in this environment. Pick one in Command Mode.

## What happens to an ask

- One ask starts one thread in the Scratch project, titled from your first few
  words, with the capture of the window that had focus attached.
- The answer streams into the Command window as it arrives. Its last line is the
  thread's address on this environment (`http://127.0.0.1:3773/<environment>/<thread>`),
  which opens the thread in T3 Code's web client in your browser. T3's own
  `t3-thread://` link form only works inside T3's renderer, so the bridge prints the
  web address instead; paste that form into T3 if you need the desktop app.
- A follow-up in the same Command conversation adds a turn to the same thread. A
  new Command conversation starts a new thread.
- A run that stops for an approval or an agent question ends the answer with a line
  naming the request: open the thread to answer it, and T3 carries on there.
- `curl http://127.0.0.1:4319/health` reports whether the bridge is running and
  still signed in.

## Limits

- The window shows the agent's words, not its tool calls, file changes or terminal.
- Audio never reaches T3: FluidVoice transcribes on the Mac and only the words are
  sent. With `--capture` off, no image is sent either.
- The bridge is a separate local process. It ships with the CLI, not inside the app
  bundle, and stops when you close it.
- A provider that cannot take images refuses the turn, so the ask is retried without
  the capture and the answer says the screenshot was dropped.
