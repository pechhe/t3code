#!/bin/bash
# Keeps the local fork build (branch `rollover`) on top of upstream nightlies.
#
# Run hourly by launchd (install with `scripts/fork-nightly.sh --install-agent`):
#   1. When upstream has a newer v*-nightly.* tag and no build ran in the last
#      day, rebase `rollover` onto it, run the fork's focused checks, build the
#      macOS app, sign it with a stable local identity, install the fork's
#      server as the SSH host's remote runtime (scripts/fork-vps-runtime.sh)
#      and stage the app.
#   2. When a build is staged and T3 Code is not running, install it over
#      /Applications/T3 Code (Nightly).app, keeping the previous app.
#
# `scripts/fork-nightly.sh --build-now` builds and installs straight away, on
# the latest tag even when `rollover` already contains it (the first install).
#
# A rebase conflict or a failed check never gets resolved here: the branch is
# put back where it was, the tag is remembered as failed, and a notification
# asks for a hand rebase. The next newer tag is tried again.
#
# The local build has no update feed (no GITHUB_REPOSITORY or
# T3CODE_DESKTOP_UPDATE_REPOSITORY), so the installed app never updates itself
# back to the official nightly.
set -euo pipefail

REPO="${T3FORK_REPO:-$HOME/Engineering/t3code}"
BRANCH=rollover
# The overrides below let a dry run in a scratch clone touch nothing real.
STATE="${T3FORK_STATE:-$HOME/.t3fork}"
APP_NAME="T3 Code (Nightly).app"
INSTALLED="${T3FORK_APPLICATIONS:-/Applications}/$APP_NAME"
PUSH_REMOTE="${T3FORK_PUSH_REMOTE:-origin}"
IDENTITY="${T3FORK_SIGNING_IDENTITY:-Peach Pi Local Signing}"
# The SSH host whose remote runtime is the fork too; empty skips it. The host
# reaches this Mac as `mac` and keeps a clone of the fork at VPS_CLONE.
VPS="${T3FORK_VPS-slipjay-test}"
VPS_CLONE='~/projects/t3code-fork'
LABEL=com.pechhe.t3code-fork-nightly
REBUILD_INTERVAL_SECONDS=$((20 * 3600))

# The desktop build needs rustup's toolchain, which the login shell does not put on PATH.
export PATH="/opt/homebrew/opt/rustup/bin:$HOME/.cargo/bin:$PATH"

mkdir -p "$STATE"

if [ "${1:-}" = "--install-agent" ]; then
  plist="$HOME/Library/LaunchAgents/$LABEL.plist"
  cat >"$plist" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/zsh</string><string>-lic</string>
    <string>exec /bin/bash "$REPO/scripts/fork-nightly.sh"</string>
  </array>
  <key>StartInterval</key><integer>3600</integer>
  <key>RunAtLoad</key><true/>
  <key>StandardOutPath</key><string>$STATE/launchd.log</string>
  <key>StandardErrorPath</key><string>$STATE/launchd.log</string>
</dict>
</plist>
EOF
  launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
  launchctl bootstrap "gui/$(id -u)" "$plist"
  echo "Installed $plist"
  exit 0
fi

# A rebase rewrites this file while bash is reading it; run from a copy.
if [ -z "${T3FORK_FROM_COPY:-}" ]; then
  cp "$0" "$STATE/run.sh"
  T3FORK_FROM_COPY=1 exec /bin/bash "$STATE/run.sh" "$@"
fi

exec >>"$STATE/nightly.log" 2>&1
log() { echo "$(date '+%F %T') $*"; }
notify() {
  log "$1"
  osascript -e "display notification \"${1//\"/\\\"}\" with title \"T3 fork\"" || true
}

# One run at a time; launchd can start the next hour's run during a long build.
if ! mkdir "$STATE/lock" 2>/dev/null; then
  log "another run holds $STATE/lock; skipping"
  exit 0
fi
trap 'rmdir "$STATE/lock"' EXIT

t3_running() {
  pgrep -f "$(printf '%s' "$INSTALLED/Contents/MacOS/" | sed 's/[][()\.^$*+?{}|]/\\&/g')" >/dev/null
}

install_staged() {
  [ -d "$STATE/staged/$APP_NAME" ] || return 0
  if t3_running; then
    log "staged $(cat "$STATE/staged/version") waits for T3 Code to quit"
    return 0
  fi
  rm -rf "$STATE/previous"
  mkdir -p "$STATE/previous"
  if [ -d "$INSTALLED" ]; then ditto "$INSTALLED" "$STATE/previous/$APP_NAME"; fi
  rm -rf "$INSTALLED"
  ditto "$STATE/staged/$APP_NAME" "$INSTALLED"
  notify "Installed fork build $(cat "$STATE/staged/version")"
  rm -rf "$STATE/staged"
}

