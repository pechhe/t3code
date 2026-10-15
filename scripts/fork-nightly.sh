#!/bin/bash
# Keeps the local fork build (branch `t3peach`) on top of upstream nightlies.
#
# Run hourly by launchd (install with `scripts/fork-nightly.sh --install-agent`):
#   1. When upstream has a newer v*-nightly.* tag and no build ran in the last
#      day, merge it into `t3peach`, run the fork's focused checks on the VPS
#      while this Mac builds the macOS app, sign it with a stable local identity,
#      install the fork's server as the SSH host's remote runtime
#      (scripts/fork-vps-runtime.sh), stage the app and push the merge.
#   2. When a build is staged and T3 Code is not running, install it over
#      /Applications/T3 Code (Nightly).app, keeping the previous app.
#
# `scripts/fork-nightly.sh --build-now` builds and installs straight away, on
# the latest tag even when `t3peach` already contains it. Every commit on
# `t3peach` passed SlipJay's landing gate, which runs the fork's checks, so only
# a fresh upstream merge is checked here.
#
# A merge conflict or a failed check never gets resolved here: the branch is
# put back where it was and the tag is remembered as failed. If
# $STATE/rebase-webhook-url holds a T3 scheduled-task webhook URL, the tag is
# posted there and that task runs the `t3-fork-rebase` skill; otherwise a
# notification asks for a hand merge. The next newer tag is tried again.
#
# The script works in its own git clone of the fork ($STATE/repo), never in the
# developer's checkout: that one is a jj repository whose workspaces leave git
# without a checked-out branch, and SlipJay lands changes there concurrently.
# Each run starts the clone from origin's `t3peach` and pushes a merge as a plain
# fast-forward, so a landing that happened during the build is never overwritten
# (the push fails and the next run merges again).
#
# The local build has no update feed (no GITHUB_REPOSITORY or
# T3CODE_DESKTOP_UPDATE_REPOSITORY), so the installed app never updates itself
# back to the official nightly.
set -euo pipefail

BRANCH=t3peach
# The overrides below let a dry run in a scratch clone touch nothing real.
STATE="${T3FORK_STATE:-$HOME/.t3fork}"
REPO="${T3FORK_REPO:-$STATE/repo}"
ORIGIN_URL="${T3FORK_ORIGIN_URL:-https://github.com/pechhe/t3code.git}"
UPSTREAM_URL="${T3FORK_UPSTREAM_URL:-https://github.com/pingdotgg/t3code.git}"
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

ensure_clone() {
  if [ ! -d "$REPO/.git" ]; then
    git clone --quiet --branch "$BRANCH" --origin "$PUSH_REMOTE" "$ORIGIN_URL" "$REPO"
    git -C "$REPO" remote add upstream "$UPSTREAM_URL"
  fi
}

if [ "${1:-}" = "--install-agent" ]; then
  ensure_clone
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

