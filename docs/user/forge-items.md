# Forge items

When T3 Code is connected to Weave, a thread in any project can show the Forge Spec or Ticket it works on.
The item's title and status sit in the thread header, between the workflow and the thread's
title. Hover it to see a card with the item's current state from Forge: a Spec's Tickets and
progress, holds, what blocks a Ticket, and the thread leading or working on it. Click it to open
the item in Weave.

Without a Weave connection, threads show no Forge items and Forge links stay ordinary links.

## Connect to Weave

Open **Settings → Integrations → Weave** and choose **Connect to Weave**. T3 opens Weave in your
browser; sign in and approve the consent page, and Weave returns you to T3, which is then connected.
Each environment connects separately: the one whose Settings you used receives the connection.
Cancelling leaves any existing connection as it was. **Disconnect** stops new Weave calls from this
environment; to revoke T3's access in Weave, revoke it there.

Weave sends your browser back to the address you use to reach that environment, so that address must be
`https`, or `http` on this computer. An environment reached over plain `http` on a network address
cannot connect this way; open it through its `https` address.

## Link a thread

Choose **Link Forge item** from the thread's menu or the command palette, then paste a Forge URL
or the item's number, such as `#1000123`. Use the header segment's menu to **Change…** the item
or **Unlink** it. A thread links to one item, so linking again replaces the earlier one.

Agents can link their own threads, and a lead can link the threads it delegates to. T3 Code never
links a thread on its own.

On mobile, the item shows under the thread's title. Tap it to see the card.

## Forge items in chat

A Forge link, or `#<number>` with seven or more digits, in a message becomes a chip with the
item's title and status. Hover it, or tap it on mobile, to see the same card. Shorter numbers
such as GitHub's `#78`, numbers inside code, and numbers Forge doesn't know stay as written.

## When Forge can't be reached

The header keeps the last title it knew, and the card says Forge couldn't be reached and when it
was last updated. Cards check for changes while they are on screen, backing off to
five minutes when unchanged. Changes made by a thread's agent appear within a minute.
Hidden browser and desktop windows pause these checks until visible again.
