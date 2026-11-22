import { msg } from "gt-react";

import type { SettingsSearchItem } from "./settingsSearch";

export const DELEGATION_SETTINGS_SEARCH_ITEMS = [
  {
    id: "delegation",
    title: msg("Delegation"),
    to: "/settings/delegation",
    searchTerms: ["agent models notes roles jobs subagents reviewer advisor effort order policy"],
  },
  {
    id: "delegation-child-permissions",
    title: msg("Helper permissions"),
    to: "/settings/delegation",
    scope: "environment",
    environmentOnly: true,
    searchTerms: ["delegated child runtime mode subagent permissions"],
  },
  {
    id: "delegation-trusted-claude-writers",
    title: msg("Let Claude helpers write with full access"),
    to: "/settings/delegation",
    scope: "environment",
    environmentOnly: true,
    searchTerms: ["trusted claude writers delegated subagent host access"],
  },
  {
    id: "delegation-advisor-idle-close",
    title: msg("Close idle advisors"),
    to: "/settings/delegation",
    scope: "environment",
    environmentOnly: true,
    searchTerms: ["advisor timeout idle close subagent"],
  },
  {
    id: "delegation-model-shadow",
    title: msg("Record the Decisions provider's model pick"),
    to: "/settings/delegation",
    scope: "environment",
    environmentOnly: true,
    searchTerms: ["shadow decision model pick delegation jev measurement"],
  },
] as const satisfies ReadonlyArray<SettingsSearchItem>;

export const APPEARANCE_FEEL_SETTINGS_SEARCH_ITEMS = [
  {
    id: "interface-sounds",
    title: msg("Interface sounds"),
    to: "/settings/appearance",
    searchTerms: [msg("click tick audio sound effects hover composer sidebar mute")],
  },
  {
    id: "send-sound",
    title: msg("Send sound"),
    to: "/settings/appearance",
    searchTerms: ["sound audio send message air release pneumatic tube bell click dial"],
  },
  {
    id: "queue-sound",
    title: msg("Queue sound"),
    to: "/settings/appearance",
    searchTerms: ["sound audio queue queued message latch drop slot click dial"],
  },
  {
    id: "settle-sound",
    title: msg("Settle sound"),
    to: "/settings/appearance",
    searchTerms: [
      "sound audio settle settled done thread seat tick press pair soft detent whoosh metal stamp filed switch tap",
    ],
  },
  {
    id: "send-motion",
    title: msg("Send motion"),
    to: "/settings/appearance",
    searchTerms: ["animation send message slide lift vacuum fly transition motion"],
  },
  {
    id: "composer-finish",
    title: msg("Composer finish"),
    to: "/settings/appearance",
    searchTerms: ["composer metal chassis silver anodized black screen colour color skin peach"],
  },
] as const satisfies ReadonlyArray<SettingsSearchItem>;

export const SNAP_SHOT_OVERLAY_SETTINGS_SEARCH_ITEMS = [
  {
    id: "snap-shot-overlay-shortcut",
    title: msg("Show or hide shortcut"),
    to: "/settings/snap-shot",
    targetId: "snap-shot-enabled",
    searchTerms: ["snapshot overlay conversation hide show"],
  },
] as const satisfies ReadonlyArray<SettingsSearchItem>;

export const AGENT_BROWSER_BACKEND_SETTINGS_SEARCH_ITEMS = [
  {
    id: "agent-browser-backends",
    title: msg("Agent browser"),
    to: "/settings/browser",
    scope: "project-defaults",
    searchTerms: ["phi t3 integrated backend default preview tools project override"],
  },
] as const satisfies ReadonlyArray<SettingsSearchItem>;

export const VERSION_CONTROL_SETTINGS_SEARCH_ITEMS = [
  {
    id: "version-control-preference",
    title: msg("Version control"),
    to: "/settings/source-control",
    scope: "project-defaults",
    searchTerms: ["git slipjay jujutsu jj project repository convert banner"],
  },
] as const satisfies ReadonlyArray<SettingsSearchItem>;
