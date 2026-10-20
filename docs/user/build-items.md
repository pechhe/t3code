# Build items

When T3 Code is connected to YardSmith HQ, a thread in any project can show the Build Spec or Ticket it works on.
The item's title and status sit in the thread header, between the workflow and the thread's
title. Hover it to see a card with the item's current state from Build: a Spec's Tickets and
progress, holds, what blocks a Ticket, and the thread leading or working on it. Click it to open
the item in HQ.

Without an HQ connection, threads show no Build items and Build links stay ordinary links.

## Link a thread

Choose **Link Build item** from the thread's menu or the command palette, then paste a Build URL
or the item's number, such as `#1000123`. Use the header segment's menu to **Change…** the item
or **Unlink** it. A thread links to one item, so linking again replaces the earlier one.

Agents can link their own threads, and a lead can link the threads it delegates to. T3 Code never
links a thread on its own.

On mobile, the item shows under the thread's title. Tap it to see the card.

## Build items in chat

A Build link, or `#<number>` with seven or more digits, in a message becomes a chip with the
item's title and status. Hover it, or tap it on mobile, to see the same card. Shorter numbers
such as GitHub's `#78`, numbers inside code, and numbers Build doesn't know stay as written.

## When Build can't be reached

The header keeps the last title it knew, and the card says Build couldn't be reached and when it
was last updated. Cards check for changes while they are on screen, backing off to
five minutes when unchanged. Changes made by a thread's agent appear within a minute.
Hidden browser and desktop windows pause these checks until visible again.
