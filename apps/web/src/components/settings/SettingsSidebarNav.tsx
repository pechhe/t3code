import {
  lazy,
  Suspense,
  useDeferredValue,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ComponentType,
  type KeyboardEvent,
} from "react";
import {
  ArchiveIcon,
  BlocksIcon,
  BotIcon,
  createLucideIcon,
  CalendarClockIcon,
  GitBranchIcon,
  HardDriveIcon,
  PanelsTopLeftIcon,
  KeyboardIcon,
  Link2Icon,
  PaletteIcon,
  SearchIcon,
  Settings2Icon,
  XIcon,
} from "lucide-react";
import { useLocation, useNavigate } from "@tanstack/react-router";

import { Button } from "../ui/button";
import { Kbd } from "../ui/kbd";
import {
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  useSidebar,
  SidebarInput,
} from "../ui/sidebar";
import { SidebarUtilityMenu } from "../sidebar/SidebarChrome";
import { readMainAppProjectRef } from "../sidebar/mainAppLocation";
import { scrollToSettingsTarget } from "./settingsLayout";
import {
  searchSettings,
  SETTINGS_SECTION_LABELS,
  type SettingsPath,
  type SettingsSearchItem,
} from "./settingsSearch";
import { useSettingsSearchQuery } from "./settingsSearchStore";
import { useAvailableSettingsSearchItems } from "./useAvailableSettingsSearchItems";
import { validateSettingsScopeSearch, type SettingsScopeSearch } from "./settingsScope";
import { defaultSettingsProjectKey } from "./settingsScopeNavigation";
import { useSettingsProjectGroups } from "./useSettingsProjectGroups";

const SnapShotIcon = createLucideIcon("snap-shot", [
  [
    "path",
    {
      d: "M8 3H6a3 3 0 0 0-3 3v2M16 3h2a3 3 0 0 1 3 3v2M21 16v2a3 3 0 0 1-3 3h-2M8 21H6a3 3 0 0 1-3-3v-2",
      key: "capture-frame",
    },
  ],
  ["rect", { width: "10", height: "8", x: "7", y: "8", rx: "2", key: "window" }],
  ["circle", { cx: "12", cy: "12", r: "1.5", key: "lens" }],
]);

const T3ConnectSidebarSignIn = lazy(() =>
  import("../clerk/T3ConnectSidebarSignIn").then((module) => ({
    default: module.T3ConnectSidebarSignIn,
  })),
);
const T3ConnectSidebarAvatar = lazy(() =>
  import("../clerk/T3ConnectSidebarSignIn").then((module) => ({
    default: module.T3ConnectSidebarAvatar,
  })),
);

const SETTINGS_SECTION_ICONS: Readonly<
  Record<SettingsPath, ComponentType<{ className?: string }>>
> = {
  "/settings/general": Settings2Icon,
  "/settings/diagnostics": Settings2Icon,
  "/settings/appearance": PaletteIcon,
  "/settings/projects": PanelsTopLeftIcon,
  "/settings/keybindings": KeyboardIcon,
  "/settings/snap-shot": SnapShotIcon,
  "/settings/providers": BotIcon,
  "/settings/integrations": BlocksIcon,
  "/settings/experiments": BlocksIcon,
  "/settings/delegation": BotIcon,
  "/settings/source-control": GitBranchIcon,
  "/settings/storage": HardDriveIcon,
  "/settings/connections": Link2Icon,
  "/settings/archived": ArchiveIcon,
};

const SETTINGS_NAV_ITEMS: ReadonlyArray<{
  label: string;
  to: SettingsPath;
  icon: ComponentType<{ className?: string }>;
}> = (Object.keys(SETTINGS_SECTION_LABELS) as SettingsPath[])
  .filter((to) => to !== "/settings/diagnostics")
  .map((to) => ({
    to,
    label: SETTINGS_SECTION_LABELS[to],
    icon: SETTINGS_SECTION_ICONS[to],
  }));

function SettingsSectionIcon({ to }: { to: SettingsPath }) {
  const Icon = SETTINGS_SECTION_ICONS[to];
  return <Icon className="mt-0.5 size-3.5 shrink-0 text-sidebar-muted-foreground/60" />;
}

