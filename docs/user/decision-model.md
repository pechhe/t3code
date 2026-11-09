# Decision model

Agents, Champions and browser checks ask bounded questions ("is there a workaround?", "which area is this?") and one model answers them. Settings → Decisions chooses which one.

## Choose the provider

Open Settings → Decisions. Pick **Jev (TypeSafe)**, the default, **OpenAI** or **OpenRouter**, then enter that provider's API key. For OpenRouter you can also change the model; the default follows the latest Jev. The "Applying settings across" picker at the top works as on other pages: leave it on All environments to change every environment at once.

A key can be pasted or read from a secret provider such as 1Password. Once saved it is never shown again; only its last four characters appear. If a key comes from the server's own environment or secrets instead, the page says so.

## Test it

**Test** sends one tiny question to each environment in scope and reports whether it worked, how long it took and what it cost. It spends a fraction of a cent.

## When it fails

A failing provider fails the decision and says which provider and why: key rejected, out of credits, rate limited, timed out or unreachable. Nothing switches to another provider or retries. When Jev credits run out, switch to OpenRouter here and enter its key.
