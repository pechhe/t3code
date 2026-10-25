import { useNavigate } from "@tanstack/react-router";
import { lazy, memo, Suspense, useMemo, type ComponentType } from "react";

import { useEnvironments } from "~/state/environments";
import { WorkspacePageContainer } from "../WorkspacePageContainer";
import { Button } from "../ui/button";
import { SettingsSearchResultsProvider } from "./settingsLayout";
import { SettingsScopeProvider, useSettingsScope } from "./SettingsScopeContext";
import {
  SETTINGS_DEVICE_ONLY_PATHS,
  SettingsScopeSentence,
  settingsPageUnavailableMessage,
} from "./SettingsScopeSentence";
import {
  getSettingsSearchTargetScope,
  getThreadAutoSettlementSearchAvailability,
  isSettingsSearchScopeAvailable,
  searchSettings,
  SETTINGS_SECTION_LABELS,
  type SettingsPath,
} from "./settingsSearch";
import { useSettingsSearchQuery } from "./settingsSearchStore";
import { useAvailableSettingsSearchItems } from "./useAvailableSettingsSearchItems";
import { useProgressiveMount } from "./useProgressiveMount";

// Lazy so the settings layout keeps each page in its own route chunk.
const SETTINGS_PAGE_PANELS: Readonly<Record<SettingsPath, ComponentType>> = {
  "/settings/projects": lazy(() =>
    import("./ProjectsSettings").then((module) => ({ default: module.ProjectsSettings })),
  ),
  "/settings/general": lazy(() =>
    import("./SettingsPanels").then((module) => ({ default: module.GeneralSettingsPanel })),
  ),
  "/settings/diagnostics": lazy(() =>
    import("./DiagnosticsSettings").then((module) => ({
      default: module.DiagnosticsSettingsPanel,
    })),
  ),
  "/settings/appearance": lazy(() =>
    import("./AppearanceSettingsPanel").then((module) => ({
      default: module.AppearanceSettingsPanel,
    })),
  ),
  "/settings/keybindings": lazy(() =>
    import("./KeybindingsSettings").then((module) => ({
      default: module.KeybindingsSettingsPanel,
    })),
  ),
  "/settings/snap-shot": lazy(() =>
    import("./SnapShotSettings").then((module) => ({ default: module.SnapShotSettings })),
  ),
  "/settings/providers": lazy(() =>
    import("./ProviderSettingsPanel").then((module) => ({
      default: function ProvidersSearchPanel() {
        // Providers show one environment at a time, like their own page.
        const { search, selectScope } = useSettingsScope();
        return (
          <SettingsScopeProvider search={search} onChange={selectScope} singleEnvironment>
            <module.ScopedProviderSettingsPanel />
          </SettingsScopeProvider>
        );
      },
    })),
  ),
  "/settings/beta": lazy(() =>
    import("./BetaSettingsPanel").then((module) => ({ default: module.BetaSettingsPanel })),
  ),
  "/settings/delegation": lazy(() =>
    import("./DelegationSettings").then((module) => ({ default: module.DelegationSettings })),
  ),
  "/settings/integrations": lazy(() =>
    import("./IntegrationsSettings").then((module) => ({
      default: module.IntegrationsSettingsPanel,
    })),
  ),
  "/settings/experiments": lazy(() =>
    import("./ExperimentsSettings").then((module) => ({ default: module.ExperimentsSettings })),
  ),
  "/settings/source-control": lazy(() =>
    import("./SourceControlSettings").then((module) => ({
      default: module.SourceControlSettingsPanel,
    })),
  ),
  "/settings/storage": lazy(() =>
    import("./StorageSettings").then((module) => ({ default: module.StorageSettingsPanel })),
  ),
  "/settings/connections": lazy(() =>
    import("./ConnectionsSettings").then((module) => ({ default: module.ConnectionsSettings })),
  ),
  "/settings/archived": lazy(() =>
    import("./ArchivedThreadsPanel").then((module) => ({ default: module.ArchivedThreadsPanel })),
  ),
};

