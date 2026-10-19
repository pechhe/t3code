#!/bin/bash
# Keeps the fork build (branch `t3peach`) current with upstream nightlies, and
# activates only builds of source that has landed. fork/README.md describes the
# update path; this script is its scheduler, builder and installer. It never
# merges or pushes: the `t3-fork-rebase` agent merges, reconciles and lands each
# upstream tag through SlipJay, whose gate checks the reconciliation receipt.
#
# launchd runs it hourly (`--install-agent` installs the job). Each run:
#   1. Repairs an interrupted desktop replacement, then installs the staged
#      build when T3 Code is not running.
#   2. Sends the agent, once per attempt, through the T3 scheduled-task webhook
#      in $STATE/rebase-webhook-url: a newer upstream tag to merge (`update`),
#      or a landed integration that no selected build holds yet (`build`). The
#      agent builds, because only it can first check that no agent turn is
#      running on the VPS, whose service the runtime install restarts.
#
# Subcommands, for the agent and by hand:
#   build [--rev <commit>] [--recovery <reason>]
#       Build, select and activate a landed commit now (default: the landed head).
#       An older commit than the selected one needs --recovery, and an explicit
#       recovery target stays selected until the next `build`.
#   install [--on-quit | --wait-for-quit]
#       Install the staged build. --on-quit starts the install-on-quit job, which
#       runs --wait-for-quit: it waits for the app to quit, installs and reopens it.
#   attempt <tag> claim <thread> [--take-over] | landed <operation> <commit>
#           | blocked <evidence|owner-decision|checks|publication> <summary> | retry
#       Record an update attempt's progress. Only `retry` lets a blocked attempt
#       be dispatched again; a new tag never answers an owner decision.
#   status
#
# The script works in its own git clone of the fork ($STATE/repo), never in the
# developer's checkout, and builds only commits on origin's `t3peach`.
#
# The local build has no update feed (no GITHUB_REPOSITORY or
# T3CODE_DESKTOP_UPDATE_REPOSITORY), so the installed app never updates itself
# back to the official nightly.
set -euo pipefail

# The overrides below let a rehearsal in scratch directories touch nothing real.
BRANCH="${T3FORK_BRANCH:-t3peach}"
STATE="${T3FORK_STATE:-$HOME/.t3fork}"
REPO="${T3FORK_REPO:-$STATE/repo}"
ORIGIN_URL="${T3FORK_ORIGIN_URL:-$(git -C "$REPO" remote get-url origin 2>/dev/null || echo https://github.com/pechhe/t3code.git)}"
UPSTREAM_URL="${T3FORK_UPSTREAM_URL:-https://github.com/pingdotgg/t3code.git}"
APP_NAME="T3 Code (Nightly).app"
INSTALLED="${T3FORK_APPLICATIONS:-/Applications}/$APP_NAME"
IDENTITY="${T3FORK_SIGNING_IDENTITY:-Peach Pi Local Signing}"
# The SSH host whose remote runtime is the fork too; empty skips it. The host
# reaches this Mac as `mac` and keeps a clone of the fork at VPS_CLONE.
VPS="${T3FORK_VPS-slipjay-test}"
VPS_CLONE='~/projects/t3code-fork'
LABEL=com.pechhe.t3code-fork-nightly
# A LaunchAgent that `install --on-quit` starts on demand. When T3 Code is
# force-quit, macOS unloads jobs an agent inside it `launchctl submit`ted, but
# keeps agents in ~/Library/LaunchAgents, which Background Task Management manages.
INSTALL_JOB="${T3FORK_INSTALL_JOB:-com.pechhe.t3code-install-on-quit}"
# An unclaimed dispatch is sent again after this long, at most MAX_DISPATCHES times.
REDISPATCH_SECONDS="${T3FORK_REDISPATCH_SECONDS:-10800}"
MAX_DISPATCHES=3

# The desktop build needs rustup's toolchain, which the login shell does not put on PATH.
export PATH="/opt/homebrew/opt/rustup/bin:$HOME/.cargo/bin:$PATH"

mkdir -p "$STATE/attempts"

ensure_clone() {
  if [ ! -d "$REPO/.git" ]; then
    git clone --quiet --branch "$BRANCH" "$ORIGIN_URL" "$REPO"
  fi
  git -C "$REPO" remote get-url upstream >/dev/null 2>&1 ||
    git -C "$REPO" remote add upstream "$UPSTREAM_URL"
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

# A build checks out other commits in the clone, rewriting this file while bash
# reads it; run from a private copy, which the copy removes once it is open. The
# copy is known by its path, not an environment flag: the app the install job
# reopens, and every agent inside it, would inherit the flag.
case "$0" in
  "$STATE"/run.*) rm -f "$0" ;;
  *)
    copy="$(mktemp "$STATE/run.XXXXXX")"
    cp "$0" "$copy"
    exec /bin/bash "$copy" "$@"
    ;;
