# Development

## First checkout

Install `vp` using the [root README](../../README.md#install-vp). The checkout requires Node 24;
Bun is optional. From the repository root:

```sh
vp i
vp run dev
```

Open the pairing URL printed by the dev runner. The bare origin does not authenticate
a new browser.

Prefer a container? See [Dev container](../internals/devcontainer.md) for VS Code and Codespaces setup.

## Choosing a dev process

Use `vp run dev` for server and web, or `vp run dev:desktop` for the Electron client.
`dev:server` and `dev:web` start those processes separately.
See the [mobile README](../../apps/mobile/README.md) for native builds and Metro.

Flags go directly after the task name, for example `vp run dev --home-dir /tmp/t3code-dev`. Do not add a `--` before them: it forwards `--home-dir` to Vite, which crashes.
Add `--browser` to open a browser automatically.

### State and ports

Linked git worktrees and SlipJay (jj) workspaces default to their own `.t3/userdata`, from the workspace root or any nested directory, even when `T3CODE_HOME` is set.
The main checkout defaults to `~/.t3/dev/userdata`. An explicit `--home-dir` wins in both cases.
Inside a SlipJay workspace directory where no workspace root is recognised, the runner refuses to start instead of using the shared home; pass `--home-dir`.
`vp run migrate-dev-db` follows the same default; `--base-dir` overrides it.
Never run a development server against the live `~/.t3/userdata`.
See [test data](../../AGENTS.md#test-data) for copying a consistent database snapshot.

Read ports from the `[dev-runner]` output. Worktrees derive stable preferences from their paths,
but occupied ports can shift them. `T3CODE_PORT_OFFSET` or `T3CODE_DEV_INSTANCE` can select a
different preference when needed.

### Sharing and remote debugging

`vp run dev --share` publishes the web port over the machine's tailnet and prints a pairing URL
for that origin. Give the tester the complete URL, including its token. The dev runner removes
its mapping on exit.

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

The token and startup pairing URLs are reusable administrative secrets. Never put them in a
commit, pull request, or public output. Every server still seeds its own auth database record at
startup and keeps its own SQLite data, signing key, and revocation state. Desktop and non-dev
servers ignore the value. See [environment authentication](../internals/environment-auth.md#reusable-dev-credential)
for the security model.

## Checks

`vp run check:changed` runs CI's fast checks for your branch's changes: format and lint of the
changed files, `knip:check` when code or a manifest changes, the generated GraphQL checks, typecheck
of the affected packages and their dependents, and the test files beside the changed files. It maps
files to packages with [ci-changes.cjs](../../.github/scripts/ci-changes.cjs), as CI does. It
compares against the merge base with the integration branch (`origin/main`, or `origin/<integrationBranch>` where `slipjay.json` names one), or with a ref you pass. CI still runs the full
test suites and the jobs the summary lists, so a local pass does not promise a green CI run.

While you iterate, run single checks:

```sh
vp test run <files>
vp lint <files>
vp run --filter <package> typecheck
```

In `apps/web`, a test that renders React or touches the DOM is named `*.browser.test.{ts,tsx}`
and runs in headless Chromium with the React Compiler on, like the app. There is no jsdom; other
`*.test.ts` files run in Node.

TypeScript workspaces typecheck with tsc-rs, which has Effect diagnostics built in.
Keep `typescript`, `@effect/tsgo`, and the `effect-tsgo patch` prepare step: editors
still use them for Effect quick fixes and refactors. Keep `@effect/tsgo` on the
effect-tsgo version that tsc-rs ports (see the tsc-rs README), or the two disagree
on rule names.
Marketing keeps `astro check` for Astro files.

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

A flaky test can be quarantined in `tests/quarantine.json` as
`{"file": "<repository-relative test file>", "issue": 123, "reason": "..."}`. The gate leaves it
out of every run it makes; `pnpm test` and CI still run it. Each entry names an open Issue, and
the entry is removed when that Issue closes. `pnpm test:audit` (`--audit`) runs every workspace's
complete suite in parallel with the quarantined tests included, for the nightly audit.

When `SLIPJAY_TEST_REPORT_DIR` is set, each Vitest run also writes a JSON report there, and
`slipjay-test-reports.json` lists them. Nothing is written otherwise, and a missing report never
fails the gate. The budget's outcome is listed there too, as skipped rows the runner keeps in the landing's test
report when it clips the console output: one row per deferred file (suite `landing-deferred`) and
one row whose suite name is the budget summary, which says when the mandatory tests alone exceed
the budget. The summary is also the output's last line.
`budgets` in `slipjay.json` holds the verification time targets.

### Unused code

`vp run knip:check` checks unused files and dependencies across the repo, then
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

DMGs default to the host architecture. Use `--arch` to choose another target and `--keep-stage`
to retain packaging files for inspection. Run `vp run dist:desktop:artifact --help` for other
options.

### Linux AppImage prerequisites

Build on Linux because the browser-secret helper links against the host's libsecret. Install
Rust, C/C++ build tools, libsecret development headers, pkg-config, and ImageMagick.

Ubuntu and Debian:

```sh
sudo apt-get update
sudo apt-get install cargo rustc build-essential libsecret-1-dev pkg-config imagemagick
```

Fedora:

```sh
sudo dnf install rust cargo gcc gcc-c++ make libsecret-devel pkgconf-pkg-config ImageMagick
```

Arch Linux:

```sh
sudo pacman -S rust base-devel libsecret pkgconf imagemagick
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
