# Secrets

T3 Code can read credentials from a secret provider, so the credential stays in your password
manager and T3 Code saves only a reference to it. Agents can also ask you for a secret in a
private card instead of in the chat.

Saved and temporary secret management is available in T3 Peach. Older clients retain temporary
secret requests; use an updated client to answer a Bitwarden save request.

## Secret providers

1Password is the supported provider. T3 Code reads secrets with the
[1Password CLI](https://developer.1password.com/docs/cli/) (`op`), so `op` must be installed and
signed in on the machine that runs the T3 Code server. When you use T3 Code on another machine or
from your phone, that is the remote machine, not the device in front of you.

A desktop sign-in asks for approval on that machine, which a remote user cannot answer. On a remote
or headless server, sign `op` in with a [service account](./secrets-1password-service-account.md) or a
[Connect server](./secrets-1password-connect.md) instead.

To add one, open **Settings → Secrets**, select **Providers → Add provider**, and enter a name and the
1Password account: the shorthand, sign-in address (without `https://`), or ID that
`op account list` shows. Secret providers belong to the environment you are connected to. Each
environment keeps its own list.

## Use a secret reference

Credential fields in Settings, such as provider environment variables and credentials, source
control tokens, usage limit keys, and device host tokens, show a source picker next to the field.
Pick **Value** to save the credential itself, or pick a secret provider and enter a reference such
as `op://vault/item/field`. Copy the reference from 1Password with **Copy Secret Reference**.

T3 Code reads the secret when it needs it, for example when a provider starts. Change the
credential in 1Password and refresh to use the new value.

## When a secret cannot be read

If 1Password is locked or signed out, the provider or feature that needs the secret shows an error
naming the secret provider. Unlock 1Password on the server's machine, then select **Refresh** in
**Settings → Providers**. T3 Code never replaces a saved credential it cannot read with another
login.

## Remove a secret provider

When you remove a secret provider in **Settings → Secrets → Providers**, T3 Code lists the fields that read
from it. Removing it clears those fields, so set them again before you need them. The secrets in
1Password are not touched.

## Saved and temporary secrets

Open **Settings → Secrets** and select the environment that owns the credentials. **Saved
in Bitwarden** lets you search, add, reveal, copy, replace, rename and delete keys in that
server's configured Bitwarden project. The server uses the uniquely named `localdev` project
from `bws project list` by default. Install and configure the `bws` CLI on that server, or set
`T3CODE_BWS_PROJECT_ID` to select an explicit project UUID. The server pins that project when
it first connects; restart the server to select a different default. An open card or Settings
editor refuses a save if its displayed project no longer matches. SDK authentication uses
`BWS_ACCESS_TOKEN`, the `bws-access-token` macOS Keychain entry, or the owner-only
`~/.config/bws/access-token` file on Linux. Values stay masked until you choose Reveal or Copy.
Renaming can break consumers that look up a key by name. Replacing or deleting a saved value
does not rotate or revoke the credential at its issuing service, or restart apps using it.

**Temporary** shows active one-use references and private files, with their expiry. You can
remove a handoff early. Removal does not erase copies a command has already received.
**Providers** retains external provider configuration, such as 1Password.

## When an agent asks for a secret

An agent first checks for an existing connection or saved key. When it needs your input,
it shows a secure card instead of asking you to paste the value into chat. The card states
where the value will live before you enter it:

- **Save to Bitwarden** saves a reusable credential until you delete it, naming its key and project.
- **Use temporarily** keeps the value on this T3 environment without saving to Bitwarden. A
  tool reference is consumed once or expires after 24 hours; a private file for commands is
  deleted after 24 hours or earlier removal.

Choose **Decline** to continue without the secret. You can answer from web, desktop or an
updated mobile client. An older client cannot save an ambiguous answer to Bitwarden; use
an updated client for that request.

Temporary cards may also accept a configured provider reference, such as 1Password. T3
reads that reference when you answer. If the provider is locked, unlock it on the server's
machine and retry. Values are kept out of the conversation; a file-delivery card explains
that the agent's commands can read the private file.

Agent deletion also requires a run started by a connection with settings-write access, as well
as full-access/default mode. Earlier runs and automated runs without that recorded authority
cannot delete saved entries; use Settings or start a new authorised run.