esac

log() { echo "$(date '+%F %T') $*" >>"$STATE/nightly.log"; }
notify() {
  log "$1"
  osascript -e "display notification \"${1//\"/\\\"}\" with title \"T3 fork\"" >/dev/null 2>&1 || true
}
now() { date +%s; }

# mkdir is the lock. A holder that died is detected by its recorded pid, and a
# lock left without one (killed between mkdir and the pid write) expires, so a
# restart resumes instead of waiting forever.
acquire() {
  local lock="$STATE/$1" wait="${2:-}"
  while ! mkdir "$lock" 2>/dev/null; do
    local holder
    holder="$(cat "$lock/pid" 2>/dev/null || true)"
    if { [ -n "$holder" ] && ! kill -0 "$holder" 2>/dev/null; } ||
      { [ -z "$holder" ] && [ -n "$(find "$lock" -maxdepth 0 -mmin +1 2>/dev/null)" ]; }; then
      rm -rf "$lock"
      continue
    fi
    [ -n "$wait" ] || return 1
    sleep 2
  done
  echo $$ >"$lock/pid"
}
release() { rm -rf "${STATE:?}/$1"; }

# -a: run by an agent inside the app, the app's main process is an ancestor.
t3_running() {
  pgrep -af "$(printf '%s' "$INSTALLED/Contents/MacOS/" | sed 's/[][()\.^$*+?{}|]/\\&/g')" >/dev/null
}

json_get() { jq -r "$2 // empty" "$1" 2>/dev/null || true; }
stamp() { jq --arg at "$(date -u +%FT%TZ)" '. + {installedAt: $at}' "$1"; }

# --- Desktop activation ----------------------------------------------------

app_present() { [ -f "$1/Contents/Info.plist" ] && [ -d "$1/Contents/MacOS" ]; }
app_valid() { app_present "$1" && codesign --verify --deep --strict "$1" >/dev/null 2>&1; }

APPS_DIR="$(dirname "$INSTALLED")"
INCOMING="$APPS_DIR/.$APP_NAME.installing"
REPLACED="$APPS_DIR/.$APP_NAME.replaced"
# Names the build being installed from when its copy is complete until the
# install has finished, so recovery knows which app is which.
JOURNAL="$STATE/installing.json"

# Keeps a replaced build, with the receipt naming it, as the one-step rollback.
# The old copy is removed only once the new one is complete.
retain_previous() {
  local app="$1" receipt="${2:-}"
  rm -rf "$STATE/previous.new"
  mkdir -p "$STATE/previous.new"
  ditto "$app" "$STATE/previous.new/$APP_NAME" || {
    rm -rf "$STATE/previous.new"
    return 1
  }
  if [ -n "$receipt" ] && [ -f "$receipt" ]; then cp "$receipt" "$STATE/previous.new/receipt.json"; fi
  rm -rf "$STATE/previous"
  mv "$STATE/previous.new" "$STATE/previous"
  rm -rf "$app"
}

# Names the replaced app until it is kept as the previous build.
REPLACED_RECEIPT="$STATE/replaced-receipt.json"

# Keeps the replaced app as previous with its receipt; a failure leaves it in
# place for the next run.
retain_replaced() {
  retain_previous "$REPLACED" "$REPLACED_RECEIPT" || return 1
  rm -f "$REPLACED_RECEIPT"
}

# The journal's build is installed: record it as active and keep the replaced
# app as previous. The new app is already in place, so failing to keep the old
# one does not undo the install. Repeating this after an interruption is safe.
finish_install() {
  if [ -d "$REPLACED" ]; then
    if [ ! -f "$REPLACED_RECEIPT" ] && [ -f "$STATE/active-mac.json" ]; then
      cp "$STATE/active-mac.json" "$REPLACED_RECEIPT"
    fi
    retain_replaced || log "could not keep the replaced app as the previous build; the next run retries"
  fi
  stamp "$JOURNAL" >"$STATE/active-mac.json.tmp"
  mv "$STATE/active-mac.json.tmp" "$STATE/active-mac.json"
  if [ "$(json_get "$STATE/staged/receipt.json" .source)" = "$(json_get "$JOURNAL" .source)" ]; then
    rm -rf "$STATE/staged"
  fi
  rm -f "$JOURNAL"
}