export function SettingsSidebarNav({ pathname }: { pathname: string }) {
  const navigate = useNavigate();
  const currentHash = useLocation({ select: (location) => location.hash });
  const currentSearch = useLocation({ select: (location) => location.search });
  const scopeSearch = useMemo(() => validateSettingsScopeSearch(currentSearch), [currentSearch]);
  const projectGroups = useSettingsProjectGroups();
  // The Projects page needs a project; arriving without one picks a default
  // across all environments, since a picked environment may hold no checkout of it.
  const searchFor = (to: SettingsPath): SettingsScopeSearch | undefined => {
    if (to !== "/settings/projects" || scopeSearch.project) return undefined;
    const project = defaultSettingsProjectKey(projectGroups, readMainAppProjectRef());
    return project ? { project } : undefined;
  };
  const { isMobile, setOpenMobile, open, setOpen } = useSidebar();
  const searchInputRef = useRef<HTMLInputElement>(null);
  const query = useSettingsSearchQuery((state) => state.query);
  const setQuery = useSettingsSearchQuery((state) => state.setQuery);
  const [activeResultIndex, setActiveResultIndex] = useState(0);
  const searchableItems = useAvailableSettingsSearchItems(scopeSearch);
  // The list lags the box by a render, so a keystroke never waits on up to
  // hundreds of result rows.
  const listedQuery = useDeferredValue(query);
  const results = useMemo(
    () => searchSettings(listedQuery, searchableItems),
    [listedQuery, searchableItems],
  );
  const isSearching = query.trim().length > 0;
  const hasResults = results.length > 0;

  useEffect(() => {
    setActiveResultIndex((index) => Math.min(index, Math.max(results.length - 1, 0)));
  }, [results.length]);

  useEffect(() => {
    const result = results[activeResultIndex];
    if (!result) return;
    document
      .getElementById(`settings-search-result-${result.id}`)
      ?.scrollIntoView({ block: "nearest" });
  }, [activeResultIndex, results]);

  useEffect(() => {
    const handleKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.defaultPrevented || event.isComposing) return;
      const isFindShortcut =
        event.key.toLowerCase() === "f" &&
        (event.metaKey || event.ctrlKey) &&
        !event.altKey &&
        !event.shiftKey;
      const isPlainKey = !event.metaKey && !event.ctrlKey && !event.altKey;
      const isSlashShortcut = event.key === "/" && isPlainKey;
      // Any other printable key starts a search with that character, so typing
      // on a settings page searches. Space stays with the focused control.
      const isTypeToSearch = isPlainKey && event.key.length === 1 && event.key.trim() !== "";
      if (!isFindShortcut && !isSlashShortcut && !isTypeToSearch) return;
      if (event.defaultPrevented || event.isComposing) return;

      const target = event.target;
      if (
        target instanceof HTMLElement &&
        ((!isFindShortcut &&
          (target.tagName === "INPUT" ||
            target.tagName === "TEXTAREA" ||
            target.tagName === "SELECT" ||
            target.isContentEditable)) ||
          target.closest(
            '[role="dialog"], [aria-modal="true"], [data-slot$="popup"], [role="listbox"], [role="menu"], [role="combobox"], [data-keybinding-capture]',
          ) !== null)
      ) {
        return;
      }

      event.preventDefault();
      const typedKey = isFindShortcut || isSlashShortcut ? null : event.key;
      if (typedKey !== null) {
        setQuery(useSettingsSearchQuery.getState().query + typedKey);
        setActiveResultIndex(0);
      }
      if (isMobile) {
        setOpenMobile(true);
      } else if (!open) {
        setOpen(true);
      }
      requestAnimationFrame(() => {
        searchInputRef.current?.focus();
        // A typed character continues the query; the shortcuts select it for replacing.
        if (typedKey === null) searchInputRef.current?.select();
      });
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [isMobile, open, setOpen, setOpenMobile, setQuery]);

  const handleSectionClick = (to: SettingsPath) => {
    if (isMobile) {
      setOpenMobile(false);
    }
    const search = searchFor(to);
    void navigate({
      to,
      ...(search ? { search: () => search } : {}),
      hash: "",
      replace: true,
      hashScrollIntoView: false,
    });
  };
  const clearSearch = () => {
    setQuery("");
    setActiveResultIndex(0);
  };
  const handleSearchResultClick = (item: SettingsSearchItem) => {
    clearSearch();
    if (isMobile) {
      setOpenMobile(false);
    }
    const targetId = item.targetId ?? item.id;
    const search = searchFor(item.to);
    if (!search && pathname === item.to && currentHash.replace(/^#/, "") === targetId) {
      scrollToSettingsTarget(targetId);
      return;
    }
    void navigate({
      to: item.to,
      ...(search ? { search: () => search } : {}),
      hash: targetId,
      replace: true,
      hashScrollIntoView: false,
      state: { settingsTargetHighlight: true },
    });
  };
  const handleSearchKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Escape" && isSearching) {
      event.preventDefault();
      event.stopPropagation();
      clearSearch();
      return;
    }
    // Keys act on what the box says now, even while the list still shows the last query.
    const current = listedQuery === query ? results : searchSettings(query, searchableItems);
    if (current.length === 0) return;
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setActiveResultIndex((index) => (index + 1) % current.length);
      return;
    }
    if (event.key === "ArrowUp") {
      event.preventDefault();
      setActiveResultIndex((index) => (index - 1 + current.length) % current.length);
      return;
    }
    if (event.key === "Enter") {
      event.preventDefault();
      const result = current[activeResultIndex];
      if (result) handleSearchResultClick(result);
    }
  };
  return (
    <>
      <SidebarContent className="overflow-x-hidden">
        <SidebarGroup>
          <div className="flex flex-col gap-2">
            <div className="flex h-8 items-center gap-2 rounded-md px-2 py-1.5 text-sm font-medium text-sidebar-muted-foreground hover:bg-sidebar-row-hover hover:text-sidebar-foreground">
              <SearchIcon className="size-4 shrink-0 text-sidebar-muted-foreground/80" />
              <SidebarInput
                ref={searchInputRef}
                nativeInput
                type="search"
                value={query}
                onChange={(event) => {
                  setQuery(event.currentTarget.value);
                  setActiveResultIndex(0);
                }}
                onKeyDown={handleSearchKeyDown}
                placeholder="Search"
                aria-label="Search settings"
                role="combobox"
                aria-autocomplete="list"
                aria-expanded={isSearching && hasResults}
                aria-controls={isSearching && hasResults ? "settings-search-results" : undefined}
                aria-activedescendant={
                  isSearching && listedQuery === query && results[activeResultIndex]
                    ? `settings-search-result-${results[activeResultIndex].id}`
                    : undefined
                }
                className="min-w-0 flex-1"
              />
              {isSearching ? (
                <Button
                  type="button"
                  size="icon-micro"
                  variant="ghost-muted"
                  className="shrink-0"
                  aria-label="Clear settings search"
                  onClick={() => {
                    clearSearch();
                    searchInputRef.current?.focus();
                  }}
                >
                  <XIcon className="size-3" />
                </Button>
              ) : (
                <Kbd>/</Kbd>
              )}
            </div>
            {isSearching && listedQuery === query && results.length === 0 ? (
              <p
                role="status"
                className="px-2 py-6 text-center text-xs text-sidebar-muted-foreground"
              >
                No settings found
              </p>
            ) : null}
            {isSearching ? (
              <SidebarMenu
                id={hasResults ? "settings-search-results" : undefined}
                role={hasResults ? "listbox" : undefined}
                aria-label={hasResults ? "Settings search results" : undefined}
              >
                {results.map((item, index) => (
                  <SidebarMenuItem key={item.id} role="presentation">
                    <SidebarMenuButton
                      id={`settings-search-result-${item.id}`}
                      role="option"
                      aria-selected={index === activeResultIndex}
                      tabIndex={-1}
                      size="sm"
                      isActive={index === activeResultIndex}
                      className="h-auto min-h-10 items-start"
                      onMouseMove={() => setActiveResultIndex(index)}
                      onClick={() => handleSearchResultClick(item)}
                    >
                      <SettingsSectionIcon to={item.to} />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-sm font-medium text-sidebar-foreground">
                          {item.title}
                        </span>
                        <span className="block truncate text-2xs text-sidebar-muted-foreground/75">
                          {SETTINGS_SECTION_LABELS[item.to]}
                        </span>
                      </span>
                    </SidebarMenuButton>
                  </SidebarMenuItem>
                ))}
              </SidebarMenu>
            ) : (
              <SidebarMenu>
                {SETTINGS_NAV_ITEMS.map((item) => {
                  const Icon = item.icon;
                  const isGeneralDetailPage =
                    item.to === "/settings/general" &&
                    pathname === "/settings/open-source-licenses";
                  const isActive =
                    isGeneralDetailPage ||
                    pathname === item.to ||
                    pathname.startsWith(`${item.to}/`);
                  return (
                    <SidebarMenuItem key={item.to}>
                      <SidebarMenuButton
                        isActive={isActive}
                        onClick={() => handleSectionClick(item.to)}
                      >
                        <Icon />
                        <span className="truncate">{item.label}</span>
                      </SidebarMenuButton>
                    </SidebarMenuItem>
                  );
                })}
              </SidebarMenu>
            )}
          </div>
        </SidebarGroup>
      </SidebarContent>
      <SidebarFooter>
        <Suspense fallback={null}>
          <T3ConnectSidebarSignIn />
        </Suspense>
        <div className="flex items-center gap-1">
          <div className="min-w-0 flex-1">
            <SidebarUtilityMenu />
          </div>
          <Suspense fallback={null}>
            <T3ConnectSidebarAvatar />
          </Suspense>
        </div>
      </SidebarFooter>
    </>
  );
}
