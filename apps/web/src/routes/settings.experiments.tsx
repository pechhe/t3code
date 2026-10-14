import { createFileRoute } from "@tanstack/react-router";
import { ExperimentsSettings } from "../components/settings/ExperimentsSettings";

export const Route = createFileRoute("/settings/experiments")({ component: ExperimentsSettings });