# The installed app is replaced by two renames on one volume, after the new
# copy is complete and its signature verified, so an interruption leaves either
# app whole. This repairs whatever an interrupted replacement left behind.
recover_app() {
  if [ -f "$JOURNAL" ]; then
    if [ -d "$INCOMING" ]; then
      # The new copy never reached the install path: put the old app back.
      if ! app_present "$INSTALLED" && app_present "$REPLACED"; then mv "$REPLACED" "$INSTALLED"; fi
      rm -rf "$INCOMING"
      rm -f "$JOURNAL"
      log "an interrupted install of $(json_get "$STATE/staged/receipt.json" .version) left the app unchanged"
    elif app_present "$INSTALLED"; then
      finish_install || return 1
      log "finished the interrupted install of $(json_get "$STATE/active-mac.json" .source)"
      return 0
    else
      rm -f "$JOURNAL"
    fi
  fi
  rm -rf "$INCOMING"
  if app_present "$INSTALLED"; then
    if [ -d "$REPLACED" ]; then retain_replaced || true; fi
    return 0
  fi
  if [ -e "$INSTALLED" ]; then
    local broken
    broken="$STATE/broken-$(date +%Y%m%d%H%M%S)"
    mv "$INSTALLED" "$broken"
    log "moved an incomplete $APP_NAME aside to $broken"
  fi
  if app_present "$REPLACED"; then
    mv "$REPLACED" "$INSTALLED"
    if [ -f "$REPLACED_RECEIPT" ]; then mv "$REPLACED_RECEIPT" "$STATE/active-mac.json"; fi
    notify "Restored the T3 Code build an interrupted install replaced"
  elif app_valid "$STATE/previous/$APP_NAME" &&
    ditto "$STATE/previous/$APP_NAME" "$INCOMING" && app_valid "$INCOMING"; then
    mv "$INCOMING" "$INSTALLED"
    if [ -f "$STATE/previous/receipt.json" ]; then
      cp "$STATE/previous/receipt.json" "$STATE/active-mac.json"
    fi
    notify "T3 Code was incomplete; restored the previous fork build"
  elif [ -d "$STATE/staged/$APP_NAME" ]; then
    : # the staged build installs next
  else
    notify "T3 Code is missing and no complete recovery copy exists"
    return 1
  fi
}

replace_app() {
  rm -rf "$INCOMING"
  if ! { ditto "$1" "$INCOMING" && app_valid "$INCOMING"; }; then
    rm -rf "$INCOMING"
    return 1
  fi
  cp "$2" "$JOURNAL"
  if [ -e "$INSTALLED" ] && ! mv "$INSTALLED" "$REPLACED"; then
    rm -rf "$INCOMING" "$JOURNAL"
    return 1
  fi
  if ! mv "$INCOMING" "$INSTALLED"; then
    if [ -d "$REPLACED" ]; then mv "$REPLACED" "$INSTALLED"; fi
    rm -rf "$INCOMING" "$JOURNAL"
    return 1
  fi
  finish_install
}

# Installs the staged build if it is still the selected target; a build staged
# for a target that has since been superseded is discarded, never installed.
install_staged() {
  local staged="$STATE/staged"
  [ -f "$staged/receipt.json" ] || return 0
  local source selected version
  source="$(json_get "$staged/receipt.json" .source)"
  selected="$(json_get "$STATE/selected.json" .source)"
  version="$(json_get "$staged/receipt.json" .version)"
  if [ -z "$source" ] || [ "$source" != "$selected" ]; then
    log "staged ${source:-unidentified build} is not the selected target ${selected:-none}; discarding it"
    rm -rf "$staged"
    return 0
  fi
  if [ -f "$STATE/vps-unknown.json" ]; then
    log "staged $version waits: the VPS runtime's source is unknown until the next build"
    return 0
  fi
  if t3_running; then
    log "staged $version ($source) waits for T3 Code to quit"
    return 0
  fi
  if ! replace_app "$staged/$APP_NAME" "$staged/receipt.json"; then
    notify "Installing fork build $version failed; the installed app is unchanged"
    return 1
  fi
  notify "Installed fork build $version ($source)"
}

# --- Update attempts -------------------------------------------------------

attempt_file() { echo "$STATE/attempts/$1.json"; }

# attempt_set <tag> [jq options...] <filter>
attempt_set() {
  local file filter="${!#}"
  file="$(attempt_file "$1")"
  jq "${@:2:$#-2}" --arg at "$(date -u +%FT%TZ)" --argjson e "$(now)" \
    "$filter | . + {updatedAt: \$at, updatedEpoch: \$e}" "$file" >"$file.tmp"
  mv "$file.tmp" "$file"
}

attempt_new() {
  local file
  file="$(attempt_file "$1")"
  [ -f "$file" ] && return 0
  jq -n --arg tag "$1" --arg sha "$2" --arg phase "$3" --arg id "$1@$(now)" \
    '{tag: $tag, sha: $sha, attempt: $id, phase: $phase, dispatches: 0}' >"$file"
}