/**
 * Hides everything in the stacked pages except the matched anchors, what
 * contains them, and what they contain. Filter containers (the stack, each
 * page, each settings group) drop children without a match; sections and rows
 * drop out wherever they sit. Pure CSS, so rows that mount late still match.
 */
function filterStylesheet(anchorIds: readonly string[]): string {
  const matches = anchorIds.map((id) => `#${CSS.escape(id)}`).join(",");
  const candidates = 'section, [data-slot="settings-row"], [data-settings-search-filter] > *';
  return `
[data-settings-search-results] :is(${candidates}):not(:is(${matches}), :has(:is(${matches})), :is(${matches}) *) { display: none; }
[data-settings-search-results]:has(:is(${matches})) [data-settings-search-empty] { display: none; }`;
}

/**
 * Every setting that matches the sidebar query, shown in place of the current
 * page with its real controls, grouped under the page it lives on. Matches the
 * selected scope cannot show stay in the sidebar list, which explains them.
 */
export const SettingsSearchResults = memo(function SettingsSearchResults({
  query,
}: {
  query: string;
}) {
  const navigate = useNavigate();
  const setQuery = useSettingsSearchQuery((state) => state.setQuery);
  const { scope, search, connectedEnvironments } = useSettingsScope();
  const { environments } = useEnvironments();
  const searchableItems = useAvailableSettingsSearchItems(search);

  const { matchCount, pages, anchorIds } = useMemo(() => {
    const autoSettlementAvailable = getThreadAutoSettlementSearchAvailability(
      environments,
      scope,
    ).isTargetAvailable;
    const matches = searchSettings(query, searchableItems);
    const visible = matches.filter(
      (item) =>
        settingsPageUnavailableMessage(item.to, scope, connectedEnvironments.length) === null &&
        (!item.requiresThreadAutoSettlement || autoSettlementAvailable) &&
        isSettingsSearchScopeAvailable(
          getSettingsSearchTargetScope(item.id)?.scope ?? null,
          scope.kind,
        ),
    );
    // Pages follow their best-ranked match.
    return {
      matchCount: matches.length,
      pages: [...new Set(visible.map((item) => item.to))],
      anchorIds: [...new Set(visible.map((item) => item.targetId ?? item.id))],
    };
  }, [connectedEnvironments.length, environments, query, scope, searchableItems]);

  const mountedPages = useProgressiveMount(pages);
  const scopedPage = pages.find((page) => !SETTINGS_DEVICE_ONLY_PATHS.has(page));

  return (
    <div
      data-settings-search-results=""
      data-settings-page-scroll
      className="topbar-scroll-fade scrollbar-gutter-both flex-1 overflow-y-auto"
    >
      {anchorIds.length > 0 ? <style>{filterStylesheet(anchorIds)}</style> : null}
      <WorkspacePageContainer className="gap-8">
        {scopedPage ? <SettingsScopeSentence pathname={scopedPage} /> : null}
        <SettingsSearchResultsProvider value>
          <div data-settings-search-filter="" className="flex flex-col gap-10">
            {mountedPages.map((page) => {
              const Panel = SETTINGS_PAGE_PANELS[page];
              return (
                <div key={page} className="flex flex-col gap-4">
                  <div className="flex items-center justify-between gap-4 px-3 sm:px-4">
                    <h2 className="text-base font-medium text-foreground">
                      {SETTINGS_SECTION_LABELS[page]}
                    </h2>
                    <Button
                      size="xs"
                      variant="ghost"
                      onClick={() => {
                        setQuery("");
                        void navigate({ to: page, hash: "" });
                      }}
                    >
                      Open page
                    </Button>
                  </div>
                  {/* One boundary per page: a page still loading must not hide
                      the ones already shown, which remounts their effects. */}
                  <Suspense fallback={null}>
                    <Panel />
                  </Suspense>
                </div>
              );
            })}
          </div>
        </SettingsSearchResultsProvider>
        {mountedPages.length === pages.length ? (
          <p
            data-settings-search-empty=""
            role="status"
            className="py-12 text-center text-sm text-muted-foreground"
          >
            No settings match “{query.trim()}”{matchCount > 0 ? " for the selected target" : ""}.
          </p>
        ) : null}
      </WorkspacePageContainer>
    </div>
  );
});
