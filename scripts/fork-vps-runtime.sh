#!/bin/bash
# Builds and installs the fork's server as the remote runtime for one release
# version, on a Linux host the desktop app reaches over SSH. Run by
# scripts/fork-nightly.sh from a clone of the fork on that host, checked out at
# the landed commit to build, in two steps so the build runs while the Mac builds
# the app:
#
#   scripts/fork-vps-runtime.sh build <version>
#   scripts/fork-vps-runtime.sh install <version> <source commit>
#   scripts/fork-vps-runtime.sh state <version> <source commit>
#
# `build` builds and smoke-tests the archive and keeps it beside the installed
# versions with the commit it was built from. It runs no checks: only landed
# source is built, and SlipJay's landing gate checked it. `install` puts that
# archive in place only when it was built from the selected commit, and records
# the commit in `<version>/.fork-source`, since fork builds share upstream's
# version strings. `state` reads back an install whose answer was lost: it prints
# `installed` once every install step finished, `partial` when the runtime was
# switched but a later step (service install, restart, health check) did not
# finish, and `absent` when the switch never happened.
#
# The desktop's SSH launcher runs ~/.t3/runtime/versions/<version>/t3 and
# downloads the official archive only when that directory is not marked
# installed, so a fork runtime placed there first is the one it uses. The
# official archive still supplies the resource monitor (a Rust build this host
# does not need to reproduce).
#
# When the desktop's managed server already runs this version (a rebuild of
# the version that is live), it is restarted on the same port; the desktop's
# tunnel reconnects to it. A newer version needs no restart: the desktop starts
# it when the matching app connects. An installed boot service is reconciled
# to the deployed version and restarted even for a rebuild of the same version.
set -euo pipefail

MODE="$1"
VERSION="$2"
CLONE="$(cd "$(dirname "$0")/.." && pwd)"
VERSIONS="$HOME/.t3/runtime/versions"
TARGET="$VERSIONS/$VERSION"
PENDING="$VERSIONS/.fork-pending-$VERSION.tar.gz"
SOURCE="${3:-}"
RELEASES=https://github.com/pingdotgg/t3code/releases/download
ARCHIVE="t3-$VERSION-linux-x64.tar.gz"
# Keep in step with SEA_NODE_VERSION in apps/server/vite.config.ts.
SEA_NODE_VERSION=26.8.2

cd "$CLONE"

if [ "$MODE" = state ]; then
  # An unfinished install outranks the success marker: a retry of the same
  # version and source leaves the earlier .fork-active in place until it finishes.
  if [ "$(cat "$VERSIONS/.fork-installing" 2>/dev/null)" = "$VERSION $SOURCE" ]; then
    echo partial
  elif [ "$(cat "$VERSIONS/.fork-active" 2>/dev/null)" = "$VERSION $SOURCE" ]; then
    echo installed
  else
    echo absent
  fi
  exit 0
fi