# dispatch <tag> <update|build>: asks the agent to merge the tag, or to build it.
dispatch() {
  local tag="$1" action="$2" file url_file="$STATE/rebase-webhook-url" requested=dispatched
  [ "$action" = build ] && requested=build-requested
  file="$(attempt_file "$tag")"
  if [ ! -s "$url_file" ]; then
    if [ "$(json_get "$file" .phase)" != awaiting-manual ]; then
      attempt_set "$tag" --arg a "$action" '.phase = "awaiting-manual" | .action = $a'
      notify "Upstream $tag needs the t3-fork-rebase skill run by hand ($action; no webhook configured)"
    fi
    return 0
  fi
  local id dispatches sha
  id="$(json_get "$file" .attempt)"
  sha="$(json_get "$file" .sha)"
  dispatches="$(json_get "$file" .dispatches)"
  if curl -fsS --max-time 30 -X POST -H 'content-type: application/json' \
    -d "$(jq -cn --arg tag "$tag" --arg sha "$sha" --arg attempt "$id" --arg action "$action" \
      '{tag: $tag, sha: $sha, attempt: $attempt, action: $action}')" \
    "$(cat "$url_file")" >/dev/null; then
    attempt_set "$tag" --argjson n "$((${dispatches:-0} + 1))" --arg t "$(now)" --arg p "$requested" --arg a "$action" \
      '.phase = $p | .action = $a | .dispatches = $n | .dispatchedAt = ($t | tonumber)'
    log "asked the update agent to $action $tag (attempt $id, delivery $((${dispatches:-0} + 1)))"
  else
    attempt_set "$tag" --arg a "$action" '.phase = "dispatch-failed" | .action = $a'
    notify "Could not reach the t3-fork-rebase webhook for $tag; the next run retries"
  fi
}

# Sends a dispatched attempt again once nobody claimed it in time, and gives up
# visibly after MAX_DISPATCHES deliveries.
redispatch_due() {
  local tag="$1" action="$2" file dispatched dispatches
  file="$(attempt_file "$tag")"
  dispatched="$(json_get "$file" .dispatchedAt)"
  dispatches="$(json_get "$file" .dispatches)"
  if [ $(($(now) - ${dispatched:-0})) -lt "$REDISPATCH_SECONDS" ]; then return 0; fi
  if [ "${dispatches:-0}" -ge "$MAX_DISPATCHES" ]; then
    attempt_set "$tag" '.phase = "blocked" | .blocked = {kind: "evidence", summary: "no agent claimed the attempt after repeated dispatches", resumeBy: "fork-nightly.sh attempt <tag> retry, after fixing the scheduled task"}'
    notify "No agent picked up upstream $tag after $dispatches dispatches; see $STATE/attempts"
  else
    dispatch "$tag" "$action"
  fi
}

