import type { WakeKind } from "./types.ts";

export const PROJECT_QUESTION =
  'This chat was started in "No project". Which of the listed projects does it belong in? Each project is described by its name, folder and recent chats. ' +
  "Answer `none` if the chat is general (a question, discussion or scratch work not about one of the projects), and `unknown` if the conversation does not support a choice. " +
  "Judge only from the conversation text.";

export const WAKE_QUESTION =
  "A wake is an automatic message that arrives in an agent's thread and starts a new agent turn. Does this wake bring anything new? " +
  "Answer `nothing_new` when reading it would not change what the agent should do next, because it only repeats, confirms or acknowledges what the recent messages already establish, or is a routine nudge to carry on. " +
  "Answer `something_new` when it reports an outcome, result, failure, change or request the thread has not yet seen and the agent could act on. " +
  "Answer `unknown` if you cannot tell. Judge only from the text shown.";

export const WAKE_CHOICES = [
  {
    label: "nothing_new",
    description: "The wake adds nothing the agent needs; it repeats, confirms or only nudges.",
  },
  {
    label: "something_new",
    description: "The wake reports a new outcome, result, failure, change or request.",
  },
  { label: "unknown", description: "The text does not support a confident choice." },
] as const;

/**
 * Whether T3-565 or T3-567 removes the wake, as those Specs are written on 10 Nov 2026 (both `ready`, neither landed).
 * "kept" means the wake still happens afterwards, so a catcher would still have work to do.
 */
export const SPEC_MARKS: Readonly<
  Record<WakeKind, { readonly verdict: "kept" | "partly-removed"; readonly why: string }>
> = {
  delegated: {
    verdict: "kept",
    why: "T3-565 adds wakes (a child that ended without reporting still wakes its parent) and removes none; a finished child's result is still delivered.",
  },
  command: {
    verdict: "kept",
    why: "T3-565 adds a wake for a command whose process or session is gone; a command that ends still wakes its thread.",
  },
  watch: {
    verdict: "partly-removed",
    why: "T3-567 lets a slow watch park, so the thread leaves Working, but the wake on the event is kept; T3-565 makes a landing always wake its thread and stops a watch on a Forge item waiting only on Henry from counting as a machine wait.",
  },
  timed: {
    verdict: "partly-removed",
    why: "T3-567 turns a one-off check-back bound to its thread into a time-parked wait and has agents park on the event when T3 can see it, so a check-back that fires although T3 could see the event goes; repeating, webhook and fresh-session routines stay.",
  },
  system: {
    verdict: "kept",
    why: "Neither Spec touches the unattended nudge or the context-rollover notices; they are not wakes an agent asked for.",
  },
};
