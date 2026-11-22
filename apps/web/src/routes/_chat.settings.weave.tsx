import { createFileRoute } from "@tanstack/react-router";

import { WeaveSettingsPanel } from "../components/settings/WeaveConnectionSettings";

export const Route = createFileRoute("/_chat/settings/weave")({
  component: WeaveSettingsPanel,
});
