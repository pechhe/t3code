import importlib.util
import os
from pathlib import Path
import subprocess
import tempfile
import unittest

spec = importlib.util.spec_from_file_location("hygiene", Path(__file__).with_name("jj-fetch-hygiene.py"))
hygiene = importlib.util.module_from_spec(spec)
spec.loader.exec_module(hygiene)


class FetchHygieneTest(unittest.TestCase):
    def test_cleanup_preserves_local_work_and_ignores_checkpoint_refs(self):
        with tempfile.TemporaryDirectory(suffix="-scratch") as temp:
            repo = Path(temp) / "repo"
            env = {**os.environ, "JJ_CONFIG": "", "XDG_CONFIG_HOME": str(Path(temp) / "config"),
                   "GIT_CONFIG_GLOBAL": os.devnull, "GIT_CONFIG_NOSYSTEM": "1"}
            def call(*args, stdin=None):
                return subprocess.run(args, input=stdin, env=env, text=True, check=True,
                                      capture_output=True).stdout.strip()
            call("jj", "git", "init", "--colocate", str(repo))
            jj = ["jj", "-R", str(repo)]
            git = ["git", "-C", str(repo)]
            call(*git, "config", "user.name", "Test")
            call(*git, "config", "user.email", "test@example.invalid")
            (repo / "file").write_text("live workspace\n")
            call(*jj, "describe", "-m", "live work")
            tip = call(*jj, "log", "-r", "@", "--no-graph", "-T", "commit_id")
            tree = call(*git, "rev-parse", f"{tip}^{{tree}}")
            checkpoint = call(*git, "commit-tree", tree, "-m", "checkpoint")
            for remote in ("origin", "upstream"):
                call(*git, "remote", "add", remote, str(repo))
                for branch in ("main", "t3peach", "noise"):
                    call(*git, "update-ref", f"refs/remotes/{remote}/{branch}", tip)
            call(*git, "symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main")
            call(*git, "update-ref", "refs/t3/orchestration-v2/live", checkpoint)
            call(*git, "tag", "v1", tip)
            call(*jj, "--ignore-working-copy", "git", "import")
            call(*jj, "bookmark", "track", "noise@origin")
            before = call(*jj, "--ignore-working-copy", "debug", "object", "view", "--op", "@")
            self.assertNotIn(checkpoint, before)
            current = call(*jj, "log", "-r", "@", "--no-graph", "-T", "commit_id")
            # The script's own subprocesses use the same isolated configuration as the fixture.
            previous = os.environ.copy()
            os.environ.update(env)
            try:
                plan = hygiene.reconcile(str(repo))
                self.assertEqual(plan["removeRemoteBranches"], 3)
                self.assertEqual(before, call(*jj, "--ignore-working-copy", "debug", "object", "view", "--op", "@"))
                hygiene.reconcile(str(repo), apply=True)
                self.assertEqual(hygiene.reconcile(str(repo))["removeRemoteBranches"], 0)
            finally:
                os.environ.clear()
                os.environ.update(previous)
            self.assertEqual(current, call(*jj, "log", "-r", "@", "--no-graph", "-T", "commit_id"))
            self.assertEqual(tip, call(*jj, "log", "-r", "noise", "--no-graph", "-T", "commit_id"))
            self.assertEqual(checkpoint, call(*git, "rev-parse", "refs/t3/orchestration-v2/live"))
            self.assertEqual("live workspace\n", (repo / "file").read_text())
            self.assertIn("v1", call(*jj, "tag", "list"))
            self.assertNotIn("noise@origin", call(*jj, "bookmark", "list", "-a"))
            self.assertNotIn("noise@upstream", call(*jj, "bookmark", "list", "-a"))
            self.assertEqual("glob:v*", call(*jj, "config", "get", "remotes.upstream.fetch-tags"))
            self.assertEqual("~glob:*", call(*jj, "config", "get", "remotes.origin.fetch-tags"))
            self.assertNotIn("refs/heads/*", call(*git, "config", "--get-all", "remote.origin.fetch"))
            # A default fetch uses the narrowed configuration, not the remote's unrelated heads.
            call(*git, "update-ref", "refs/heads/noise", tip)
            call(*git, "update-ref", "refs/heads/main", tip)
            call(*git, "update-ref", "refs/heads/t3peach", tip)
            call(*git, "tag", "not-fetched", tip)
            call(*jj, "git", "fetch", "--remote", "origin")
            self.assertNotIn("noise@origin", call(*jj, "bookmark", "list", "-a"))
            self.assertNotIn("not-fetched@origin", call(*jj, "tag", "list", "-a"))
            call(*git, "fetch", "origin")
            self.assertNotIn("refs/remotes/origin/noise", call(*git, "for-each-ref", "--format=%(refname)", "refs/remotes/origin"))


if __name__ == "__main__":
    unittest.main()
