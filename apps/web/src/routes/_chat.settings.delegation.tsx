import { createFileRoute } from "@tanstack/react-router";
import { DelegationSettings } from "../components/settings/DelegationSettings";

export const Route = createFileRoute("/_chat/settings/delegation")({
  component: DelegationSettings,
});
