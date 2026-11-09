---
name: test-t3-app
description: Screenshot or test T3 Code's web and desktop UI headlessly against isolated development state. Use to show a proposed UI, for browser verification, browser pairing recovery, and test fixtures. Use test-t3-mobile for native mobile verification.
---

# Test T3 web and desktop

Verify and show UI in T3's headless browser. Follow the recovery steps below
before declaring it unavailable. Do not install or switch to another
automation system. For native mobile testing, use
[test-t3-mobile](../test-t3-mobile/SKILL.md).

## Start the app

Reuse this task's healthy dev server. Otherwise run `vp run dev` from the
repository root and retain its terminal session. Use the worktree's ignored
`.t3` state and read the actual ports and pairing URL from the dev-runner output.
Never run against `~/.t3/userdata` or set `VITE_HTTP_URL` or `VITE_WS_URL`.
Where `vp` is not on the path, as on `peach-box`, run
`PATH="$PWD/node_modules/.bin:$PATH" vp run dev`; `pnpm exec` rewrites `pnpm-lock.yaml`.

Test with meaningful project and thread data. A new worktree seeds from
`~/.t3/dev-seed` when it exists; the dev-runner warning names the command that
builds it. Read [references/sqlite-fixtures.md](references/sqlite-fixtures.md)
only when inspecting or seeding SQLite, or for data seeding drops, such as
scheduled tasks. Stop the test server before direct fixture writes.

## Drive agent turns for free

Do not spend a paid model to see a turn render. `vp run dev` registers the
`Replay (dev)` provider, which replays recorded turns with simulated streaming
through the real adapter and orchestration. Its models are scenarios:
`showcase` covers thinking, a plan, tool calls, an approval, and markdown.
Press `Ctrl+Alt+Shift+R` for a picker (GNOME takes that key for screen
recording), call `window.t3dev.replay("showcase")`
with `preview_evaluate`, or run
`node apps/server/src/bin.ts thread start --base-dir .t3 --provider devReplay --model showcase <project> "go"`.
When the test needs real provider behavior, use that provider's cheapest
model, such as Haiku for Claude or Luna for Codex.

## Drive the headless browser

Use `t3_browser_*`; a task whose tool list has only `preview_*` uses those the same way,
calling `preview_open` even when `preview_status` reports `available: false` or `tabId: null`,
because that often means only that no tab exists yet. Stop only if `preview_open` itself fails.

1. Open the complete pairing URL with `t3_browser_open`. The token is single-use and a new
   tab has no cookie, so keep the tab, or mint a token with `node apps/server/src/bin.ts pair`.
2. On `Managed browser blocked address`, add `localhost:5733-8733` to
   `agentBrowserLoopbackAllow` under this project's id in `projectSettingsOverrides` in
   `~/.t3/userdata/settings.json`, then open again. The server reloads that file live.
3. Navigate, then `t3_browser_snapshot` until the page shows content. A screenshot straight
   after navigating is blank.
4. Capture every state with `t3_browser_task` `steps`, and embed each returned `path` in
   your reply as a Markdown image.

## Verify and retain

Exercise the affected flow and capture the state that proves it works. Keep
the server, state, and panel available while the user inspects or iterates.
An assistant turn ending is not teardown. Stop only processes you started,
using retained terminal sessions or captured PIDs.

When sharing is requested, start with `vp run dev --share` and give the user
a fresh complete pairing URL that you have not consumed. Keep other credentials
out of screenshots, commits, and replies.
