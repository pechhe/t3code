import { useNavigation } from "@react-navigation/native";
import { isListedThreadLineage } from "@t3tools/contracts";
import * as Haptics from "expo-haptics";
import { useRef, useState } from "react";
import { FlatList, Platform, type TextInputInstance, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AppText as Text } from "../../components/ui/AppText";
import { SearchField } from "../../components/ui/SearchField";
import { SelectionRow } from "../../components/ui/SelectionRow";
import { Toolbar } from "../../components/ui/Toolbar";
import { NativeStackScreenOptions } from "../../native/StackHeader";
import { useNativeMailSearchToolbar } from "../../native/use-native-mail-search-toolbar";
import { useProjects, useVisibleThreadShells } from "../../state/entities";
import { useDebouncedValue, usePaginatedBranches, useThreadSearch } from "../../state/queries";
import {
  createNativeMailSearchToolbarItem,
  NATIVE_MAIL_SEARCH_TOOLBAR_CONTENT_INSET,
} from "../layout/native-mail-search-toolbar";
import { BranchPickerScreen } from "../threads/NewTaskContextPickerScreens";
import { SettingsScreen } from "./components/SettingsScreen";
import {
  NEW_THREAD_DESTINATION_LABEL,
  useScheduledTaskDestinationLabel,
  useScheduledTaskEditor,
} from "./scheduled-task-editor";
import { moveDraftToThread, unbindDraftFromThread } from "./scheduledTaskDraft";

function MissingTaskDraft() {
  return (
    <SettingsScreen title="Scheduled task">
      <Text className="p-5 text-base text-foreground-muted">Open a scheduled task form first.</Text>
    </SettingsScreen>
  );
}

export function ScheduledTaskBranchPickerRouteScreen() {
  const navigation = useNavigation();
  const { editor, setEditor } = useScheduledTaskEditor();
  const projects = useProjects();
  const project =
    projects.find(
      (entry) =>
        entry.environmentId === editor?.environmentId && entry.id === editor.draft.projectId,
    ) ?? null;
  const [query, setQuery] = useState("");
  const debouncedQuery = useDebouncedValue(query, 150);
  const branches = usePaginatedBranches({
    environmentId: editor?.environmentId ?? null,
    cwd: project?.workspaceRoot ?? null,
    query: debouncedQuery,
  });
  const visibleBranches = branches.refs.filter(
    (branch) => !branch.isRemote && branch.name.toLowerCase().includes(query.trim().toLowerCase()),
  );

  if (!editor) return <MissingTaskDraft />;

  return (
    <BranchPickerScreen
      title="Base branch"
      project={project}
      branches={visibleBranches}
      selectedBranchName={editor.draft.baseRef}
      query={query}
      onQueryChange={setQuery}
      loading={
        query.trim() !== debouncedQuery.trim() || (branches.isPending && branches.data === null)
      }
      error={project ? branches.error : "This project is no longer available."}
      refreshing={branches.isFetchingNextPage}
      hasMore={branches.data?.nextCursor != null}
      onRefresh={branches.refresh}
      onLoadMore={branches.loadNext}
      onSelect={(branch) => {
        void Haptics.selectionAsync();
        setEditor((current) =>
          current ? { ...current, draft: { ...current.draft, baseRef: branch.name } } : current,
        );
        navigation.goBack();
      }}
      worktree={{
        startFromOrigin: editor.draft.startFromOrigin,
        onChangeStartFromOrigin: (startFromOrigin) =>
          setEditor((current) =>
            current
              ? {
                  ...current,
                  draft: { ...current.draft, startFromOrigin },
                }
              : current,
          ),
      }}
    />
  );
}

const THREAD_SEARCH_PLACEHOLDER = "Search threads, including older ones";

