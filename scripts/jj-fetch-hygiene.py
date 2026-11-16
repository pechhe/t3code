#!/usr/bin/env python3
"""Narrow fork fetches and forget unused remote branches; dry-run unless --apply."""

import argparse
import json
import subprocess


def run(args, *, stdin=None):
    return subprocess.run(args, input=stdin, text=True, check=True, capture_output=True).stdout.strip()


def reconcile(repo, *, apply=False, origin_branches=(), upstream_branches=()):
    jj = ["jj", "-R", repo, "--ignore-working-copy", "--config", "git.abandon-unreachable-commits=false"]
    git = ["git", "--git-dir", run([*jj, "git", "root"])]
    remotes = set(run([*git, "remote"]).splitlines())
    keep = {"origin": {"t3peach", *origin_branches}, "upstream": {"main", *upstream_branches}}
    refs = [line.split(" ", 2) for line in run([
        *git, "for-each-ref", "--format=%(refname) %(objectname) %(symref)", "refs/remotes/"
    ]).splitlines()]
    # Preserve each remote's symbolic default and its target, including forks whose default is main.
    for ref, _oid, *target in refs:
        for remote in keep:
            prefix = f"refs/remotes/{remote}/"
            if ref.startswith(prefix) and target and target[0].startswith(prefix):
                keep[remote].add(target[0][len(prefix):])
    removed = []
    commands = []
    for remote, branches in keep.items():
        if remote not in remotes:
            continue
        for branch in branches:
            run([*git, "check-ref-format", f"refs/heads/{branch}"])
        patterns = " | ".join(f"exact:{branch}" for branch in sorted(branches))
        commands.extend([
            [*jj, "config", "set", "--repo", f"remotes.{remote}.fetch-bookmarks", patterns],
            [*jj, "config", "set", "--repo", f"remotes.{remote}.fetch-tags", "glob:v*" if remote == "upstream" else "~glob:*"],
            [*git, "config", "--replace-all", f"remote.{remote}.fetch", f"+refs/heads/{sorted(branches)[0]}:refs/remotes/{remote}/{sorted(branches)[0]}"],
        ])
        for branch in sorted(branches)[1:]:
            commands.append([*git, "config", "--add", f"remote.{remote}.fetch", f"+refs/heads/{branch}:refs/remotes/{remote}/{branch}"])
        if remote == "upstream":
            commands.append([*git, "config", "--add", f"remote.{remote}.fetch", "+refs/tags/v*:refs/tags/v*"])
        commands.append([*git, "config", f"remote.{remote}.tagOpt", "--no-tags"])
        prefix = f"refs/remotes/{remote}/"
        dropped = [(ref, oid) for ref, oid, *target in refs
                   if ref.startswith(prefix) and ref[len(prefix):] not in branches and not any(target)]
        imported = set(run([*jj, "bookmark", "list", "--remote", f"exact:{remote}", "-T", 'name ++ "\\n"']).splitlines())
        names = [ref[len(prefix):] for ref, _ in dropped if ref[len(prefix):] in imported]
        for offset in range(0, len(names), 100):
            # Untracking first keeps any matching local bookmark intact on import.
            commands.append([*jj, "bookmark", "untrack", "--remote", f"exact:{remote}",
                             *[f"exact:{name}" for name in names[offset:offset + 100]]])
        removed.extend(dropped)
    plan = {"apply": apply, "keep": {k: sorted(v) for k, v in keep.items() if k in remotes},
            "removeRemoteBranches": len(removed), "refs": [ref for ref, _ in removed],
            "preserve": ["local bookmarks", "all existing tags and remote tags", "all workspace commits and heads", "checkpoint refs", "jj keep refs", "operation history"]}
    if apply:
        for command in commands:
            run(command)
        if removed:
            # Compare-and-delete as one transaction: a concurrent fetch makes it fail, not delete a new tip.
            run([*git, "update-ref", "--stdin"], stdin="start\n" + "".join(
                f"delete {ref} {oid}\n" for ref, oid in removed) + "prepare\ncommit\n")
        run([*jj, "git", "import"])
    return plan


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--repo", required=True)
    parser.add_argument("--apply", action="store_true")
    parser.add_argument("--keep-origin", action="append", default=[])
    parser.add_argument("--keep-upstream", action="append", default=[])
    args = parser.parse_args()
    print(json.dumps(reconcile(args.repo, apply=args.apply, origin_branches=args.keep_origin,
                               upstream_branches=args.keep_upstream), indent=2))


if __name__ == "__main__":
    main()
