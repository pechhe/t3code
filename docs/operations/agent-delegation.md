# Managed agent delegation

`t3 agent` and the delegation tools resolve roles and models from a central
agent policy kept outside T3 Code, in the agent-config repository
(`roles/policy.json` and the role briefs in `roles/`). Nothing is enabled until
the server is told where that checkout is.

## Turn it on

Set `T3CODE_AGENT_POLICY_ROOT` to the absolute path of the agent-config
checkout in the environment of the T3 Code server, then restart the server:

```sh
T3CODE_AGENT_POLICY_ROOT=/path/to/agent-config t3 serve
```

Without the variable, managed delegation is not configured: `t3 agent` commands
that need a policy fail with `policy`, and unmanaged delegation behaves as
before. Running trials are unaffected either way, and installing the code starts
no trial.

## Check a policy before pointing a server at it

```sh
node apps/server/scripts/validate-agent-policy.ts /path/to/agent-config
```

This reads and hashes the manifest and every role brief offline. It starts no
provider, signs in nowhere and touches no database. It prints the policy hash,
its revision and the seven role names, or the reason the policy is refused.

## What the server enforces

- Each task records the policy hash, brief hash and requested, assigned and
  effective selections when it is accepted. Editing the policy later does not
  change accepted work; it can only revoke authority at launch or resume.
- Claude models run read-only roles (advisor, reviewer, read-only
  investigation) with no T3 tools. Managed Claude source writes and the Phi-based
  `browser` and `ui-verifier` roles are refused with an explanation, and
  `ui-worker` is unavailable while Claude is the only permitted UI model.
- A delegation or reviewer trial created while a policy is configured is
  refused if one of its arms uses a model no pool allows.