export function ScheduledTaskThreadPickerRouteScreen() {
  const navigation = useNavigation();
  const insets = useSafeAreaInsets();
  const usesNativeMailSearchToolbar = useNativeMailSearchToolbar();
  const searchRef = useRef<TextInputInstance>(null);
  const { editor, setEditor } = useScheduledTaskEditor();
  const environmentId = editor?.environmentId ?? null;
  const projectId = editor?.draft.projectId ?? null;
  const threadId = editor?.draft.threadId ?? null;
  const currentLabel = useScheduledTaskDestinationLabel(environmentId, threadId);
  const shells = useVisibleThreadShells();
  const [query, setQuery] = useState("");
  // Mounts older settled threads matching the query, which shells may leave out.
  useThreadSearch(
    environmentId !== null && projectId !== null ? [environmentId] : [],
    query,
    projectId === null ? { titlesOnly: true } : { titlesOnly: true, projectIds: [projectId] },
  );

  if (!editor) return <MissingTaskDraft />;

  const search = query.trim().toLocaleLowerCase();
  const rows = [
    ...(search ? [] : [{ key: "new-thread", title: NEW_THREAD_DESTINATION_LABEL, thread: null }]),
    ...(threadId !== null && currentLabel.toLocaleLowerCase().includes(search)
      ? [{ key: threadId, title: currentLabel, thread: null }]
      : []),
    ...shells
      .filter(
        (thread) =>
          thread.environmentId === environmentId &&
          thread.projectId === projectId &&
          thread.id !== threadId &&
          thread.archivedAt === null &&
          isListedThreadLineage(thread.lineage) &&
          thread.title.toLocaleLowerCase().includes(search),
      )
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
      .map((thread) => ({
        key: thread.id,
        title: thread.title.trim() || "Untitled thread",
        thread,
      })),
  ];
  const selectedKey = threadId ?? (editor.draft.threadMode === "new_thread" ? "new-thread" : null);

  return (
    <SettingsScreen title="Destination">
      {Platform.OS === "ios" ? (
        <NativeStackScreenOptions
          options={{
            unstable_headerToolbarItems: usesNativeMailSearchToolbar
              ? () => [
                  createNativeMailSearchToolbarItem({
                    onSearchTextChange: setQuery,
                    placeholder: THREAD_SEARCH_PLACEHOLDER,
                    searchTextChangeId: "scheduled-task-thread-search-text",
                    showsSearchDismissButton: true,
                  }),
                ]
              : undefined,
            headerSearchBarOptions: usesNativeMailSearchToolbar
              ? undefined
              : {
                  allowToolbarIntegration: true,
                  autoCapitalize: "none",
                  hideNavigationBar: false,
                  hideWhenScrolling: false,
                  obscureBackground: false,
                  onCancelButtonPress: () => setQuery(""),
                  onChangeText: (event) => setQuery(event.nativeEvent.text),
                  placeholder: THREAD_SEARCH_PLACEHOLDER,
                },
          }}
        />
      ) : null}
      {Platform.OS === "ios" && !usesNativeMailSearchToolbar ? (
        <Toolbar placement="bottom">
          <Toolbar.SearchBarSlot />
        </Toolbar>
      ) : null}
      <FlatList
        data={rows}
        keyExtractor={(row) => row.key}
        className="flex-1"
        contentInsetAdjustmentBehavior="automatic"
        automaticallyAdjustKeyboardInsets={Platform.OS === "ios"}
        keyboardDismissMode={Platform.OS === "ios" ? "interactive" : "on-drag"}
        keyboardShouldPersistTaps="handled"
        showsVerticalScrollIndicator={false}
        contentContainerStyle={{
          paddingHorizontal: 16,
          paddingTop: 16,
          paddingBottom: usesNativeMailSearchToolbar
            ? NATIVE_MAIL_SEARCH_TOOLBAR_CONTENT_INSET + 16
            : Math.max(insets.bottom, 16) + 16,
        }}
        ListHeaderComponent={
          Platform.OS === "ios" ? undefined : (
            <View className="pb-4">
              <SearchField
                inputRef={searchRef}
                autoFocus={false}
                accessibilityLabel="Search threads"
                clearAccessibilityLabel="Clear thread search"
                onChangeText={setQuery}
                placeholder={THREAD_SEARCH_PLACEHOLDER}
                value={query}
              />
            </View>
          )
        }
        ListEmptyComponent={
          <Text className="p-5 text-center text-sm text-foreground-muted">No matching threads</Text>
        }
        renderItem={({ item, index }) => (
          <SelectionRow
            title={item.title}
            selected={item.key === selectedKey}
            isFirst={index === 0}
            isLast={index === rows.length - 1}
            onPress={() => {
              void Haptics.selectionAsync();
              if (item.key !== selectedKey) {
                setEditor((current) =>
                  current
                    ? {
                        ...current,
                        draft: item.thread
                          ? moveDraftToThread(current.draft, item.thread)
                          : { ...unbindDraftFromThread(current.draft), threadMode: "new_thread" },
                      }
                    : current,
                );
              }
              navigation.goBack();
            }}
          />
        )}
      />
    </SettingsScreen>
  );
}
