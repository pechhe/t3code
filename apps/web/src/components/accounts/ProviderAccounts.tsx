import type { EnvironmentId, ProviderInstanceId } from "@t3tools/contracts";
import { listedPooledModels } from "@t3tools/shared/accountPools";
import { Link } from "@tanstack/react-router";

import { Button } from "../ui/button";
import { SettingsRow } from "../settings/settingsLayout";
import { useInstanceEntries } from "../settings/useInstanceEntries";

/** On a provider's settings: which pooled models run on its accounts, with a link to Accounts. */
export function ProviderAccountsRow(props: {
  environmentId: EnvironmentId | undefined;
  instanceId: ProviderInstanceId;
}) {
  if (props.environmentId === undefined) return null;
  return <PooledModelsRow environmentId={props.environmentId} instanceId={props.instanceId} />;
}

function PooledModelsRow(props: { environmentId: EnvironmentId; instanceId: ProviderInstanceId }) {
  const { settings, providers } = useInstanceEntries(props.environmentId);
  const models = listedPooledModels(providers, settings);
  const serving = models.filter((model) =>
    model.accounts.some((entry) => entry.account.instanceId === props.instanceId),
  );
  if (serving.length === 0) return null;
  const using = serving.filter((model) =>
    model.accounts.some(
      (entry) => entry.tier !== "off" && entry.account.instanceId === props.instanceId,
    ),
  );
  return (
    <SettingsRow
      title="Pooled models"
      status={`Used for ${using.length} of the ${serving.length} pooled models it serves`}
      control={
        <Button size="xs" variant="outline" render={<Link to="/settings/accounts" />}>
          Open Accounts
        </Button>
      }
    />
  );
}
