import { createFileRoute } from "@tanstack/react-router";
import { DecisionsSettings } from "../components/settings/DecisionsSettings";

export const Route = createFileRoute("/_chat/settings/decisions")({
  component: DecisionsSettings,
});
