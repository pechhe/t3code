import { createFileRoute } from "@tanstack/react-router";
import { ExperimentsSettings } from "../components/settings/ExperimentsSettings";

export const Route = createFileRoute("/_chat/settings/experiments")({
  component: ExperimentsSettings,
});
