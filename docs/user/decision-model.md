# Decision model

Agents, Champions and browser checks ask bounded questions ("is there a workaround?", "which area is this?") and one model answers them. Settings → Decisions chooses which one.

## Choose the provider

Open Settings → Decisions. Pick **Jev (TypeSafe)**, the default, **OpenAI** or **OpenRouter**, then enter that provider's API key. For OpenRouter you can also change the model; the default follows the latest Jev. The "Applying settings across" picker at the top works as on other pages: leave it on All environments to change every environment at once.

A key can be pasted or read from a secret provider such as 1Password. Once saved it is never shown again; only its last four characters appear. If a key comes from the server's own environment or secrets instead, the page says so.

## Test it

**Test** sends one tiny question to each environment in scope and reports whether it worked, how long it took and what it cost. It spends a fraction of a cent.

## When it fails

A failing provider fails the decision and says which provider and why: key rejected, out of credits, rate limited, timed out or unreachable. Nothing switches to another provider or retries. When Jev credits run out, switch to OpenRouter here and enter its key.

## Compare its model picks with your agents'

Settings → Delegation → **Record the Decisions provider's model pick** (off by default) asks the provider, after each managed delegation starts, which of the role's models it would have picked, and keeps the answer beside the model the agent chose. It never changes which model runs, and a failing provider never slows a delegation. It sends the task's text to the provider and keeps only ids, model names and the answer. `t3 delegation shadow` reports how often the two agree, whether the provider leans cheaper or dearer, and how each group's tasks went.