# One update is in flight at a time, so two agents never build competing merges.
# A claimed or owner-blocked update holds every newer tag back.
update_attempts() {
  local tag="$1" sha="$2" file
  for file in "$STATE"/attempts/*.json; do
    [ -f "$file" ] || continue
    local other phase reason
    other="$(json_get "$file" .tag)"
    phase="$(json_get "$file" .phase)"
    reason="$(json_get "$file" .blocked.kind)"
    if git merge-base --is-ancestor "$(json_get "$file" .sha)" "origin/$BRANCH" 2>/dev/null; then
      case "$phase" in new | dispatched | dispatch-failed | awaiting-manual | retry | blocked | superseded)
        attempt_set "$other" '.phase = "landed" | del(.blocked)'
        ;;
      esac
      continue
    fi
    case "$phase" in superseded) continue ;; esac
    [ "$other" = "$tag" ] && continue
    if [ "$phase" = claimed ] || { [ "$phase" = blocked ] && [ "$reason" = owner-decision ]; }; then
      log "upstream $tag waits for attempt $(json_get "$file" .attempt) ($phase${reason:+: $reason})"
      return 0
    fi
    attempt_set "$other" --arg by "$tag" '.phase = "superseded" | .supersededBy = $by'
  done

  attempt_new "$tag" "$sha" new
  file="$(attempt_file "$tag")"
  case "$(json_get "$file" .phase)" in
    new | dispatch-failed | retry | awaiting-manual) dispatch "$tag" update ;;
    dispatched) redispatch_due "$tag" update ;;
    blocked) log "upstream $tag is blocked: $(json_get "$file" .blocked.summary)" ;;
  esac
}

# The newest upstream integration on a commit's first-parent history.
integration_of() { git rev-list --first-parent --merges -n1 "$1"; }

# Asks the agent to build when the landed head holds an upstream integration the
# selected build lacks, the selected build never reached the Mac (its staging
# failed), or a VPS install's outcome is unknown. An explicit recovery target
# stays until someone builds.
request_build() {
  local head integration selected
  head="$(git rev-parse "origin/$BRANCH")"
  integration="$(integration_of "$head")"
  selected="$(json_get "$STATE/selected.json" .source)"
  if [ -n "$(json_get "$STATE/selected.json" .recovery)" ]; then
    log "recovery target $selected stays selected until \`fork-nightly.sh build\` replaces it"
    return 0
  fi
  if [ -n "$selected" ] && git merge-base --is-ancestor "$integration" "$selected" 2>/dev/null &&
    [ ! -f "$STATE/vps-unknown.json" ] &&
    { [ -f "$STATE/staged/receipt.json" ] || [ "$(json_get "$STATE/active-mac.json" .source)" = "$selected" ]; }; then
    return 0
  fi
  if [ "$(json_get "$STATE/build-failed.json" .source)" = "$head" ]; then
    log "the build of $head failed before; a new landing or \`fork-nightly.sh build\` retries it"
    return 0
  fi
  local tag upstream
  tag="$(git show "$head:fork/upstream-receipt.json" 2>/dev/null | jq -r '.upstream.target.tag // empty' || true)"
  upstream="$(git rev-parse "$integration^2" 2>/dev/null || true)"
  if [ -z "$tag" ] || [ -z "$upstream" ]; then
    log "the landed head $head has no readable upstream receipt; nothing to build"
    return 0
  fi
  attempt_new "$tag" "$upstream" landed
  local file phase
  file="$(attempt_file "$tag")"
  phase="$(json_get "$file" .phase)"
  case "$phase" in
    new | dispatched | dispatch-failed | awaiting-manual | retry | blocked | superseded)
      attempt_set "$tag" '.phase = "landed" | del(.blocked)'
      ;;
    claimed)
      # Its agent may still be waiting for the VPS to go quiet, so the claim is never
      # taken over here: say once who holds it and how to resume.
      local quiet
      quiet="$(json_get "$file" .updatedEpoch)"
      if [ $(($(now) - ${quiet:-0})) -ge "$REDISPATCH_SECONDS" ] && [ -z "$(json_get "$file" .quietNotified)" ]; then
        notify "Upstream $tag landed but its claim by $(json_get "$file" .claimedBy) has not built it; once that thread has stopped, run fork-nightly.sh attempt $tag retry"
        attempt_set "$tag" '.quietNotified = true'
      fi
      ;;
  esac
  case "$(json_get "$file" .phase)" in
    landed | active | dispatch-failed | awaiting-manual | retry) dispatch "$tag" build ;;
    build-requested) redispatch_due "$tag" build ;;
  esac
}

attempt_command() {
  local tag="${1:?tag}" action="${2:?action}" file
  file="$(attempt_file "$tag")"
  acquire attempts.lock wait
  trap 'release attempts.lock' EXIT
  if [ ! -f "$file" ]; then
    ensure_clone
    git -C "$REPO" fetch --quiet upstream tag "$tag" --no-tags
    attempt_new "$tag" "$(git -C "$REPO" rev-parse "$tag^{commit}")" new
    attempt_set "$tag" '.manual = true'
  fi
  case "$action" in
    claim)
      local thread="${3:?thread}" holder phase
      holder="$(json_get "$file" .claimedBy)"
      phase="$(json_get "$file" .phase)"
      if [ "$phase" = active ]; then
        echo "attempt $(json_get "$file" .attempt) is already landed and active" >&2
        exit 3
      fi
      if [ "$phase" = claimed ] && [ -n "$holder" ] && [ "$holder" != "$thread" ] && [ "${4:-}" != --take-over ]; then
        echo "attempt $(json_get "$file" .attempt) is claimed by $holder; resume it there, or pass --take-over once that thread is confirmed stopped" >&2
        exit 3
      fi
      attempt_set "$tag" --arg t "$thread" '.phase = "claimed" | .claimedBy = $t | del(.blocked) | del(.quietNotified)'
      ;;
    landed)
      attempt_set "$tag" --arg op "${3:?operation}" --arg c "${4:?commit}" \
        '.phase = "landed" | .landing = {operation: $op, commit: $c}'
      ;;
    blocked)
      local kind="${3:?kind}"
      case "$kind" in evidence | owner-decision | checks | publication) ;; *)
        echo "blocked kind must be evidence, owner-decision, checks or publication" >&2
        exit 2
        ;;
      esac
      attempt_set "$tag" --arg k "$kind" --arg s "${4:?summary}" \
        '.phase = "blocked" | .blocked = {kind: $k, summary: $s, resumeBy: (if $k == "owner-decision" then "Henry answers in the claiming thread; the agent there resumes this attempt" else "the claiming agent fixes the cause, or fork-nightly.sh attempt <tag> retry" end)}'
      ;;
    retry) attempt_set "$tag" '.phase = "retry" | .dispatches = 0 | del(.blocked) | del(.claimedBy) | del(.quietNotified)' ;;
    *)
      echo "unknown attempt action $action" >&2
      exit 2
      ;;
  esac
  cat "$file"
}

# --- Build and selection ---------------------------------------------------

# Installs the built runtime on the VPS. A failed or lost install is read back
# from the VPS: 0 installed, 1 not switched, 2 switched but unfinished or unknown.
vps_install() {
  local version="$1" source="$2" remote
  if ssh -n -o BatchMode=yes -o ConnectTimeout=30 "$VPS" \
    "bash -lc '$VPS_CLONE/scripts/fork-vps-runtime.sh install $version $source'"; then
    return 0
  fi
  remote="$(ssh -n -o BatchMode=yes -o ConnectTimeout=30 "$VPS" \
    "bash -lc '$VPS_CLONE/scripts/fork-vps-runtime.sh state $version $source'" 2>/dev/null || true)"
  case "$remote" in
    installed) return 0 ;;
    absent) return 1 ;;
    *) return 2 ;;
  esac
}

build() {
  local rev="" recovery=""
  while [ $# -gt 0 ]; do
    case "$1" in
      --rev) rev="$2"; shift 2 ;;
      --recovery) recovery="$2"; shift 2 ;;
      *) echo "unknown build option $1" >&2; return 2 ;;
    esac
  done
  ensure_clone
  cd "$REPO"
  git fetch --quiet origin || return 1
  local source
  source="$(git rev-parse --verify "${rev:-origin/$BRANCH}^{commit}")" || return 1
  if ! git merge-base --is-ancestor "$source" "origin/$BRANCH"; then
    notify "$source has not landed on $BRANCH; only landed source is built"
    return 1
  fi
  local selected
  selected="$(json_get "$STATE/selected.json" .source)"
  if [ -n "$selected" ] && [ "$selected" != "$source" ] &&
    git merge-base --is-ancestor "$source" "$selected" 2>/dev/null && [ -z "$recovery" ]; then
    notify "$source is older than the selected build $selected; pass --recovery <reason> to select it"
    return 1
  fi
  git checkout --quiet --force --detach "$source" && git clean --quiet -fd || return 1

  # Activation requires a current reconciliation receipt for the newest upstream
  # integration in this source; SlipJay's gate already required it to land. Source
  # from before receipts existed is built only as an explicit recovery target.
  local check tag upstream version checker="$STATE/receipt-check.ts"
  if git cat-file -e "$source:fork/upstream-receipt.json" 2>/dev/null; then
    # The landed head's checker judges every source, including one older than it.
    check="$(git show "origin/$BRANCH:scripts/fork-upstream-receipt.ts" >"$checker" 2>&1 &&
      node "$checker" verify --repo "$REPO" --rev "$source" 2>&1)" || {
      notify "Not building $source: $check"
      jq -n --arg s "$source" --arg r "$check" '{source: $s, reason: $r}' >"$STATE/build-failed.json"
      return 1
    }
    tag="$(jq -r .upstream.target.tag fork/upstream-receipt.json)"
    upstream="$(jq -r .upstream.target.sha fork/upstream-receipt.json)"
  elif [ -n "$recovery" ]; then
    git fetch --quiet upstream --tags || true
    upstream="$(git rev-parse --verify --quiet "$(integration_of "$source")^2" || true)"
    tag="$(git tag --points-at "${upstream:-HEAD}" --list 'v*-nightly.*' | tail -1)"
    if [ -z "$upstream" ] || [ -z "$tag" ]; then
      notify "Not building $source: its newest merge is not a tagged upstream nightly"
      return 1
    fi
    check="predates upstream receipts; recovery: $recovery"
  else
    check="$source has no upstream receipt; a build from before receipts needs --recovery <reason>"
    notify "Not building $source: $check"
    jq -n --arg s "$source" --arg r "$check" '{source: $s, reason: $r}' >"$STATE/build-failed.json"
    return 1
  fi
  version="${tag#v}"
  log "building $version from $source ($check)"

  local marker="$STATE/build-started" fail=""
  touch "$marker"
  # The VPS builds its server while this Mac builds the app. Its server goes in
  # before the app is staged, so the new app never finds the version missing
  # there and downloads the official one.
  local vps_log="$STATE/vps.log" vps_pid=""
  if [ -n "$VPS" ]; then
    ssh -n -o BatchMode=yes -o ConnectTimeout=30 "$VPS" "bash -lc '
      git -C $VPS_CLONE fetch --quiet mac:${REPO#"$HOME"/} $source &&
        git -C $VPS_CLONE checkout --quiet --detach $source &&
        $VPS_CLONE/scripts/fork-vps-runtime.sh build $version'" \
      >"$vps_log" 2>&1 &
    vps_pid=$!
  fi
  (
    unset GITHUB_REPOSITORY T3CODE_DESKTOP_UPDATE_REPOSITORY &&
      command vp i &&
      rm -rf "$STATE/build" &&
      command vp run dist:desktop:artifact --platform mac --target dir --arch arm64 \
        --build-version "$version" --output-dir "$STATE/build" --keep-stage
  ) || fail="the app build"
  if [ -n "$vps_pid" ]; then
    wait "$vps_pid" || fail="${fail:-the $VPS server build}"
    cat "$vps_log" >>"$STATE/nightly.log"
  fi
  local stage app
  stage="$(find "${TMPDIR:-/tmp}" -maxdepth 1 -name 't3code-desktop-mac-stage-*' -newer "$marker" -print -quit)"
  app="$stage/app/dist/mac-arm64/$APP_NAME"
  if [ -z "$fail" ] && ! { [ -d "$app" ] &&
    codesign --force --deep --sign "$IDENTITY" "$app" &&
    codesign --verify --deep --strict "$app"; }; then
    fail="signing the app"
  fi
  if [ -n "$fail" ]; then
    jq -n --arg s "$source" --arg r "$fail failed" '{source: $s, reason: $r}' >"$STATE/build-failed.json"
    notify "Building $version from $source failed ($fail); nothing was activated"
    [ -z "$stage" ] || rm -rf "$stage"
    return 1
  fi

  local receipt
  receipt="$(jq -n --arg s "$source" --arg v "$version" --arg t "$tag" --arg u "$upstream" \
    --arg i "$(integration_of "$source")" --arg c "$check" --arg r "$recovery" \
    --arg at "$(date -u +%FT%TZ)" --arg asar "$(shasum -a 256 "$app/Contents/Resources/app.asar" 2>/dev/null | cut -d' ' -f1)" \
    '{source: $s, version: $v, upstream: {tag: $t, sha: $u}, integration: $i, receiptCheck: $c,
      appAsarSha256: $asar, builtAt: $at} + (if $r == "" then {} else {recovery: $r} end)')"

  # Selecting this build supersedes the previous target: the VPS runtime moves
  # first, then the app is staged for install-on-quit.
  if [ -n "$VPS" ]; then
    local vps_status=0
    vps_install "$version" "$source" || vps_status=$?
    if [ "$vps_status" -eq 2 ]; then
      echo "$receipt" >"$STATE/vps-unknown.json"
      rm -rf "$stage"
      notify "The VPS install of $version ($source) did not finish or gave no answer; Mac installs wait until a build confirms the VPS (partial activation)"
      return 1
    elif [ "$vps_status" -ne 0 ]; then
      echo "$receipt" | jq '. + {reason: "the VPS runtime install failed"}' >"$STATE/build-failed.json"
      rm -rf "$stage"
      notify "Installing the fork runtime on $VPS for $version failed; the selected build is unchanged"
      return 1
    fi
    rm -f "$STATE/vps-unknown.json"
    echo "$receipt" | stamp /dev/stdin >"$STATE/active-vps.json"
  fi
  echo "$receipt" >"$STATE/selected.json.tmp"
  mv "$STATE/selected.json.tmp" "$STATE/selected.json"
  rm -f "$STATE/build-failed.json"

  rm -rf "$STATE/staged.new"
  mkdir -p "$STATE/staged.new"
  if ! { ditto "$app" "$STATE/staged.new/$APP_NAME" && app_valid "$STATE/staged.new/$APP_NAME"; }; then
    rm -rf "$STATE/staged.new" "$stage"
    notify "Staging the $version app failed; the VPS runs $source, the Mac keeps its build until the next build (partial activation)"
    return 1
  fi
  echo "$receipt" >"$STATE/staged.new/receipt.json"
  rm -rf "$STATE/staged"
  mv "$STATE/staged.new" "$STATE/staged"
  rm -rf "$stage"
  log "staged $version ($source)"
  if [ -f "$(attempt_file "$tag")" ]; then
    acquire attempts.lock wait
    attempt_set "$tag" --arg s "$source" '.phase = "active" | .selected = $s'
    release attempts.lock
  fi
}

# The launchd job runs the clone's copy of this script: keep it at the landed head.
reset_clone() {
  git -C "$REPO" checkout --quiet --force -B "$BRANCH" "origin/$BRANCH" && git -C "$REPO" clean --quiet -fd
}

hourly() {
  ensure_clone
  cd "$REPO"
  if ! { git fetch --quiet origin && git fetch --quiet upstream --tags; }; then
    log "fetch failed; trying again next hour"
    return 0
  fi
  reset_clone
  local tag sha
  tag="$(git for-each-ref --count=1 --sort=-creatordate --format='%(refname:short)' 'refs/tags/v*-nightly.*')"
  acquire attempts.lock wait
  if [ -n "$tag" ]; then
    sha="$(git rev-parse "$tag^{commit}")"
    if ! git merge-base --is-ancestor "$sha" "origin/$BRANCH"; then update_attempts "$tag" "$sha"; fi
  fi
  request_build
  release attempts.lock
}

# Leaves a job waiting from this plist alone; otherwise (re)loads the job from
# its plist, which also replaces one an older version submitted, and starts it.
start_install_on_quit() {
  local domain="gui/$(id -u)" plist="$HOME/Library/LaunchAgents/$INSTALL_JOB.plist" env="" name value job
  job="$(launchctl print "$domain/$INSTALL_JOB" 2>/dev/null || true)"
  if grep -qxF $'\tstate = running' <<<"$job" && grep -qxF $'\tpath = '"$plist" <<<"$job"; then
    echo "$INSTALL_JOB is already waiting for T3 Code to quit"
    return 0
  fi
  # A rehearsal's overrides reach the job.
  while IFS='=' read -r name value; do
    value="${value//&/&amp;}"
    env+="<key>$name</key><string>${value//</&lt;}</string>"
  done < <(env | grep '^T3FORK_' || true)
  mkdir -p "$(dirname "$plist")"
  cat >"$plist" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$INSTALL_JOB</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/zsh</string><string>-lic</string>
    <string>exec /bin/bash "$REPO/scripts/fork-nightly.sh" install --wait-for-quit</string>
  </array>
  <key>EnvironmentVariables</key><dict>$env</dict>
  <key>StandardOutPath</key><string>$STATE/launchd.log</string>
  <key>StandardErrorPath</key><string>$STATE/launchd.log</string>
</dict>
</plist>
EOF
  launchctl bootout "$domain/$INSTALL_JOB" 2>/dev/null || true
  launchctl bootstrap "$domain" "$plist"
  launchctl kickstart "$domain/$INSTALL_JOB"
  echo "$INSTALL_JOB waits for T3 Code to quit, then installs the staged build"
}

status() {
  for name in selected active-mac active-vps vps-unknown build-failed; do
    if [ -f "$STATE/$name.json" ]; then
      echo "$name: $(jq -c '{source, version, upstream: .upstream.tag, at: (.installedAt // .builtAt), reason, recovery}' "$STATE/$name.json")"
    fi
  done
  if [ -f "$STATE/staged/receipt.json" ]; then
    echo "staged: $(jq -c '{source, version}' "$STATE/staged/receipt.json")"
  fi
  for file in "$STATE"/attempts/*.json; do
    [ -f "$file" ] && echo "attempt: $(jq -c '{attempt, phase, action, claimedBy, blocked, landing}' "$file")"
  done
  return 0
}

case "${1:-}" in
  "")
    exec >>"$STATE/nightly.log" 2>&1
    acquire lock || {
      log "another run holds $STATE/lock; skipping"
      exit 0
    }
    trap 'release lock' EXIT
    recover_app || true
    install_staged || true
    hourly
    ;;
  build)
    shift
    echo "building; progress is in $STATE/nightly.log"
    exec >>"$STATE/nightly.log" 2>&1
    acquire lock wait
    trap 'release lock' EXIT
    recover_app || true
    rc=0
    build "$@" || rc=$?
    reset_clone
    install_staged || true
    exit "$rc"
    ;;
  install)
    if [ "${2:-}" = --on-quit ]; then
      start_install_on_quit
      exit 0
    fi
    if [ "${2:-}" = --wait-for-quit ]; then
      while t3_running; do sleep 3; done
    fi
    acquire lock wait
    trap 'release lock' EXIT
    recover_app || true
    had_staged="$([ -f "$STATE/staged/receipt.json" ] && echo 1 || true)"
    rc=0
    install_staged || rc=$?
    if [ "${2:-}" = --wait-for-quit ]; then
      if [ -n "$had_staged" ] && app_present "$INSTALLED"; then open "$INSTALLED" || true; fi
    fi
    exit "$rc"
    ;;
  attempt)
    shift
    attempt_command "$@"
    ;;
  status) status ;;
  *)
    echo "usage: $0 [--install-agent | build [--rev <commit>] [--recovery <reason>] | install [--on-quit | --wait-for-quit] | attempt <tag> <action> ... | status]" >&2
    exit 2
    ;;
esac
