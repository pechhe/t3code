import { createFileRoute } from "@tanstack/react-router";
import { AccountsSettings } from "../components/settings/AccountsSettings";

export const Route = createFileRoute("/_chat/settings/accounts")({
  component: AccountsSettings,
});