# A merge or checkout rewrites this file while bash is reading it; run from a copy.
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
  ensure_clone
  cd "$REPO"
  if ! { git fetch --quiet "$PUSH_REMOTE" && git fetch --quiet upstream --tags; }; then
    log "fetch failed; trying again next hour"
    return 0
  fi
  # The clone is this script's alone: start every run from what has landed.
  git checkout --quiet --force -B "$BRANCH" "$PUSH_REMOTE/$BRANCH"
  git clean --quiet -fd
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

  local previous_head merged=""
  previous_head="$(git rev-parse HEAD)"
  # A merge conflict or a failed fork check needs judgement: hand it to the agent.
  hand_off() {
    local url_file="$STATE/rebase-webhook-url"
    [ -s "$url_file" ] || return 0
    curl -fsS --max-time 30 -X POST -H 'content-type: application/json' \
      -d "{\"tag\":\"$tag\",\"reason\":\"$1\"}" "$(cat "$url_file")" >/dev/null &&
      log "handed $tag to the t3-fork-rebase agent" ||
      notify "Could not reach the t3-fork-rebase webhook for $tag"
  }
  give_up() {
    git merge --abort 2>/dev/null || true
    git reset --quiet --hard "$previous_head"
    echo "$tag" >"$STATE/failed-tag"
    notify "$1; nothing pushed. See $STATE/nightly.log"
  }
  # Upstream arrives as a merge, so the branch every thread lands on is never rewritten.
  if ! git merge-base --is-ancestor "$tag" HEAD; then
    log "merging $tag into $BRANCH"
    if ! git merge --quiet --no-edit -m "merge upstream $tag" "$tag"; then
      give_up "Merging $tag conflicts, merge by hand"
      hand_off conflict
      return 0
    fi
    merged=1
  fi

  local version="${tag#v}"
  local marker="$STATE/build-started"
  touch "$marker"

  # The VPS checks a fresh upstream merge (everything else on $BRANCH passed the
  # landing gate) and builds its server while this Mac builds the app. Its server
  # goes in only once both succeed, and before the app is staged, so the new app
  # never finds the version missing there and downloads the official one.
  local vps_log="$STATE/vps.log" vps_pid=""
  if [ -n "$VPS" ]; then
    ssh -n -o BatchMode=yes -o ConnectTimeout=30 "$VPS" "bash -lc '
      git -C $VPS_CLONE fetch --quiet mac:${REPO#"$HOME"/} $BRANCH &&
        git -C $VPS_CLONE checkout --quiet --detach $(git rev-parse HEAD) &&
        $VPS_CLONE/scripts/fork-vps-runtime.sh build $version ${merged:+--check}'" \
      >"$vps_log" 2>&1 &
    vps_pid=$!
  elif [ -n "$merged" ]; then
    if ! (command vp i &&
      command vp run --filter t3 typecheck &&
      command vp run --filter @t3tools/web typecheck &&
      (cd apps/server && command vp test run \
        src/orchestration-v2/ContextRollover.test.ts \
        src/orchestration-v2/ContextRollover.integration.test.ts)); then
      give_up "Fork checks on $tag failed"
      hand_off checks
      return 0
    fi
  fi

  local app_ok=1 vps_status=0
  (
    unset GITHUB_REPOSITORY T3CODE_DESKTOP_UPDATE_REPOSITORY &&
      command vp i &&
      rm -rf "$STATE/build" &&
      command vp run dist:desktop:artifact --platform mac --target dir --arch arm64 \
        --build-version "$version" --output-dir "$STATE/build" --keep-stage
  ) || app_ok=""
  if [ -n "$vps_pid" ]; then
    wait "$vps_pid" || vps_status=$?
    cat "$vps_log"
  fi
  if [ "$vps_status" -eq 3 ]; then
    give_up "Fork checks on $tag failed"
    hand_off checks
    return 0
  fi
  if [ -z "$app_ok" ] || [ "$vps_status" -ne 0 ]; then
    give_up "Building $version failed ($([ -z "$app_ok" ] && echo app || echo "$VPS server"))"
    return 0
  fi
  if [ -n "$VPS" ] && ! ssh -n -o BatchMode=yes -o ConnectTimeout=30 "$VPS" \
    "bash -lc '$VPS_CLONE/scripts/fork-vps-runtime.sh install $version'"; then
    give_up "Installing the fork runtime on $VPS for $version failed"
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
    give_up "Signing or staging the $version build failed"
    return 0
  fi
  rm -rf "$stage"
  echo "$now" >"$STATE/last-build"
  rm -f "$STATE/failed-tag"
  # A plain push: the merge only adds to the branch, and a landing during the
  # build makes it a non-fast-forward that fails, so the next run merges again.
  if [ -n "$merged" ]; then
    git push --quiet "$PUSH_REMOTE" "HEAD:$BRANCH" ||
      notify "Push of the $tag merge failed (something landed during the build); the next run merges again"
  fi
  log "staged $version"
}

rebuild "$@"
install_staged