if [ "$MODE" = install ]; then
  [ -f "$PENDING" ] || { echo "no built fork runtime for $VERSION" >&2; exit 1; }
  commit="$(cat "$PENDING.source" 2>/dev/null || true)"
  if [ -z "$SOURCE" ] || [ "$commit" != "$SOURCE" ]; then
    echo "the built fork runtime for $VERSION is from ${commit:-an unknown commit}, not ${SOURCE:-a named commit}; not installing" >&2
    exit 1
  fi
  staging="$(mktemp -d "$VERSIONS/.staging-XXXXXX")"
  tar -xzf "$PENDING" -C "$staging" --strip-components=1
  printf '%s\n' "$commit" >"$staging/.fork-source"
  printf '%s\n' "$VERSION" >"$staging/.install-complete"
  # Only the newest official copy is worth keeping, as a one-move rollback.
  rm -rf "$VERSIONS"/*.official
  # From here the runtime on disk is the new one until the steps below finish.
  printf '%s %s\n' "$VERSION" "$commit" >"$VERSIONS/.fork-installing"
  if [ -d "$TARGET" ]; then mv "$TARGET" "$TARGET.official"; fi
  mv "$staging" "$TARGET"
  rm -f "$PENDING" "$PENDING.source"
  echo "installed fork runtime $VERSION ($commit)"
else
  [ "$MODE" = build ] || { echo "usage: $0 build <version> | install <version> <source commit> | state <version> <source commit>" >&2; exit 2; }

commit="$(git rev-parse HEAD)"
work="$(mktemp -d)"
trap 'rm -rf "$work"; git -C "$CLONE" checkout --quiet -- .' EXIT

command vp i
node scripts/update-release-package-versions.ts "$VERSION" >/dev/null
command vp run --filter t3 build
PATH="$HOME/.local/share/vite-plus/fallback-bin:$PATH" VP_NODE_VERSION="$SEA_NODE_VERSION" \
  node apps/server/scripts/cli.ts build-exe

mkdir "$work/official"
curl -fsSL --connect-timeout 30 "$RELEASES/v$VERSION/SHA256SUMS" -o "$work/SHA256SUMS"
curl -fsSL --connect-timeout 30 --max-time 240 "$RELEASES/v$VERSION/$ARCHIVE" -o "$work/$ARCHIVE"
(cd "$work" && grep " \*\{0,1\}$ARCHIVE$" SHA256SUMS | sha256sum -c --quiet -)
tar -xzf "$work/$ARCHIVE" -C "$work/official" --strip-components=1

node scripts/build-cli-archive.ts --platform linux --arch x64 --version "$VERSION" \
  --resource-monitor-dir "$work/official/resource-monitor" --output-dir "$work/fork"
node scripts/smoke-cli-archive.ts --archive "$work/fork/$ARCHIVE" --expect-version "$VERSION"
mkdir -p "$VERSIONS"
mv "$work/fork/$ARCHIVE" "$PENDING"
printf '%s\n' "$commit" >"$PENDING.source"
echo "built fork runtime $VERSION ($commit)"
exit 0
fi

# Boot services live outside the desktop SSH-launch registry. Use the CLI's
# service lifecycle so its unit, version state, base directory and drop-ins stay coherent.
if [ -f "$HOME/.config/systemd/user/t3code.service" ]; then
  service_pid="$(systemctl --user show t3code.service --property=MainPID --value)"
  "$TARGET/t3" service install --base-dir "$HOME/.t3"
  # install is a no-op for the same version, but the fork's executable changed.
  if [ "$(systemctl --user show t3code.service --property=MainPID --value)" = "$service_pid" ]; then
    "$TARGET/t3" service restart --base-dir "$HOME/.t3"
  fi
  "$TARGET/t3" service status --base-dir "$HOME/.t3"
  echo "updated the boot service to $VERSION ($commit)"
fi

for state in "$HOME"/.t3/ssh-launch/*/; do
  pid="$(cat "$state/pid" 2>/dev/null || true)"
  [ -n "$pid" ] && [ "$(cat "$state/managed" 2>/dev/null)" = managed ] || continue
  case "$(ps -o args= -p "$pid" 2>/dev/null)" in
    "$TARGET/t3 serve "*) ;;
    *) continue ;;
  esac
  port="$(cat "$state/port")"
  kill "$pid"
  for _ in $(seq 50); do kill -0 "$pid" 2>/dev/null || break; sleep 0.2; done
  # The same command the desktop's launcher uses, detached from this session.
  setsid nohup env T3CODE_NO_BROWSER=1 "$state/run-t3.sh" serve --host 127.0.0.1 \
    --port "$port" --base-dir "$HOME/.t3" >>"$state/server.log" 2>&1 </dev/null &
  echo "$!" >"$state/pid"
  for _ in $(seq 60); do
    if curl -fsS --max-time 5 -o /dev/null "http://127.0.0.1:$port/"; then break; fi
    sleep 0.5
  done
  curl -fsS --max-time 5 -o /dev/null "http://127.0.0.1:$port/"
  echo "restarted the server on port $port"
done

# Present only once every step above succeeded; see `state`.
printf '%s %s\n' "$VERSION" "$commit" >"$VERSIONS/.fork-active"
rm -f "$VERSIONS/.fork-installing"
