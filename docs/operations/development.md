# Development

## First checkout

Install `vp` using the [root README](../../README.md#install-vp). It provides the Node version
pinned in `package.json` (Node 26), so no separate Node install is needed. From the repository root:

```sh
vp i
vp run dev
```

Open the pairing URL printed by the dev runner. The bare origin does not authenticate
a new browser.

Prefer a container? See [Dev container](../internals/devcontainer.md) for VS Code and Codespaces setup.

## GitCafe mirror (optional)

GitHub is the source of truth. [git.cafe/pingdotgg/t3code](https://git.cafe/pingdotgg/t3code) is a
two-way synced mirror with much higher API rate limits, which helps when many agents work at once.
You never need it to contribute.

Pushes, PRs, comments, reviews, labels, and issue edits made on GitCafe sync to GitHub within
about a minute, and PR and issue numbers match. CI runs on GitHub, and its checks show up on
GitCafe.

```sh
git remote set-url origin https://git.cafe/pingdotgg/t3code.git
git remote add github https://github.com/pingdotgg/t3code.git
gh repo set-default pingdotgg/t3code   # `gh` is still used for merging
bun install -g @gitcafe/cli@latest   # `cafe` needs Bun 1.2 or newer
cafe auth login && cafe auth http setup
cafe skills install --global  # optional: cafe-* skills for coding agents
```

With `origin` on git.cafe, work through GitCafe and leave GitHub's API alone:

- Push to `origin`, open PRs with `cafe pr create` (`--head owner/repo:branch` from a fork) or
  `cafe stack submit`, and use `cafe` for everything after that. Link the git.cafe PR URL, not the
  github.com one, wherever a tool tracks the PR, so polling stays on GitCafe.
- Read checks with `cafe pr status <n>`, and GitHub Actions logs with `cafe ci logs <run>` (run ids
  from `cafe ci list --pr <n>`). `cafe ci rerun <run>` reruns one. These need `cafe` 0.11 or newer.
- Write closing references as `Fixes pingdotgg/t3code#<n>`. GitCafe turns a bare `#<n>` in text it
  syncs to GitHub into a git.cafe link, and GitHub does not close issues from those.
- Merge with `gh pr merge <n> --match-head-commit <sha>`, because `cafe pr merge` cannot pin the
  commit you reviewed.
- `cafe` commands differ from `gh`: `cafe issue comments <n>` not `--comments`, `cafe pr status`
  not `pr checks`.

## Choosing a dev process

Use `vp run dev` for server and web, or `vp run dev:desktop` for the Electron client.
`dev:server` and `dev:web` start those processes separately.
See the [mobile README](../../apps/mobile/README.md) for native builds and Metro.

Flags go directly after the task name, for example `vp run dev --home-dir /tmp/t3code-dev`. Do not add a `--` before them: it forwards `--home-dir` to Vite, which crashes.
Add `--browser` to open a browser automatically.

### Worktree setup

`t3.json` setup installs dependencies in the background. While `.t3/setup-running` names a live PID, wait and do not run `vp i`. Completion writes `.t3/setup-done` or `.t3/setup-failed` (with the error tail). With no marker, setup never ran: run `vp i`.

Stop only the process you started, using its captured PID and the [process safety rule](../../AGENTS.md#runtime-safety). If another checkout is needed, use `git worktree add` next to the current worktree, not in `/tmp`, and remove it when done. Global workspace ownership rules still apply.

To stop a worktree's dev stack when its thread settles, import the **Dev** action from
`t3.json` in Settings > Projects > Actions and start it through the action menu or its
keybinding. Its `stopOnSettle` option lets T3 stop the terminal and its child processes.
Running `vp run dev` through an agent's own shell tool does not attach it to this lifecycle.

### State and ports

Linked git worktrees and SlipJay (jj) workspaces default to their own `.t3/userdata`, from the workspace root or any nested directory, even when `T3CODE_HOME` is set.
The main checkout defaults to `~/.t3/dev/userdata`. An explicit `--home-dir` wins in both cases.
Inside a SlipJay workspace directory where no workspace root is recognised, the runner refuses to start instead of using the shared home; pass `--home-dir`.
`vp run migrate-dev-db` follows the same default; `--base-dir` overrides it.
The first start seeds an empty database from a read-only snapshot of `~/.t3/userdata/statev2.sqlite` only when the source is at most 500 MiB; use `--no-seed` or `T3CODE_DEV_SEED=0` to skip it. Larger sources require an explicit `vp run migrate-dev-db`.
Never run a development server against the live `~/.t3/userdata`.
See [test data](#test-data) for copying a consistent database snapshot.

Read ports from the `[dev-runner]` output. Worktrees derive stable preferences from their paths,
but occupied ports can shift them. `T3CODE_PORT_OFFSET` or `T3CODE_DEV_INSTANCE` can select a
different preference when needed.

### Replay provider

`vp run dev` registers `Replay (dev)`, a local ACP agent at
[dev-replay-agent.ts](../../apps/server/scripts/dev-replay-agent.ts). It plays recorded
ACP transcripts with simulated streaming, so the real adapter, orchestration, and UI run
without a paid model. Each scenario is a model, and each prompt plays the next recorded turn.
Bundled servers, including desktop dev, skip it because they have no agent script.
Dev servers add it back on start, so turn it off in Settings instead of removing it.
To add a scenario, point a `SCENARIOS` entry at a generic ACP replay fixture
(`registry_transcript.ndjson`) or a file in [dev-replay](../../apps/server/scripts/dev-replay).
The agent replays session updates, permission requests, and questions. It drops session setup
and vendor frames, so Grok and fx recordings lose their vendor-only behavior.

### Profiling dev startup

Run `vp run profile:startup` to capture the first 20 seconds of inherited Node processes under
`.t3/startup-profiles/<timestamp>`. Workers that execute the preload get separate profiles.
It starts the normal dev runner and accepts its flags.
Stop it with Ctrl+C after the capture. Set `T3CODE_STARTUP_PROFILE_DIR` to choose another output
directory. Profiling adds overhead, so compare readiness with an ordinary `vp run dev` run.

Open a `.cpuprofile` in Chrome DevTools' Performance panel for sampled function stacks and source
lines. Each `.modules.json` is a Chrome trace containing timed module resolution, loading,
synchronous subprocess calls, and startup measures. Per-file records include importer URLs,
source loading, preparation, recursive dependency linking, and top-level evaluation. Preparation
uses synchronous loader boundaries; linking includes dependencies, and CommonJS evaluation can
include nested `require` calls. Some ESM/CommonJS interop reports a combined stage. `.process.json` records the process, Node version, and capture window.
The server's nested Effect and SQL spans remain in `.t3/userdata/logs/server.trace.ndjson`.

The preload temporarily adds module-body timing markers and uses one automatic debugger pause
to instrument the live Node loader. The launcher adds `--no-node-snapshot` to inherited
`NODE_OPTIONS` because Node 26's snapshotted loader cannot accept that breakpoint. Include the
same flag when using the preload directly. This disables Node's built-in startup snapshot,
can change compilation-cache hits, and adds overhead.
Treat per-file captures as diagnostic runs; use uninstrumented runs for baseline startup latency.
The first entry module can compile before loader instrumentation is installed.

A fresh process still uses filesystem, Node compilation, provider, and Vite dependency caches.
Measure a missing Vite dependency cache separately from a restart with an existing database.
Neither the Vite ready message nor the HTTP listener proves that a browser has rendered the app.

### Sharing and remote debugging

`vp run dev --share` publishes the web port over the machine's tailnet and prints a pairing URL
for that origin. Give the tester the complete URL, including its token. The dev runner removes
its mapping on exit. Do not configure `tailscale serve` by hand or consume the tester’s pairing URL. A browser with the reusable dev cookie can use the bare origin. If a normal one-time token was consumed, mint another with `node apps/server/src/bin.ts pair`; it has standard scopes, while the startup URL has the admin scopes needed for Connections settings.

Leave `VITE_HTTP_URL` and `VITE_WS_URL` unset. Vite proxies the backend through the browser's
origin so the same build works over localhost and remote connections.

Shared runs enable bundled dev to avoid a network round trip for each import level.
`T3CODE_BUNDLED_DEV=0` opts out when debugging bundler differences. Two reload traps matter
when changing this setup:

- The web entry must dynamically import the app so React refresh initializes before application
  chunks. Static imports can work on first load and fail after a route split.
- Bundled dev rebuilds Tailwind through watched files. Its ordinary Vite hot-update hook expects
  a server/module graph that Rolldown does not provide.
- The app and its routes are lazy chunks, built on first request. A plugin pre-bundles the
  startup chain when the server starts. Renaming or moving a startup route or the app entry
  silently drops it from that list.

The workarounds live in the [web entry](../../apps/web/src/bootstrap.ts),
[Tailwind plugin](../../apps/web/vite/tailwind.ts), and
[startup warmup](../../apps/web/vite/warmBundledDev.ts).

`vp run dev --share --built` skips the Vite dev server. It runs `vp build --watch` for the web
app, and the backend serves `apps/web/dist` on the same tailnet URL and pairing flow. Use it when
someone tests over a slow link or only needs to use the app: loads are production size, and the
first load does not wait for dev bundling. There is no HMR. After an edit, wait for the
`built in` line (about 6 s), then reload. Until the first build exists, the URL shows a page that
reloads by itself. The license manifest is not generated in this mode. `--built` requires
`--share` and the `dev` mode.

#### Reusable dev credential

Use this only on a hostname where you trust every service. Browsers send cookies to all ports
on that hostname. Any service you visit there can receive the reusable admin credential,
including services unrelated to T3 Code. If you run untrusted services on that hostname, keep
normal per-environment pairing instead.

To use one browser profile across web dev worktrees on the same hostname, generate one fixed
value once:

```sh
openssl rand -hex 32
```

Put that value in the main checkout's gitignored `.env`:

```dotenv
T3CODE_DEV_AUTH_TOKEN=<the value generated above>
```

The `t3.json` Setup Worktree action links that file to each worktree's `.env`. The dev runner reads repository env files at startup. `.env.local` and inherited process
environment values override `.env`, so no per-worktree export is needed after setup.

For a manual worktree or launcher without that link, export the same fixed value instead:

```sh
export T3CODE_DEV_AUTH_TOKEN="<the value generated above>"
```

Do not generate a new value at startup. Start or restart `vp run dev --share` after configuration,
then open its printed startup pairing URL once per browser profile on that hostname. Later web dev
servers on the same hostname accept the shared cookie across ports. The cookie expires after 30
days. Reload an old tab if its URL now serves a replacement environment.

That shared cookie jar grows with every local dev server on `localhost`, and all ports collect
it. The dev runner therefore starts its processes with `NODE_OPTIONS` carrying
`--max-http-header-size=1048576`, beside any options already set, because Node's 16 KiB default
answers such a request with HTTP 431 and the page never loads. A value you set yourself is kept.

The token and startup pairing URLs are reusable administrative secrets. Never put them in a
commit, pull request, or public output. Every server still seeds its own auth database record at
startup and keeps its own SQLite data, signing key, and revocation state. Desktop and non-dev
servers ignore the value. See [environment authentication](../internals/environment-auth.md#reusable-dev-credential)
for the security model.

## Test data

An empty database is a bad test. Seed your worktree's `.t3` with a copy of real data instead of pointing at live state:

- The first `vp run dev` in a worktree does this for you when its database is missing. `--no-seed` or `T3CODE_DEV_SEED=0` skips it.
- Run `vp run migrate-dev-db` with your dev server stopped to refresh. It defaults to the same workspace `.t3` as the dev runner (`--base-dir` overrides) and rebuilds `<worktree>/.t3/userdata/statev2.sqlite` from a read-only snapshot of `~/.t3/userdata/statev2.sqlite`, the developer's real data. It keeps recent projects and their stopped threads, and drops scheduled tasks, pending work, and auth sessions, so your dev server never runs the developer's agents. Raise `--projects` and `--threads-per-project` for more data.
- Refresh `statev2.sqlite`, not `state.sqlite`. The server copies the V1 `state.sqlite` only when `statev2.sqlite` is missing.
- Bring `secrets` and `settings.json` only if the flow under test needs them, and then only the file it needs, such as `secrets/weave-connection.bin` for the Weave connection. Never copy the whole `secrets` directory: its `cloud-*` files are the live relay identity, and a dev server holding them publishes as the real environment. The database copy already drops scheduled tasks, so a dev server never runs the developer's agents.
- Copy in, never symlink. Data flows one way: into your sandbox, never back out.

## Checks

Before writing tests or choosing code checks, read [test authoring and focused verification](testing.md).

`vp run check:changed` runs CI's fast checks for your branch's changes: format and lint of the
changed files, `knip:check` when code or a manifest changes, the generated GraphQL checks, typecheck
of the affected packages and their dependents, and the test files beside the changed files. It also
runs the checks that read other files: the agent context budget when the server is affected, and
React Compiler coverage for only the changed web and mobile files. It maps
files to packages with [ci-changes.cjs](../../.github/scripts/ci-changes.cjs), as CI does. It
compares against the integration branch `slipjay.json` names, since the fork's remote `main` lags
upstream; a repository without that file compares against the closest merge base with any remote's
`main`, and either way a ref you pass wins. CI still runs the full
test suites and the jobs the summary lists, so a local pass does not promise a green CI run.

The steps run side by side, as many at once as the machine allows: one per two cores and per 6 GiB
of available memory. On a large machine a run takes about as long as its slowest step, usually
knip's exports pass at about 10 s. Pass `--concurrency <n>` or set `CHECK_CHANGED_CONCURRENCY` to
change the limit (`1` runs the steps one by one). A step that runs past `--timeout <seconds>` or
`CHECK_CHANGED_TIMEOUT` (default 900) is killed with every process it started and reported as
`TIMEOUT`, not as a failing check. When the files are exactly those of the last passing run, it prints that
run's summary instead of running again. Any change to a file, the install, or a generated file runs
the checks again.

While you iterate, run single checks:

```sh
vp test run <files>
vp lint <files>
vp run --filter <package> typecheck
```

In `apps/web`, a test that renders React or touches the DOM is named `*.browser.test.{ts,tsx}`
and runs in headless Chromium with the React Compiler on, like the app. There is no jsdom; other
`*.test.ts` files run in Node.

TypeScript workspaces typecheck with `effect-tsgo tsrs --noEmit` from `@effect/tsgo`: the
[tsrs](https://github.com/oxc-project/tsrs) checker with Effect diagnostics, quick fixes, and
refactors built in. Only `apps/marketing` installs `typescript`, for Astro. VS Code's TypeScript 7
extension starts the same checker through `.vscode/tsdk/tsgo` (`js/ts.tsdk.path`), a POSIX
script, so on Windows open the workspace through WSL.

Use `vp run lint:mobile` for native mobile changes. CI owns the full suite; see
[ci.yml](../../.github/workflows/ci.yml) for its current jobs.
The [manual Windows lane](../../.github/workflows/windows-tests.yml) is available for focused
Windows investigation while that suite is not a required gate.

### Landing gate

`slipjay.json` runs [scripts/test-landing.ts](../../scripts/test-landing.ts) with the two
typechecks. It tests the exact rebased JJ candidate against its single integration parent. In each
test workspace the change can reach, found from the manifests and `EXTRA_EDGES`, it lists the tests
Vitest relates to the changed files. Tests whose inputs the import graph cannot see (replay
transcripts and fixture scripts read from disk, source spawned in a child process, tests that read
every source file) are mapped in `INPUT_RULES` in
[test-landing-inputs.ts](../../scripts/lib/test-landing-inputs.ts).
`scripts/test-landing.test.ts` fails when a test starts reading a file by path without a rule, or
a workspace imports another by an edge nobody declared. Add the rule there rather than widening
the selection.

It fails closed. The candidate selects every workspace's complete suite when it changes the
toolchain, a lockfile, a manifest (other than its version), TypeScript or Vitest configuration,
or test setup; deletes a non-doc file; touches a path with no mapping and not in the harmless
list; is a merge; or cannot be read or is not rebased onto the integration bookmark. A change
to docs and other files no test reads runs no tests.

The selection then fits a 60-second budget, estimated from each file's recorded cost in
`tests/durations.json`, and runs with eight parallel Vitest workers. Three kinds of test always
run, whatever they cost: a changed test, the repository-wide invariant guards
(`INVARIANT_GUARDS`, `scripts/test-landing.test.ts`) when the candidate adds, removes or renames a
test file, and a test that imports a changed module by a relative specifier. When these alone
exceed the budget the gate says so and defers every optional test. The rest fill what is left
nearest the change first: a test named after a changed module, then a test beside a changed file,
then the others, cheapest first within each. What does not fit is deferred to the nightly audit
and listed in the gate's output, so a hub change such as `packages/contracts` keeps the whole gate
under three minutes. The durations come from the audit's
reports: `node scripts/test-landing.ts --durations <report-dir>` refreshes them after an audit run
on the runner.

`node scripts/test-landing.ts --plan` prints the selection and commands without running them, and
`--replay` prints what the last 30 first-parent integration commits would have run and deferred,
with each one's estimate.
Each listing and each Vitest run prints a `Vitest list|run <workspace>` line on stderr with the
contexts it built and its load, discovery, tests and close times, so a slow gate shows whether
Vitest setup or the tests themselves took the time.

A flaky test can be quarantined in `tests/quarantine.json` as
`{"file": "<repository-relative test file>", "issue": 123, "reason": "..."}`. The gate leaves it
out of every run it makes; `pnpm test` and CI still run it. Each entry names an open Issue, and
the entry is removed when that Issue closes. `pnpm test:audit` (`--audit`) runs every workspace's
complete suite in parallel with the quarantined tests included, for the nightly audit.
The audit installs with `--force`: the runner reuses one `node_modules` between commits, and
pnpm 11.10 linked a newly patched dependency from the unpatched files when it upgraded that
install in place (#4416), so a patch the commit just added silently did not apply. Only a
reinstall from the store repaired it. Check the pinned pnpm before dropping the flag.

When `SLIPJAY_TEST_REPORT_DIR` is set, each Vitest run also writes a JSON report there, and
`slipjay-test-reports.json` lists them. The audit (`--audit`) defaults the directory to
`.t3/review/test-reports`, which `slipjay.json` preserves as evidence (`evidencePaths`). Other
runs write nothing without it, and a missing report never fails the gate. The budget's outcome is
listed there too, as skipped rows the runner keeps in the landing's test
report when it clips the console output: one row per deferred file (suite `landing-deferred`) and
one row whose suite name is the budget summary, which says when the mandatory tests alone exceed
the budget. The summary is also the output's last line.
`budgets` in `slipjay.json` holds the verification time targets.

### What a workspace may leave behind

SlipJay refuses to retire a landed workspace that still holds a file no history has. `generatedPaths`
covers a `.t3` home's runtime state, pid files and logs at any depth, and `evidencePaths` covers its
other subdirectories, which SlipJay copies to `~/.slipjay/state/evidence/` before deleting the
checkout. Declaring a subdirectory as evidence keeps it whole: `generatedPaths` cannot carve a file
out of one, so a build preview beside an item's brief stays with it. Preserved evidence counts
against a 64 MiB cap, and a workspace over it is kept instead of retired, so trim large review
captures before releasing it. Per-item briefs, ADRs and drafts belong in `.t3/<item>/`, review
output in `.t3/review/` and spec drafts in `.plans/`; a scratch file outside those pins the
workspace.

### Unused code

`vp run knip:check` checks unused files and dependencies across the repo and, at the same time,
unused runtime exports in `apps/server`, `apps/desktop`, `apps/web`, and every internal package under
`packages/`. CI enforces both checks.
Exported types and Effect schemas are allowed without consumers. The schema preprocessor
recognizes schema types, including aliases and schema classes; functions that create or decode
schemas remain checked. Canonical Effect service construction APIs stay exported with an explicit
`@public` annotation, which Knip recognizes. Completely unused files remain checked too.
Named exports in web UI component modules are kept as complete component sets. Knip ignores
unused exports in `apps/web/src/components/ui/*.tsx`, while still reporting an entire unused file.
Use `vp run knip --workspace apps/web` to audit one workspace, including exports,
or `vp run knip:production --workspace apps/web` to find code kept alive only by tests.
The full export audit still has findings and is not a repo-wide CI gate. Extend the
export check's workspace selectors as more workspaces become clean. Review callers before
deleting code; production mode can also report development scripts and test fixtures.
Runtime-discovered entrypoints and dependency exceptions belong in [knip.jsonc](../../knip.jsonc).

## Desktop artifacts

Local artifact builds are unsigned by default and write to `release/`:

```sh
vp run dist:desktop:dmg
vp run dist:desktop:linux
vp run dist:desktop:win
```

`dist:desktop:linux` targets x64. For a native Linux ARM64 build, run:

```sh
vp run dist:desktop:artifact --platform linux --target AppImage --arch arm64
```

DMGs default to the host architecture. Use `--arch` to choose another target and `--keep-stage`
to retain packaging files for inspection. Run `vp run dist:desktop:artifact --help` for other
options.

### Prepared server bytecode

Native macOS and Windows desktop artifact builds, and native Linux x64 and ARM64 builds, generate server
bytecode with the packaged Electron executable, after ASAR creation and before signing. Generation imports the CLI and server
module declarations without launching server services; worker-only modules compile normally.
AppImage backends use temporary links for each mount and remove them on normal exit. Later launches
reclaim abandoned cache directories whose links point to gone mounts; AppImage main-process caching
stays disabled. macOS x64 builds on ARM64 hosts run the packaged x64 Electron
under Rosetta to generate the cache. Other cross-platform and cross-architecture builds skip
generation explicitly. CLI, SEA and WSL runtimes keep their existing behavior.

Electron's Node 24 cache has no read-only option and includes the producer UID in its directory
name. The backend links individual prepared files into its writable cache with keys for the
installed module paths. Node replaces files atomically, so regeneration cannot write through those
links into signed resources. Windows uses hard links and falls back to normal caching when volumes
differ or resource permissions prevent linking. Protected installations therefore may not reuse
prepared bytecode. No cache bytes are copied during startup.

The key calculation follows Node's internal portable ESM format. Generation checks that the
packaged engine produced the expected CLI and server entries and fails the build if that format changes.
The manifest also checks Electron, Node, OS, architecture and V8's flags-sensitive version tag.
Missing or rejected entries compile from the shipped JavaScript. Prepared backends skip the
explicit startup flush; Node can persist missing entries on normal exit. The writable fallback
keeps the explicit flush needed when Windows force-kills the backend.

### Linux AppImage prerequisites

Build on Linux because the browser-secret helper links against the host's libsecret. Install
C/C++ build tools, libsecret development headers, pkg-config, and ImageMagick.
Bytecode preparation also runs packaged Electron and requires GTK, NSS, ALSA, and GBM runtime libraries.
Install Rust 1.95 or newer through [rustup](https://rust-lang.org/install), using the stable
toolchain as release CI does.

Ubuntu 24.04 and Debian 13:

```sh
sudo apt-get update
sudo apt-get install build-essential libsecret-1-dev pkg-config imagemagick libgtk-3-0t64 libnss3 libasound2t64 libgbm1
```

On Ubuntu 22.04 and Debian 12, use `libgtk-3-0` and `libasound2` instead of the `t64` packages.

Fedora:

```sh
sudo dnf install gcc gcc-c++ make libsecret-devel pkgconf-pkg-config ImageMagick gtk3 nss alsa-lib mesa-libgbm
```

Arch Linux:

```sh
sudo pacman -S base-devel libsecret pkgconf imagemagick gtk3 nss alsa-lib mesa
```

The C toolchain, pkg-config, and libsecret headers are also needed for Linux desktop development.

### macOS DMG prerequisites

Install the Xcode Command Line Tools with `xcode-select --install` and install Rust.
For a cross-architecture or universal build, add the requested Rust targets:

```sh
rustup target add aarch64-apple-darwin x86_64-apple-darwin
```

### Windows installer prerequisites

Install Rust, Python 3, and Visual Studio Build Tools with **Desktop development with C++**.
Include the Windows SDK and the MSVC build tools and Spectre-mitigated libraries for the target
architecture. Add its Rust target:

```powershell
rustup target add x86_64-pc-windows-msvc
# For an ARM64 installer:
rustup target add aarch64-pc-windows-msvc
```

NSIS is downloaded by electron-builder. WSL support additionally needs the Linux CLI archive
passed as `--wsl-runtime`; see the
[release runbook](./release.md#windows-payload-topology-and-update-validation).

### Signing and passkeys

Add `--signed` after configuring the platform credentials in the
[release runbook](./release.md). macOS passkeys need a signed, provisioned app; follow the
[Connect setup](./connect-setup.md#desktop-passkeys) for local signing and renderer HMR.

## Authorised pull requests

- Global SlipJay policy governs publication in this fork. The following applies only to an explicitly authorised PR in a repository/workflow that permits it; it does not authorise a PR here.
- If `origin` is git.cafe, follow [GitCafe mirror](#gitcafe-mirror-optional): use `cafe` for existing PRs, issues, comments and labels, but push and open PRs on GitHub, where CI runs.
- Conventional commit titles, plain language: `fix(web): new threads no longer spike CPU`.
- Body: the problem in a sentence or two, then how you fixed it. End with the model and harness that did the work.
- UI changes need before/after images. Motion or timing needs a short video.
- Upload PR evidence to GitHub. Never commit PR-only screenshots or assets such as `.github/pr-assets/`.
- One request is one PR. Split it only when the maintainer asks. Outside contributions follow the stricter [one problem per PR](../../CONTRIBUTING.md#solve-one-underlying-problem-per-pr) rule.
- When babysitting: call `watch_pull_request` and end your turn. T3 Code wakes you on checks, comments, or conflicts. Do not poll or sleep. Verify each bot finding against the source, fix real ones, dismiss false positives with a written reason. Stay quiet when nothing is new. Stop when the bots are green on the latest commit.

## Managed headless browser access

Managed `browser` tasks default to the server's integrated Chromium.
Select `agentTask.browser: { backend: "phi", phiLane: "agents" }` explicitly when a task
needs a logged-in Phi Space or a page the owner will use. `agent_roles` accepts the same
`browser` selection to check its availability. A task's credential keeps that selection
through retries and continuations.

Integrated tasks start with empty, ephemeral storage and no private-network access.
Configure `agentBrowserLoopbackAllow` in server settings or a project's settings override
to permit previews, for example `["yardsmith.localhost:3201", "weave.localhost:3202",
"localhost:3100-3199"]`. Entries match an exact hostname and port or inclusive port range;
an empty list permits no private destinations. The T3 listening port and proxy's own port
remain denied even if an entry includes them. Changing the allow list also closes active
managed contexts, so an established tunnel cannot outlive a revocation.

Each managed context uses its own authenticated forward proxy. It validates every DNS
answer and connects to that numeric address, preventing a second lookup from rebinding
an allowed public hostname to a private address. HTTP redirects, subresources, popups,
fetch and WebSockets pass through this boundary; HTTPS uses CONNECT. Service workers
are blocked, QUIC is disabled and WebRTC disables non-proxied UDP. Ordinary integrated
profiles keep their existing networking and storage. This boundary is browser networking,
not an operating-system sandbox for a provider process.

Managed integrated open requests have a 15-second response deadline plus the broker's host-response
grace (currently 5 seconds), rather than the ordinary first-install allowance. Executable
readiness and context creation each have a 5-second bound and Chromium launch a 10-second bound; run `t3 browser setup`
on the host before dispatching verification. Missing/disconnected hosts refuse immediately.
An unavailable browser never falls back to Phi. Credential expiry is swept at least once
per minute; cancellation, task cleanup and project access revocation release browser
resources without waiting for another action.
