# T3 Code

T3 Peach is Henry’s fork of T3 Code: a Node WebSocket server wrapping provider runtimes, with web, Electron desktop and React Native mobile clients. Preserve remote use, open-source forkability and performance; avoid excess WebSocket data, costly list rendering and continuously repainting animations, especially on high-refresh displays.

Global agent policy governs authority, workflow, delegation, review, SlipJay delivery and release. This file adds repository constraints; it grants no publication or browser authority. Track maintainer work in Weave Forge (`tracker` in `slipjay.json`); GitHub Issues are read-only history. External proposals follow [CONTRIBUTING.md](CONTRIBUTING.md) and belong in Ideas discussions. Keep plans, research notes and scratch files outside the worktree; `.plans/` is only a legacy safety net.

## Runtime safety

1. **Processes:** never `pkill -f`, `pgrep | kill`, or kill a PID found by matching a name, path or worktree string: your own agent has the path in its argv. Stop only a PID captured at spawn, or the owner of your port from `ss -H -ltnp` after confirming `/proc/<pid>/cwd` is your worktree.
2. **Live state:** `~/.t3/userdata` is the running developer installation. Read or copy from it; never open it read-write, clean it up, or start a server against it. Use isolated copied test data, never symlinks back to live state.
3. **Origins:** never set `VITE_HTTP_URL` or `VITE_WS_URL` for dev. Vite proxies `/api`, `/ws`, `/oauth` and `/.well-known` through the browser’s origin; baked-in localhost breaks remote clients.

## Before changing behaviour

Read [fork/README.md](fork/README.md) before a feature, behaviour change or performance fix. It governs upstream reuse, shipped-native-client compatibility and performance evidence. Every deliberate difference from upstream updates its [fork record](fork/differences.md) in the same change.

Before calling frontend work done, walk this coverage list and report which entries applied:

- **Entry points:** chat, Settings, command palette and keybindings can reach the same behaviour.
- **Clients:** hosted and locally served web, desktop shell/IPC, and separate mobile navigation. Shared client logic belongs in `packages/client-runtime`.
- **Providers:** decide support for Codex, Claude, Cursor, Grok, OpenCode and Antigravity individually.
- **Agents:** user capabilities generally need MCP and scheduled-task access through a service method.
- **Contracts:** wire schemas live in `packages/contracts`; account for server, web, mobile and desktop consumers.
- **Reverse states:** include the way out and the way to see state (for example, snooze/unsnooze and close/reopen).
- **Connections:** local, remote/relay, tunnel, multiple devices and multiple environments.
- **Docs:** correct guidance made inaccurate by the change; follow the documentation constraints below.

## Load when needed

- **Dev server or test fixtures:** read [development](docs/operations/development.md#choosing-a-dev-process) before setup, starting or sharing a server, or copying test data. It covers isolated homes, setup markers, ports, pairing and secrets.
- **Tests or code verification:** read [testing](docs/operations/testing.md) before authoring tests or choosing checks. Run focused checks locally; global SlipJay policy owns the runner landing gate. Do not run repo-wide checks (`vp check`, `vp run -r test`, `vp run -r typecheck`) unless asked.
- **Visible UI change:** follow the global requirement for one integrated T3 Browser-panel check with `test-t3-app`, and the global design gate before landing. The primary agent verifies after integration; helpers do not start dev servers. Other browser or computer use still needs the authority required by global policy; this exception grants no broader permission.
- **Native mobile verification:** use `test-t3-mobile` when authorised. A missing/outdated native client is a build step: run `node scripts/mobile-native-client.ts ensure <ios|android> <device-id>` on the simulator host before Metro.
- **Authorised PR work:** read [PR procedures](docs/operations/development.md#authorised-pull-requests); these do not override SlipJay publication rules.
- **Landed work on `t3peach`:** use `t3-fork-install` to install it into the Nightly app before finishing. Landed is not installed.

## Architecture and implementation

Use the [glossary](docs/internals/glossary.md) for domain terms and the [overview](docs/internals/overview.md) for orchestration constraints. In instructions, “you” means the implementing agent, “we/us/maintainers” means T3 maintainers, and “user” means the person directing coding agents.

- **Server work:** before adding code in `apps/server`, read [Effect services](docs/internals/effect-services.md) and `.repos/effect-smol/LLMS.md`. Complexity belongs at adapter boundaries; orchestration stays pure. Server features are services: WebSocket, HTTP and MCP transports decode, call one service method, and map errors.
- **Client mutations:** use `createEnvironmentRpcCommand`. Add protected methods to `CLIENT_GUARDED_RPC_SCOPES`, use the command’s `permissionAtom` for availability, and extend permission behaviour tests. Execution checks grants against the destination environment; the server stays authoritative. Raw RPC clients stay inside `rpc/`.
- **Web UI:** read [Web UI](docs/internals/web-ui.md). Exports in `apps/web/src/components/ui` own their look: use a `variant` or `size`, not restyling via `className`. Add generic variants there; feature-specific looks belong in feature components. Put layout classes on the parent. `shadcn/no-restyle` enforces this.
- **Effect:** reusable functions use `Effect.fn("Service.operation")` with stable span names; reserve `Effect.gen` for inline programs and layer construction. Use `Effect.fnUntraced` only for overly frequent spans or a duplicated tracing boundary, explaining why nearby. Named `Effect.fn` creates a span; unnamed does not. Preserve existing span names/options and pass combinators as additional builder arguments.
- **Shared packages:** `packages/contracts` holds Effect/Schema contracts and small derived helpers, not heavy runtime logic. `packages/shared` uses subpath exports, no barrel. Prefer inferred types; avoid `any`.
- **Vendored references:** `.repos/` is read-only: follow its patterns, never edit or import from it. Run `vpr sync:repos` when bumping the matching dependency. For missing sparse files use `git show origin/main:.repos/<path>`.
- **Comments:** default to none. Record only a constraint, external quirk or invariant the code cannot show, usually one line, at most four. Do not narrate code, signatures or fix history; `t3code/no-low-value-comments` enforces the mechanical cases.

## Documentation

Most changes need no internal documentation: source and tests already record implementation.

- `docs/internals/` records architectural decisions and reasons, cross-component constraints and traps hard to discover from source. Add text only when a maintainer would otherwise get something wrong. Do not enumerate features, fields, methods, control flow, file catalogs or PR summaries; the glossary is vocabulary, not a feature index.
- Put local reasons in short nearby comments. Use an internal doc for reasoning crossing boundaries; link source instead of copying it. Rewrite or remove superseded decisions rather than appending another account. A new page needs a distinct durable reason.
- `docs/user/` helps users accomplish tasks in the shipped product’s voice. Give major features a concise section covering purpose, how to start and unintuitive behaviour; settings paths can help. Avoid UI inventories, implementation details and contributor tooling. Update changed usage; a UI tweak or new control alone needs no entry/page.
- `docs/operations/` holds maintainer setup, release and debugging procedures. Installed-server operating instructions belong in user guides.

If a repository rule conflicts with the task, report the conflict and obtain human sign-off before breaking it.
