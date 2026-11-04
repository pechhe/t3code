import { createFileRoute, redirect } from "@tanstack/react-router";

import { ChampionsPage } from "../components/champions/ChampionsPage";
import { validateChampionsSearch } from "../components/champions/champions.logic";
import { SidebarInset } from "../components/ui/sidebar";

function ChampionsRoute() {
  const search = Route.useSearch();
  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden overscroll-y-none isolate">
      <ChampionsPage environmentId={search.environmentId} id={search.id} view={search.view} />
    </SidebarInset>
  );
}

export const Route = createFileRoute("/champions")({
  validateSearch: (raw: Record<string, unknown>) => validateChampionsSearch(raw),
  beforeLoad: async ({ context }) => {
    if (
      context.authGateState.status !== "authenticated" &&
      context.authGateState.status !== "hosted-static"
    ) {
      throw redirect({ to: "/pair", replace: true });
    }
  },
  component: ChampionsRoute,
});
