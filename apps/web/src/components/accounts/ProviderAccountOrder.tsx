import type { EnvironmentId, ProviderInstanceId } from "@t3tools/contracts";
import { listAccounts } from "@t3tools/shared/accountPools";
import { Link } from "@tanstack/react-router";

import { Button } from "../ui/button";
import { SettingsRow } from "../settings/settingsLayout";
import { useInstanceEntries } from "../settings/useInstanceEntries";
import { accountPositionsText } from "./ProviderAccountOrder.logic";

/** On a provider's settings: where its accounts sit in Settings → Accounts, with a link there. */
export function ProviderAccountOrderRow(props: {
  environmentId: EnvironmentId | undefined;
  instanceId: ProviderInstanceId;
}) {
  if (props.environmentId === undefined) return null;
  return <AccountOrderRow environmentId={props.environmentId} instanceId={props.instanceId} />;
}

function AccountOrderRow(props: { environmentId: EnvironmentId; instanceId: ProviderInstanceId }) {
  const { settings, providers } = useInstanceEntries(props.environmentId);
  const accounts = listAccounts(providers, settings.accountOrder);
  const positions = accounts.flatMap((account, index) =>
    account.instanceId === props.instanceId ? [index + 1] : [],
  );
  if (positions.length === 0) return null;
  const where = accountPositionsText(positions);
  return (
    <SettingsRow
      title="Account order"
      status={
        positions.length === 1
          ? `Tried ${where} of ${accounts.length} accounts`
          : `Its ${positions.length} accounts are tried ${where} of ${accounts.length}`
      }
      control={
        <Button size="xs" variant="outline" render={<Link to="/settings/accounts" />}>
          Open Accounts
        </Button>
      }
    />
  );
}