# Steps chain with && and failures are handled explicitly: bash ignores
# `set -e` inside anything run as an `if` or `||` condition.
rebuild() {
  cd "$REPO"
  if ! git fetch --quiet upstream --tags; then
    log "fetch failed; trying again next hour"
    return 0
  fi
  local tag
  tag="$(git tag -l 'v*-nightly.*' --sort=-creatordate | head -1)"
  if [ -z "$tag" ]; then return 0; fi
  local last_build now
  last_build="$(cat "$STATE/last-build" 2>/dev/null || echo 0)"
  now="$(date +%s)"
  if [ "${1:-}" != "--build-now" ]; then
    if git merge-base --is-ancestor "$tag" "$BRANCH"; then return 0; fi
    if [ "$(cat "$STATE/failed-tag" 2>/dev/null)" = "$tag" ]; then return 0; fi
    if [ $((now - last_build)) -lt "$REBUILD_INTERVAL_SECONDS" ]; then return 0; fi
  fi

  if [ "$(git branch --show-current)" != "$BRANCH" ] || [ -n "$(git status --porcelain)" ]; then
    notify "Skipped $tag: $REPO is not a clean checkout of $BRANCH"
    return 0
  fi

  local previous_head
  previous_head="$(git rev-parse HEAD)"
  give_up() {
    git rebase --abort 2>/dev/null || true
    git reset --quiet --hard "$previous_head"
    echo "$tag" >"$STATE/failed-tag"
    notify "$1; $BRANCH put back. See $STATE/nightly.log"
  }
  log "rebasing $BRANCH onto $tag"
  if ! git rebase --quiet "$tag"; then
    give_up "Rebase onto $tag conflicts, rebase by hand"
    return 0
  fi

  local version="${tag#v}"
  local marker="$STATE/build-started"
  touch "$marker"
  if ! (
    unset GITHUB_REPOSITORY T3CODE_DESKTOP_UPDATE_REPOSITORY &&
      command vp i &&
      command vp run --filter t3 typecheck &&
      command vp run --filter @t3tools/web typecheck &&
      (cd apps/server && command vp test run \
        src/orchestration-v2/ContextRollover.test.ts \
        src/orchestration-v2/ContextRollover.integration.test.ts) &&
      rm -rf "$STATE/build" &&
      command vp run dist:desktop:artifact --platform mac --target dir --arch arm64 \
        --build-version "$version" --output-dir "$STATE/build" --keep-stage
  ); then
    give_up "Fork checks or build on $tag failed"
    return 0
  fi

  # The remote host's runtime goes in before the app is staged, so the new app
  # never finds the version missing there and downloads the official one.
  if [ -n "$VPS" ] && ! ssh -n -o BatchMode=yes -o ConnectTimeout=30 "$VPS" "bash -lc '
      git -C $VPS_CLONE fetch --quiet mac:${REPO#"$HOME"/} $BRANCH &&
        git -C $VPS_CLONE checkout --quiet --detach $(git rev-parse HEAD) &&
        $VPS_CLONE/scripts/fork-vps-runtime.sh $version'"; then
    give_up "Installing the fork runtime on $VPS for $tag failed"
    return 0
  fi

  local stage app
  stage="$(find "${TMPDIR:-/tmp}" -maxdepth 1 -name 't3code-desktop-mac-stage-*' -newer "$marker" | head -1)"
  app="$stage/app/dist/mac-arm64/$APP_NAME"
  if ! { [ -d "$app" ] &&
    codesign --force --deep --sign "$IDENTITY" "$app" &&
    codesign --verify --deep --strict "$app" &&
    rm -rf "$STATE/staged" &&
    mkdir -p "$STATE/staged" &&
    ditto "$app" "$STATE/staged/$APP_NAME" &&
    echo "$version" >"$STATE/staged/version"; }; then
    rm -rf "$STATE/staged"
    give_up "Signing or staging the $tag build failed"
    return 0
  fi
  rm -rf "$stage"
  echo "$now" >"$STATE/last-build"
  rm -f "$STATE/failed-tag"
  git push --quiet --force-with-lease "$PUSH_REMOTE" "$BRANCH" || log "push of $BRANCH failed; continuing"
  log "staged $version"
}

rebuild "$@"
install_staged
