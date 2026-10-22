import { LRUCache } from "../lib/lruCache";
import { buildFileLinkParentSuffixByPath, fileLinkLabel } from "@t3tools/shared/fileLinks";
import {
  isWindowsDrivePathHref,
  normalizeMarkdownLinkDestination,
  extractInlineCodeSpans,
  extractMarkdownLinkHrefs,
  inlineCodeFilePathCandidate,
} from "@t3tools/shared/markdownLinks";
import { isHostPath, resolveWorkspaceFilePath } from "@t3tools/shared/path";
import { usePullRequestLinking } from "~/hooks/usePullRequestLinking";
import { AuthFilesystemReadScope, AuthOrchestrationOperateScope } from "@t3tools/contracts";
import {
  CHAT_MARKDOWN_REMARK_PLUGINS,
  CHAT_MARKDOWN_REMARK_PLUGINS_WITH_BREAKS,
  createChatMarkdownRehypePlugins,
} from "@t3tools/shared/markdownPipeline";
import { splitMarkdownBlocks, type MarkdownBlock } from "@t3tools/shared/markdownBlocks";
import { useAtomValue } from "@effect/atom-react";
import {
  COMPOSER_CONTEXT_CLIPBOARD_MIME,
  encodeComposerContextClipboardHtml,
} from "@t3tools/shared/composerContextClipboard";
import {
  FileSpreadsheetIcon,
  FileTextIcon,
  GlobeIcon,
  ImageIcon,
  InfoIcon,
  LightbulbIcon,
  MailIcon,
  MessageSquareIcon,
  MessageSquareWarningIcon,
  OctagonAlertIcon,
  PresentationIcon,
  SparklesIcon,
  TriangleAlertIcon,
  type LucideIcon,
} from "lucide-react";
import {
  AssetWorkspaceAssetNotFoundError,
  AuthPreviewOperateScope,
  type EditorId,
  type EnvironmentId,
  type ServerConfig,
  type ScopedThreadRef,
  type ServerProviderSkill,
  type ThreadPullRequestKey,
} from "@t3tools/contracts";
import { githubMediaFetchUrl } from "@t3tools/shared/githubMedia";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import {
  codexArtifactTemplatePresentationLabel,
  type CodexArtifactTemplate,
  type CodexArtifactTemplateKind,
} from "@t3tools/shared/codexArtifactTemplates";
import {
  classifyMarkdownImageSource,
  markdownImageSourceFragment,
} from "@t3tools/client-runtime/markdown-images";
import { mediaUrlReference } from "@t3tools/client-runtime/media-reference";
import { mediaKindFromPath, mediaMimeTypeFromExtension } from "@t3tools/shared/filePreview";
import * as Cause from "effect/Cause";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { AsyncResult, Atom } from "effect/reactivity";
import React, {
  Suspense,
  type ComponentProps,
  type ClipboardEvent as ReactClipboardEvent,
  use,
  memo,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import type {
  Components,
  ExtraProps as ReactMarkdownExtraProps,
  Options as ReactMarkdownOptions,
} from "react-markdown";
import ReactMarkdown from "react-markdown";
import { createIncrementalMarkdownPlugin } from "../markdown-incremental";
import { defaultUrlTransform } from "react-markdown";
import { parseAssistantCitationHref } from "@t3tools/shared/assistantCitations";
import { parseComposerContextHref } from "@t3tools/shared/composerContextReferences";
import { parseThreadLink, parseThreadLinkHref } from "@t3tools/shared/threadLinks";
import { AssistantCitationChip } from "./chat/AssistantCitationChip";
import { MarkdownThreadLink } from "./chat/MarkdownThreadLink";
import { buildItemNumberFromUrl } from "@t3tools/shared/buildLinks";
import { useThreadBuildOrigin } from "~/state/buildWorkItems";
import { BuildMentionChip } from "./buildItem/BuildMentionChip";
import { rehypeBuildMentions } from "@t3tools/shared/buildLinks";
import { mathKind } from "@t3tools/shared/markdownMath";
import remarkMath from "remark-math";
import {
  artifactTemplateFromHastProperties,
  renderCodexInlineDirectivesAsMarkdown,
} from "@t3tools/shared/codexMarkdownDirectives";
import { renderSkillInlineMarkdownChildren } from "./chat/SkillInlineText";
import { MarkdownMath } from "./chat/MarkdownMath";
import {
  resolveMarkdownMediaPreview,
  type ExpandedImagePreview,
} from "./chat/ExpandedImagePreview";
import { ExpandedImageDialog } from "./chat/ExpandedImageDialog";
import { markdownImageGallery } from "./chat/markdownImageGallery";
import { type MediaActionSource } from "./media/MediaActions";
import { resolveProtocolRelativeMediaUrl } from "./media/mediaContent";
import {
  revealInFileExplorerLabelForKind,
  revealInFileExplorerLabelForOs,
} from "./preview/fileExplorerLabel";
import {
  resolveExternalWebLinkHost,
  showExternalLinkContextMenu,
} from "./chat/externalLinkContextMenu";
import { Tooltip, TooltipPopup, TooltipTrigger } from "./ui/tooltip";
import { Button } from "./ui/button";
import { stackedThreadToast, toastManager } from "./ui/toast";
import { recordVisitForThread } from "../browserHistoryStore";
import {
  PreferredEditorEnvironmentRequiredError,
  useOpenInPreferredEditor,
  usePreferredEditor,
} from "../editorPreferences";
import { openInEditorMenuLabel } from "../editorLabels";
import { resolveDiffThemeName } from "../lib/diffRendering";
import { RenderErrorBoundary } from "./RenderErrorBoundary";
import { useRenderedAppearance } from "../hooks/useTheme";
import { useClientSettings } from "../hooks/useSettings";
import { chatMarkdownClipboardPayload } from "../markdown-clipboard";
import {
  resolveInlineCodeFileLinkMeta,
  resolveMarkdownFileLinkMeta,
  rewriteMarkdownFileUriHref,
  type MarkdownFileLinkMeta,
} from "../markdown-links";
import {
  markdownFileCopyPaths,
  markdownFileEditorTarget,
  resolveMarkdownFileHostPath,
} from "../markdownFileHostPath";
import { isMarkdownFileLinkLabel } from "@t3tools/shared/markdownLinks";
import { isElectron } from "../env";
import { readLocalApi } from "../localApi";
import { cn } from "../lib/utils";
import { resolveRemoteOpenState, useRemoteOpenResolution } from "../remoteOpen";
import { useRightPanelStore } from "../rightPanelStore";
import { readThreadShell, useProjects } from "../state/entities";
import { serverEnvironment } from "../state/server";
import { shellEnvironment } from "../state/shell";
import { assetEnvironment } from "../state/assets";
import {
  readEnvironmentScope,
  readPreparedConnection,
  useEnvironmentScope,
} from "../state/session";
import { previewEnvironment } from "../state/preview";
import { useAtomCommand } from "../state/use-atom-command";
import { useAtomQueryRunner } from "../state/use-atom-query-runner";
import { projectEnvironment } from "../state/projects";
import { filesystemEnvironment } from "../state/filesystem";
import {
  claimWorkspaceBasenameLookup,
  needsWorkspaceBasenameLookup,
  pickStrippedWorkspaceMatch,
  pickWorkspaceBasenameMatch,
  stripRepeatedWorkspacePrefix,
  WORKSPACE_BASENAME_LOOKUP_LIMIT,
} from "@t3tools/client-runtime/workspace-basename-lookup";
import {
  parseChangeRequestUrl,
  pullRequestCandidateUrlFromReferenceAutolink,
  resolvePullRequestPreviewTarget,
  useOpenChangeRequestLink,
} from "~/lib/openPullRequestLink";
import { useOpenLink } from "../browser/useOpenLink";
import { useCopyToClipboard, writeTextToClipboard } from "../hooks/useCopyToClipboard";
import { isPreviewAvailableFor } from "../browser/previewRuntime";
import {
  isBrowserPreviewFile,
  openFileInPreview,
  openUrlInPreview,
  BrowserPreviewUnavailableError,
  BrowserSettingsReadError,
} from "../browser/openFileInPreview";
import { resolveLinkTarget } from "../browser/browserLinkTarget";
import { PullRequestLinkPreview } from "./pullRequest/PullRequestLinkPreview";
import { MarkdownCodeBlock, SuspenseShikiCodeBlock } from "./chat/MarkdownCodeBlock";
import { MarkdownMermaidCodeBlock } from "./chat/MarkdownMermaidCodeBlock";
import { MarkdownTable } from "./chat/MarkdownTable";
import { MarkdownDetails } from "./chat/MarkdownDetails";
import {
  authoredImageSizeStyle,
  ChatMarkdownAssetImage,
  ChatMarkdownImage,
  ChatMarkdownImageFallback,
  ChatMarkdownVideo,
  MarkdownLinkContext,
  markdownImageCopy,
} from "./chat/ChatMarkdownMedia";
import { MarkdownExternalLinkContent } from "./chat/MarkdownExternalLink";
import { MarkdownFileLink } from "./chat/MarkdownFileLink";
import { canUseMarkdownFileShellActions } from "./chat/MarkdownFileLink.logic";
import { handleMarkdownFragmentClick, rehypeHeadingIds } from "./chat/markdownFragments";
import { rehypeTextDirection } from "./chat/markdownTextDirection";
import { hastHasText, hastPlainTextDeep, plainHastText } from "./chat/markdownHast.logic";
import {
  extractCodeBlock,
  extractFenceLanguage,
  extractFenceTitle,
  extractPreCodeMeta,
  isClosedCodeFence,
  nodeToPlainText,
} from "./chat/MarkdownCodeBlock.logic";
import { reportMarkdownActionFailure } from "./chat/markdownActionFailure";

const isAssetNotFoundError = Schema.is(AssetWorkspaceAssetNotFoundError);

interface ChatMarkdownProps {
  /** Compact markdown transforms remove blocks before rendering inside a label. */
  inline?: boolean;
  text: string;
  cwd: string | undefined;
  threadRef?: ScopedThreadRef | undefined;
  pullRequestPanelRef?: ScopedThreadRef | undefined;
  environmentId?: EnvironmentId | undefined;
  onTaskListChange?: ((input: { markerOffset: number; checked: boolean }) => void) | undefined;
  isStreaming?: boolean;
  /** Fades streamed words in as they arrive: the fork's opt-in calm streaming look. */
  revealWords?: boolean;
  skills?: ReadonlyArray<Pick<ServerProviderSkill, "name" | "displayName">>;
  className?: string;
  lineBreaks?: boolean;
  parseRawHtml?: boolean;
  onUseArtifactTemplate?: ((template: CodexArtifactTemplate) => void) | undefined;
  onRunShellCommand?: ((command: string) => void) | undefined;
  imageBaseDir?: string | undefined;
  workspaceMutationId?: string | null | undefined;
  onImageExpand?: ((preview: ExpandedImagePreview) => void) | undefined;
  extraRemarkPlugins?: NonNullable<ReactMarkdownOptions["remarkPlugins"]>;
  renderContextReference?: ((reference: ChatMarkdownContextReference) => ReactNode) | undefined;
  /** Loads GitHub-hosted media through `cwd`'s GitHub credential, which a private repository's
      uploads need; without it those images and videos load unauthenticated and 404. */
  githubMedia?: boolean | undefined;
  headingLevelOffset?: number | undefined;
}

export interface ChatMarkdownContextReference {
  kind: string;
  contextId: string;
  label: string;
}

const EMPTY_MARKDOWN_SKILLS: ReadonlyArray<Pick<ServerProviderSkill, "name" | "displayName">> = [];
const EMPTY_REMARK_PLUGINS: NonNullable<ReactMarkdownOptions["remarkPlugins"]> = [];

const ARTIFACT_TEMPLATE_ICON_BY_KIND = {
  document: FileTextIcon,
  presentation: PresentationIcon,
  spreadsheet: FileSpreadsheetIcon,
  site: GlobeIcon,
  "google-docs": FileTextIcon,
  "google-slides": PresentationIcon,
  "google-sheets": FileSpreadsheetIcon,
  image: ImageIcon,
  email: MailIcon,
  slack: MessageSquareIcon,
} satisfies Record<CodexArtifactTemplateKind, LucideIcon>;

function CodexArtifactTemplateCard(props: {
  readonly template: CodexArtifactTemplate;
  readonly onUse?: ((template: CodexArtifactTemplate) => void) | undefined;
}) {
  const Icon = ARTIFACT_TEMPLATE_ICON_BY_KIND[props.template.artifactKind];
  const presentationLabel = codexArtifactTemplatePresentationLabel(props.template.artifactKind);

  return (
    <div
      role="group"
      aria-label={`${props.template.displayName} template`}
      data-chat-markdown-artifact-template
      className="my-[0.65rem] flex w-full min-w-0 items-center gap-3 rounded-xl border border-border/70 bg-card/60 px-3 py-2.5 text-foreground shadow-xs"
      data-artifact-kind={props.template.artifactKind}
      data-markdown-copy={`${props.template.displayName} (${presentationLabel})\n\n`}
      data-skill-name={props.template.skillName}
    >
      <div className="flex min-w-0 flex-1 items-center gap-3">
        <span className="relative flex size-9 shrink-0 items-center justify-center rounded-lg border border-border/70 bg-background text-muted-foreground shadow-xs">
          <Icon aria-hidden className="size-5" />
          <span className="absolute -right-1 -bottom-1 flex size-4 items-center justify-center rounded-full border border-background bg-primary text-primary-foreground shadow-xs">
            <SparklesIcon aria-hidden className="size-2.5" />
          </span>
        </span>
        <div className="min-w-0">
          <div className="truncate text-sm font-medium text-foreground">
            {props.template.displayName}
          </div>
          <div className="text-xs text-muted-foreground">{presentationLabel}</div>
        </div>
      </div>
      {props.onUse ? (
        <Button
          data-thread-find-ignore
          type="button"
          size="sm"
          variant="outline"
          className="shrink-0"
          onClick={() => props.onUse?.(props.template)}
        >
          Use template
        </Button>
      ) : null}
    </div>
  );
}

const WINDOWS_DRIVE_PATH_REGEX = /^[A-Za-z]:[\\/]/;

function findTaskListMarkerOffset(markdown: string, listItemStart: number): number | null {
  const firstLineEnd = markdown.indexOf("\n", listItemStart);
  const firstLine = markdown.slice(
    listItemStart,
    firstLineEnd === -1 ? markdown.length : firstLineEnd,
  );
  const match = firstLine.match(/^(?:\s*(?:[-+*]|\d+[.)])\s+)(\[[ xX]\])/);
  if (!match?.[1]) return null;
  return listItemStart + firstLine.indexOf(match[1]);
}

function orderedListGutterStyle(
  itemCount: number,
  start: unknown,
): { "--list-gutter": string } | undefined {
  const parsedStart = Number.parseInt(String(start ?? 1), 10);
  const firstNumber = Number.isNaN(parsedStart) ? 1 : parsedStart;
  const lastNumber = firstNumber + Math.max(itemCount - 1, 0);
  const markerWidth = Math.max(String(firstNumber).length, String(lastNumber).length);
  if (markerWidth <= 1) return undefined;
  return { "--list-gutter": `${markerWidth + 2}ch` };
}

const GITHUB_ALERT_PRESENTATIONS: Record<
  string,
  { label: string; Icon: typeof InfoIcon; borderClassName: string; titleClassName: string }
> = {
  note: {
    label: "Note",
    Icon: InfoIcon,
    borderClassName: "border-blue-500/70",
    titleClassName: "text-blue-600 dark:text-blue-400",
  },
  tip: {
    label: "Tip",
    Icon: LightbulbIcon,
    borderClassName: "border-emerald-500/70",
    titleClassName: "text-emerald-600 dark:text-emerald-400",
  },
  important: {
    label: "Important",
    Icon: MessageSquareWarningIcon,
    borderClassName: "border-purple-500/70",
    titleClassName: "text-purple-600 dark:text-purple-400",
  },
  warning: {
    label: "Warning",
    Icon: TriangleAlertIcon,
    borderClassName: "border-amber-500/70",
    titleClassName: "text-amber-600 dark:text-amber-500",
  },
  caution: {
    label: "Caution",
    Icon: OctagonAlertIcon,
    borderClassName: "border-red-500/70",
    titleClassName: "text-red-600 dark:text-red-400",
  },
};

function bounceCopiedInlineCode(element: HTMLElement) {
  if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
  if (element.getClientRects().length !== 1) return;
  for (const animation of element.getAnimations()) animation.cancel();
  element.dataset.copyBounce = "";
  element.animate([{ scale: 1 }, { scale: 0.93, offset: 0.35 }, { scale: 1.02 }, { scale: 1 }], {
    duration: 260,
    easing: "ease-out",
  }).onfinish = () => {
    delete element.dataset.copyBounce;
  };
}

/** Inline code copies its text on click; a text selection is left alone. */
function CopyableInlineCode({
  text,
  children,
  ...props
}: React.ComponentProps<"code"> & { text: string }) {
  const { copyToClipboard } = useCopyToClipboard({ target: "code", timeout: 1200 });
  return (
    <code
      {...props}
      className={cn(props.className, "cursor-pointer")}
      onClick={(event) => {
        if (window.getSelection()?.toString()) return;
        copyToClipboard(text);
        bounceCopiedInlineCode(event.currentTarget);
      }}
    >
      {children}
    </code>
  );
}

function normalizeMarkdownLinkHrefKey(href: string): string {
  const normalizedHref = normalizeMarkdownLinkDestination(href);
  const rewrittenHref = rewriteMarkdownFileUriHref(normalizedHref) ?? normalizedHref;
  return WINDOWS_DRIVE_PATH_REGEX.test(rewrittenHref)
    ? rewrittenHref.replaceAll("\\", "/")
    : rewrittenHref;
}

type StreamWordHastNode = {
  type?: string;
  tagName?: string;
  value?: string;
  properties?: Record<string, unknown>;
  children?: StreamWordHastNode[];
};

// Code, links and media keep their own rendering, so their words arrive whole.
const STREAM_WORD_SKIP_TAGS = new Set(["pre", "code", "a", "img", "svg", "math"]);
// Only the newest blocks can still be fading words in; earlier ones stay plain text.
const STREAM_WORD_BLOCKS = 2;

/**
 * While a reply streams, wraps each word of its newest blocks in a span that fades in
 * once when inserted. Words keep their position in the tree between updates, so React
 * reuses their spans and only newly revealed words animate.
 */
function rehypeStreamWords() {
  const words = (value: string): StreamWordHastNode[] =>
    (value.match(/\s+|\S+/g) ?? []).map((part) =>
      /^\s/.test(part)
        ? { type: "text", value: part }
        : {
            type: "element",
            tagName: "span",
            properties: { className: ["chat-stream-word"] },
            children: [{ type: "text", value: part }],
          },
    );
  const wrap = (node: StreamWordHastNode) => {
    if (!node.children) return;
    node.children = node.children.flatMap((child) => {
      if (child.type === "text" && child.value) return words(child.value);
      if (child.type === "element" && !STREAM_WORD_SKIP_TAGS.has(child.tagName ?? "")) {
        wrap(child);
      }
      return [child];
    });
  };
  return (tree: StreamWordHastNode) => {
    const blocks = tree.children?.filter((child) => child.type === "element") ?? [];
    blocks.slice(-STREAM_WORD_BLOCKS).forEach(wrap);
  };
}

const EMPTY_REHYPE_PLUGINS: NonNullable<ReactMarkdownOptions["rehypePlugins"]> = [];
const CHAT_MARKDOWN_LITERAL_HTML_REHYPE_PLUGINS = [
  rehypeHeadingIds,
  rehypeTextDirection,
] satisfies NonNullable<
  ReactMarkdownOptions["rehypePlugins"]
>;

const NO_MARKDOWN_EDITORS: ReadonlyArray<EditorId> = [];

type MarkdownServerConfigFields = ReturnType<typeof markdownServerConfigFields>;

/** The server config fields markdown reads. */
function markdownServerConfigFields(config: ServerConfig | null) {
  return {
    pullRequestsEnabled: config?.environment.capabilities.pullRequests === true,
    availableEditors: config?.availableEditors ?? NO_MARKDOWN_EDITORS,
    revealInFileManagerLabel:
      config?.shellRevealInFileManager === true && config.availableEditors.includes("file-manager")
        ? config.shellRevealInFileManagerKind === undefined
          ? revealInFileExplorerLabelForOs(config.environment.platform.os)
          : revealInFileExplorerLabelForKind(config.shellRevealInFileManagerKind)
        : undefined,
  };
}

function markdownServerConfigFieldsEqual(
  previous: MarkdownServerConfigFields,
  next: MarkdownServerConfigFields,
): boolean {
  return (
    previous.pullRequestsEnabled === next.pullRequestsEnabled &&
    previous.revealInFileManagerLabel === next.revealInFileManagerLabel &&
    previous.availableEditors.length === next.availableEditors.length &&
    previous.availableEditors.every((editor, index) => editor === next.availableEditors[index])
  );
}

// The config object changes with every provider status push and snapshot. The
// atom keeps its previous value while the fields markdown reads are equal, so
// those pushes don't re-render every visible reply.
const markdownServerConfigFieldsAtom = Atom.family((environmentId: EnvironmentId | null) =>
  Atom.make((get) => {
    const next = markdownServerConfigFields(get(serverEnvironment.configValueAtom(environmentId)));
    const previous = Option.getOrNull(get.self<MarkdownServerConfigFields>());
    return previous !== null && markdownServerConfigFieldsEqual(previous, next) ? previous : next;
  }).pipe(Atom.withLabel("markdown-server-config-fields")),
);

type MarkdownFileLinks = ReturnType<typeof resolveUncachedMarkdownFileLinks>;

// The same links resolve to the same maps, so a streamed token that adds no link
// or code span leaves the renderer context, and every rendered link, unchanged.
const markdownFileLinksCache = new LRUCache<MarkdownFileLinks>(200, 4 * 1024 * 1024);

function resolveMarkdownFileLinks(
  text: string,
  cwd: string | undefined,
  baseDir: string | undefined,
) {
  const hrefs = extractMarkdownLinkHrefs(renderCodexInlineDirectivesAsMarkdown(text));
  const spans = extractInlineCodeSpans(text);
  const key = [cwd, baseDir, hrefs.join("\u0000"), spans.join("\u0000")].join("\u0001");
  const cached = markdownFileLinksCache.get(key);
  if (cached) return cached;
  const links = resolveUncachedMarkdownFileLinks(hrefs, spans, cwd, baseDir);
  markdownFileLinksCache.set(key, links, key.length * 2);
  return links;
}

function resolveUncachedMarkdownFileLinks(
  hrefs: ReadonlyArray<string>,
  spans: ReadonlyArray<string>,
  cwd: string | undefined,
  baseDir: string | undefined,
) {
  const markdownFileLinkMetaByHref = new Map<
    string,
    NonNullable<ReturnType<typeof resolveMarkdownFileLinkMeta>>
  >();
  for (const href of hrefs) {
    if (parseComposerContextHref(href)) continue;
    const normalizedHref = normalizeMarkdownLinkHrefKey(href);
    if (markdownFileLinkMetaByHref.has(normalizedHref)) continue;
    const meta = resolveMarkdownFileLinkMeta(normalizedHref, cwd, baseDir);
    if (meta) markdownFileLinkMetaByHref.set(normalizedHref, meta);
  }
  const inlineCodeFileLinkMetaByText = new Map<string, MarkdownFileLinkMeta>();
  for (const span of spans) {
    if (inlineCodeFileLinkMetaByText.has(span)) continue;
    const meta = resolveInlineCodeFileLinkMeta(span, cwd, baseDir);
    if (meta) inlineCodeFileLinkMetaByText.set(span, meta);
  }
  const fileLinkParentSuffixByPath = buildFileLinkParentSuffixByPath([
    ...[...markdownFileLinkMetaByHref.values()].map((meta) => meta.filePath),
    ...[...inlineCodeFileLinkMetaByText.values()].map((meta) => meta.filePath),
  ]);
  return { markdownFileLinkMetaByHref, inlineCodeFileLinkMetaByText, fileLinkParentSuffixByPath };
}

function useChatMarkdownState({
  text,
  inline = false,
  cwd,
  threadRef,
  pullRequestPanelRef,
  environmentId: explicitEnvironmentId,
  onTaskListChange,
  isStreaming = false,
  skills = EMPTY_MARKDOWN_SKILLS,
  onUseArtifactTemplate,
  onRunShellCommand,
  imageBaseDir,
  workspaceMutationId,
  onImageExpand,
  renderContextReference,
  headingLevelOffset = 0,
  githubMedia = false,
}: ChatMarkdownProps) {
  const resolvedTheme = useRenderedAppearance();
  const markdownRef = useRef<HTMLElement>(null);
  const mediaRequestId = useRef(0);
  // A preview opened from another thread or workspace never carries over.
  const mediaScopeKey = [
    threadRef?.environmentId,
    threadRef?.threadId,
    explicitEnvironmentId,
    cwd,
    imageBaseDir,
  ].join("\u0000");
  // Tagged with the scope it was opened in: a request from the previous scope can
  // resolve before the effect cleanup below invalidates it, and must stay hidden.
  const [localMedia, setLocalMedia] = useState<{
    scope: string;
    preview: ExpandedImagePreview;
  } | null>(null);
  const localMediaPreview = localMedia?.scope === mediaScopeKey ? localMedia.preview : null;
  const closeLocalMediaPreview = () => setLocalMedia(null);
  const expandMedia =
    onImageExpand ??
    ((preview: ExpandedImagePreview) => setLocalMedia({ scope: mediaScopeKey, preview }));
  const [mediaScope, setMediaScope] = useState(mediaScopeKey);
  if (mediaScope !== mediaScopeKey) {
    setMediaScope(mediaScopeKey);
    setLocalMedia(null);
  }
  // A layout cleanup runs in the commit that changes scope, so a request resolving
  // before paint cannot reach a parent onImageExpand either.
  useLayoutEffect(
    () => () => {
      mediaRequestId.current += 1;
    },
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- Leaving the scope invalidates media requests still loading for it.
    [mediaScopeKey],
  );
  const createAssetUrl = useAtomQueryRunner(assetEnvironment.createUrl, {
    reportFailure: false,
    refresh: true,
  });
  const searchProjectEntries = useAtomQueryRunner(projectEnvironment.searchEntries, {
    reportFailure: false,
  });
  const getFilesystemMetadata = useAtomQueryRunner(filesystemEnvironment.getMetadata, {
    reportFailure: false,
    refresh: true,
  });
  const openPreview = useAtomCommand(previewEnvironment.open, {
    reportFailure: false,
  });
  const pullRequestLinking = usePullRequestLinking(threadRef?.environmentId);
  const buildOrigin = useThreadBuildOrigin(threadRef);
  const environmentId = threadRef?.environmentId ?? explicitEnvironmentId ?? null;
  const canOperateHost = useEnvironmentScope(environmentId, AuthOrchestrationOperateScope);
  const canOperatePreview = useEnvironmentScope(environmentId, AuthPreviewOperateScope);
  const remoteOpen = useRemoteOpenResolution(environmentId);
  const canUseShellActions =
    canOperateHost &&
    canUseMarkdownFileShellActions(environmentId, remoteOpen.state.mode, remoteOpen.isResolved);
  const openMarkdownMedia = (
    source: string,
    resolvedFilePath?: string,
    clickedImage?: HTMLImageElement | null,
  ) => {
    const requestId = ++mediaRequestId.current;
    void resolveMarkdownMediaPreview({
      source,
      resolvedFilePath,
      cwd,
      threadRef,
      // Read at click time: a reconnect replaces the prepared connection, and
      // subscribing would hand every rendered markdown element a new context.
      httpBaseUrl:
        environmentId === null ? undefined : readPreparedConnection(environmentId)?.httpBaseUrl,
      createAssetUrl,
      onOpenFile: threadRef
        ? (path) => useRightPanelStore.getState().openFile(threadRef, path)
        : undefined,
    }).then(
      (preview) => {
        if (preview && mediaRequestId.current === requestId) {
          const selected = preview.images[preview.index];
          expandMedia(
            selected && selected.type !== "video" && markdownRef.current
              ? markdownImageGallery(clickedImage ?? markdownRef.current, selected)
              : preview,
          );
        }
      },
      (error: unknown) => {
        if (mediaRequestId.current !== requestId) return;
        let description =
          error instanceof Error
            ? error.message
            : "The file could not be loaded. It may have been moved or deleted.";
        if (
          isAssetNotFoundError(error) &&
          error.resource._tag === "media-file" &&
          environmentId !== null
        ) {
          // The connection may resolve while the media lookup is pending.
          const target = readPreparedConnection(environmentId)?.target ?? null;
          if (
            target !== null &&
            resolveRemoteOpenState({
              target,
              sshTarget: null,
              remoteOpenTargets: undefined,
              isDesktopRenderer: window.desktopBridge !== undefined,
            }).mode !== "local-exec"
          ) {
            description = `The file was not found on ${target.label} at ${error.checkedPath ?? error.resource.path}.`;
          }
        }
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: "Media unavailable",
            description,
          }),
        );
      },
    );
  };
  const { pullRequestsEnabled, availableEditors, revealInFileManagerLabel } = useAtomValue(
    markdownServerConfigFieldsAtom(environmentId),
  );
  const projects = useProjects();
  const [preferredEditor] = usePreferredEditor(availableEditors);
  const preferredEditorMenuLabel = openInEditorMenuLabel(preferredEditor);
  const openInPreferredEditor = useOpenInPreferredEditor(environmentId, availableEditors);
  const openInEditor = useAtomCommand(shellEnvironment.openInEditor, {
    reportFailure: false,
  });
  const revealFileInFileManager = (filePath: string) => {
    if (environmentId === null) {
      return Promise.resolve(
        AsyncResult.failure<void, PreferredEditorEnvironmentRequiredError>(
          Cause.fail(new PreferredEditorEnvironmentRequiredError({ targetPath: filePath })),
        ),
      );
    }
    if (!readEnvironmentScope(environmentId, AuthOrchestrationOperateScope)) {
      return Promise.resolve(
        AsyncResult.failure<void, Error>(
          Cause.fail(new Error("This connection cannot reveal files on this environment.")),
        ),
      );
    }
    return openInEditor({
      environmentId,
      input: { cwd: filePath, editor: "file-manager", reveal: true },
    });
  };
  const diffThemeName = resolveDiffThemeName(resolvedTheme);
  const { markdownFileLinkMetaByHref, inlineCodeFileLinkMetaByText, fileLinkParentSuffixByPath } =
    resolveMarkdownFileLinks(text, cwd, imageBaseDir ?? cwd);
  const markdownUrlTransform = (href: string) => {
    if (parseAssistantCitationHref(href)) return href;
    if (parseComposerContextHref(href)) return href;
    if (parseThreadLinkHref(href)) return href;
    if (isWindowsDrivePathHref(href)) return href;
    return rewriteMarkdownFileUriHref(href) ?? defaultUrlTransform(href);
  };
  const handleCopy = (event: ReactClipboardEvent<HTMLElement>) => {
    const selection = window.getSelection();
    if (!selection || selection.isCollapsed || !event.clipboardData) return;
    const payload = chatMarkdownClipboardPayload(selection);
    if (!payload) return;
    event.preventDefault();
    event.clipboardData.setData("text/plain", payload.text);
    const fragment = event.clipboardData.getData(COMPOSER_CONTEXT_CLIPBOARD_MIME);
    event.clipboardData.setData(
      "text/html",
      fragment
        ? encodeComposerContextClipboardHtml(payload.text, fragment, payload.html)
        : payload.html,
    );
  };
  const openChangeRequestLink = useOpenChangeRequestLink(threadRef, pullRequestPanelRef);
  const openDeferredMarkdownLink = useOpenLink(threadRef);
  // Subscribed rather than read at click time: the anchor has to decide
  // synchronously whether to intercept its `_blank`, and a subscription is what
  // makes a persisted "app" apply once settings hydrate after launch.
  const linkTargetPreference = useClientSettings((settings) => settings.browserLinkTarget);
  const mathEnabled = useClientSettings((settings) => settings.mathRenderingEnabled);
  const resolveThreadPullRequest = (
    href: string,
  ): (ThreadPullRequestKey & { readonly url: string }) | null => {
    if (
      threadRef === undefined ||
      readThreadShell(threadRef) === null ||
      !pullRequestLinking.canLink(href)
    )
      return null;
    const parsed = parseChangeRequestUrl(href);
    return parsed === null ? null : { ...parsed, url: href };
  };
  const linkedThreadPullRequestFor = (href: string) => {
    if (threadRef === undefined || !pullRequestLinking.isLinked(readThreadShell(threadRef), href))
      return null;
    const parsed = parseChangeRequestUrl(href);
    return parsed === null ? null : { ...parsed, url: href };
  };
  const updateThreadPullRequestLink = async (href: string, linked: boolean) => {
    if (threadRef === undefined || (!linked && linkedThreadPullRequestFor(href) === null)) return;
    if (!readEnvironmentScope(threadRef.environmentId, AuthOrchestrationOperateScope)) return;
    await pullRequestLinking.changeLink(threadRef, href, linked);
  };
  const openExternalLinkInPreview = (url: string) => {
    if (!threadRef || !canOperatePreview) {
      return Promise.resolve(
        AsyncResult.failure<void, BrowserPreviewUnavailableError>(
          Cause.fail(
            new BrowserPreviewUnavailableError({
              message: "Preview access is unavailable for this client.",
            }),
          ),
        ),
      );
    }
    return openUrlInPreview({ threadRef, url, openPreview }).then((result) => {
      if (result._tag === "Success") recordVisitForThread(threadRef, url);
      else if (!isAtomCommandInterrupted(result)) {
        const error = squashAtomCommandFailure(result);
        if (error instanceof BrowserSettingsReadError) {
          toastManager.add(
            stackedThreadToast({
              type: "error",
              title: "Unable to open link in browser",
              description: error.message,
            }),
          );
        }
      }
      return result;
    });
  };
  const openMarkdownFileInPreview = (path: string) => {
    const preparedConnection = threadRef ? readPreparedConnection(threadRef.environmentId) : null;
    if (!threadRef || !canOperatePreview || preparedConnection === null) {
      return Promise.resolve(
        AsyncResult.failure<void, BrowserPreviewUnavailableError>(
          Cause.fail(
            new BrowserPreviewUnavailableError({
              message: "Environment is not connected.",
            }),
          ),
        ),
      );
    }
    return openFileInPreview({
      threadRef,
      filePath: path,
      workspaceRoot: cwd,
      httpBaseUrl: preparedConnection.httpBaseUrl,
      createAssetUrl,
      openPreview,
    });
  };
  const findWorkspaceFileMatch = async (fileLinkMeta: MarkdownFileLinkMeta) => {
    const workspaceRelativePath = fileLinkMeta.workspaceLookupPath;
    if (
      !workspaceRelativePath ||
      !cwd ||
      environmentId === null ||
      !readEnvironmentScope(environmentId, AuthFilesystemReadScope)
    ) {
      return null;
    }
    const isBasename = needsWorkspaceBasenameLookup(workspaceRelativePath);
    const strippedPath = isBasename
      ? null
      : stripRepeatedWorkspacePrefix(workspaceRelativePath, cwd);
    if (!isBasename && strippedPath === null) return null;
    const result = await searchProjectEntries({
      environmentId,
      input: {
        cwd,
        query: strippedPath ?? workspaceRelativePath,
        limit: WORKSPACE_BASENAME_LOOKUP_LIMIT,
        kind: "file",
      },
    });
    if (result._tag !== "Success") return null;
    if (strippedPath === null) {
      return pickWorkspaceBasenameMatch(workspaceRelativePath, result.value.entries);
    }
    const match = pickStrippedWorkspaceMatch(strippedPath, cwd, result.value.entries);
    if (match === null) return null;
    // Search can be truncated or still scanning, so it cannot rule out the
    // literal path. Check the host before redirecting to the stripped match.
    const metadata = await getFilesystemMetadata({
      environmentId,
      input: { paths: [resolveWorkspaceFilePath(workspaceRelativePath, cwd)] },
    });
    return metadata._tag === "Success" && metadata.value.entries[0] === null ? match : null;
  };
  const openFileInPanel = (fileLinkMeta: MarkdownFileLinkMeta, panelPath: string) => {
    if (!threadRef) return;
    // Claimed on every open so a synchronous one supersedes a lookup already
    // in flight.
    const isLatestLookup = claimWorkspaceBasenameLookup();
    const openAt = (path: string) =>
      useRightPanelStore.getState().openFile(threadRef, path, fileLinkMeta.line);
    if (
      fileLinkMeta.workspaceLookupPath === null ||
      !cwd ||
      (!needsWorkspaceBasenameLookup(panelPath) &&
        stripRepeatedWorkspacePrefix(panelPath, cwd) === null)
    ) {
      openAt(panelPath);
      return;
    }
    void (async () => {
      const match = await findWorkspaceFileMatch(fileLinkMeta);
      if (!isLatestLookup()) return;
      openAt(match ?? panelPath);
    })();
  };
  const fileLinkChip = (
    fileLinkMeta: MarkdownFileLinkMeta,
    copyMarkdown: string,
    mediaSource?: string,
  ) => {
    const resolveHostPath = () =>
      resolveMarkdownFileHostPath({
        meta: fileLinkMeta,
        cwd,
        findWorkspaceMatch: () => findWorkspaceFileMatch(fileLinkMeta),
      });
    const mediaPath = mediaSource ?? fileLinkMeta.filePath;
    const canPreviewMedia =
      mediaMimeTypeFromExtension(
        fileLinkMeta.basename.slice(fileLinkMeta.basename.lastIndexOf(".")),
      ) !== null;
    const panelPath =
      fileLinkMeta.workspaceRelativePath ??
      (!canPreviewMedia && isHostPath(fileLinkMeta.filePath) ? fileLinkMeta.filePath : null);

    return (
      <MarkdownFileLink
        environmentId={environmentId}
        href={fileLinkMeta.targetPath}
        targetPath={fileLinkMeta.targetPath}
        iconPath={fileLinkMeta.filePath}
        workspaceRelativePath={fileLinkMeta.workspaceRelativePath}
        panelPath={panelPath}
        line={fileLinkMeta.line}
        label={fileLinkLabel(
          {
            path: fileLinkMeta.filePath,
            ...(fileLinkMeta.line !== undefined ? { line: fileLinkMeta.line } : {}),
            ...(fileLinkMeta.column !== undefined ? { column: fileLinkMeta.column } : {}),
          },
          fileLinkParentSuffixByPath,
        )}
        copyMarkdown={copyMarkdown}
        theme={resolvedTheme}
        threadRef={threadRef}
        onOpen={
          canUseShellActions
            ? async () =>
                openInPreferredEditor(
                  markdownFileEditorTarget(fileLinkMeta, await resolveHostPath()),
                )
            : undefined
        }
        resolveCopyPaths={async () =>
          markdownFileCopyPaths(fileLinkMeta, await resolveHostPath(), cwd)
        }
        onOpenInPanel={(path) => openFileInPanel(fileLinkMeta, path)}
        onOpenMedia={
          threadRef && canPreviewMedia
            ? () => openMarkdownMedia(mediaPath, fileLinkMeta.filePath)
            : undefined
        }
        openInEditorMenuLabel={preferredEditorMenuLabel}
        onReveal={
          canUseShellActions && revealInFileManagerLabel !== undefined
            ? async () => revealFileInFileManager((await resolveHostPath()).absolutePath)
            : undefined
        }
        revealLabel={revealInFileManagerLabel}
        onOpenInBrowser={
          threadRef &&
          canOperatePreview &&
          isPreviewAvailableFor(threadRef.environmentId) &&
          isBrowserPreviewFile(fileLinkMeta.filePath)
            ? () => openMarkdownFileInPreview(fileLinkMeta.filePath)
            : undefined
        }
      />
    );
  };

  const componentState = {
    buildOrigin,
    canOperateHost,
    canOperatePreview,
    cwd,
    diffThemeName,
    environmentId,
    expandMedia,
    fileLinkChip,
    githubMedia,
    renderContextReference,
    headingLevelOffset,
    imageBaseDir,
    workspaceMutationId,
    inlineCodeFileLinkMetaByText,
    inline,
    mathEnabled,
    isStreaming,
    linkTargetPreference,
    markdownFileLinkMetaByHref,
    onTaskListChange,
    onUseArtifactTemplate,
    onRunShellCommand,
    openChangeRequestLink,
    openDeferredMarkdownLink,
    openExternalLinkInPreview,
    openMarkdownMedia,
    projects,
    linkedThreadPullRequestFor,
    resolveThreadPullRequest,
    resolvedTheme,
    pullRequestsEnabled,
    skills,
    threadRef,
    updateThreadPullRequestLink,
  };
  return {
    buildOrigin,
    componentState,
    handleCopy,
    markdownRef,
    markdownUrlTransform,
    localMediaPreview,
    closeLocalMediaPreview,
  };
}

const ChatMarkdownRendererContext = React.createContext<
  ReturnType<typeof useChatMarkdownState>["componentState"]
>(null!);

// The block's markdown source changes on every streamed delta. Only the renderers
// that slice it by node offset read it, so it sits apart from the renderer context.
// Node offsets are block-relative; `offset` places them in the whole message.
const ChatMarkdownTextContext = React.createContext<MarkdownBlock>({ source: "", offset: 0 });

function markdownHeadingRenderer(level: 1 | 2 | 3 | 4 | 5 | 6) {
  const Tag = `h${level}` as const;
  return function MarkdownHeading({
    node: _node,
    ...props
  }: ComponentProps<typeof Tag> & ReactMarkdownExtraProps) {
    const { headingLevelOffset } = use(ChatMarkdownRendererContext);
    return (
      <Tag
        {...props}
        aria-level={headingLevelOffset > 0 ? Math.min(level + headingLevelOffset, 6) : undefined}
      />
    );
  };
}

// Keep component types stable when streaming changes the message state.
const CHAT_MARKDOWN_COMPONENTS = {
  h1: markdownHeadingRenderer(1),
  h2: markdownHeadingRenderer(2),
  h3: markdownHeadingRenderer(3),
  h4: markdownHeadingRenderer(4),
  h5: markdownHeadingRenderer(5),
  h6: markdownHeadingRenderer(6),
  div: function MarkdownDiv({ node, children, ...props }) {
    const { onUseArtifactTemplate } = use(ChatMarkdownRendererContext);
    const artifactTemplate = artifactTemplateFromHastProperties(node?.properties);
    if (artifactTemplate) {
      return (
        <CodexArtifactTemplateCard template={artifactTemplate} onUse={onUseArtifactTemplate} />
      );
    }
    return <div {...props}>{children}</div>;
  },
  p: function MarkdownParagraph({ node: _node, children, ...props }) {
    const { skills } = use(ChatMarkdownRendererContext);
    return <p {...props}>{renderSkillInlineMarkdownChildren(children, skills)}</p>;
  },
  blockquote: function MarkdownBlockquote({ node: _node, children, ...props }) {
    const alert =
      GITHUB_ALERT_PRESENTATIONS[String((props as Record<string, unknown>)["data-alert"] ?? "")];
    if (!alert) {
      return <blockquote {...props}>{children}</blockquote>;
    }
    return (
      <div
        role="note"
        dir={props.dir}
        className={cn("my-1 border-s-2 ps-3", alert.borderClassName)}
      >
        <p
          data-thread-find-ignore="true"
          className={cn("flex items-center gap-1.5 font-medium", alert.titleClassName)}
        >
          <alert.Icon aria-hidden className="size-3.5 shrink-0" />
          {alert.label}
        </p>
        {children}
      </div>
    );
  },
  ol: function MarkdownOrderedList({ node, start, style, ...props }) {
    const itemCount =
      node?.children?.filter((child) => child.type === "element" && child.tagName === "li")
        .length ?? 0;
    const gutterStyle = orderedListGutterStyle(itemCount, start);
    return (
      <ol {...props} start={start} style={gutterStyle ? { ...style, ...gutterStyle } : style} />
    );
  },
  li: function MarkdownListItem({ node, children, ...props }) {
    const { skills } = use(ChatMarkdownRendererContext);
    // The checkbox finds its marker from this offset when toggled, so list items
    // don't read the source text and re-render on every streamed token.
    // remark-gfm marks task items with this class; plain items carry no offset.
    const isTaskItem = String(props.className ?? "").includes("task-list-item");
    return (
      <li {...props} data-list-item-offset={isTaskItem ? node?.position?.start.offset : undefined}>
        {renderSkillInlineMarkdownChildren(children, skills)}
      </li>
    );
  },
  input: function MarkdownInput({ node: _node, type, checked, disabled: _disabled, ...props }) {
    const { onTaskListChange } = use(ChatMarkdownRendererContext);
    const block = use(ChatMarkdownTextContext);
    if (type !== "checkbox" || !onTaskListChange) {
      return (
        <input
          {...props}
          type={type}
          checked={checked}
          disabled={_disabled}
          readOnly={type === "checkbox"}
        />
      );
    }
    return (
      <input
        {...props}
        type="checkbox"
        name="markdown-task"
        aria-label="Toggle task"
        checked={checked}
        onChange={(event) => {
          const listItemStart = Number(event.currentTarget.closest("li")?.dataset.listItemOffset);
          if (!Number.isSafeInteger(listItemStart)) return;
          const markerOffset = findTaskListMarkerOffset(block.source, listItemStart);
          if (markerOffset === null) return;
          onTaskListChange({
            markerOffset: block.offset + markerOffset,
            checked: event.currentTarget.checked,
          });
        }}
      />
    );
  },
  a: function MarkdownAnchor({
    node,
    href,
    children,
    title: _title,
    "data-build-fallback": buildFallback,
    ...props
  }: React.ComponentProps<"a"> & ReactMarkdownExtraProps & { "data-build-fallback"?: boolean }) {
    const {
      buildOrigin,
      canOperateHost,
      canOperatePreview,
      cwd,
      environmentId,
      imageBaseDir,
      markdownFileLinkMetaByHref,
      threadRef,
      openMarkdownMedia,
      openChangeRequestLink,
      openDeferredMarkdownLink,
      linkTargetPreference,
      openExternalLinkInPreview,
      projects,
      linkedThreadPullRequestFor,
      resolveThreadPullRequest,
      pullRequestsEnabled,
      updateThreadPullRequestLink,
      fileLinkChip,
      renderContextReference,
    } = use(ChatMarkdownRendererContext);
    const { source: text } = use(ChatMarkdownTextContext);
    const citation = href ? parseAssistantCitationHref(href) : null;
    if (citation) return <AssistantCitationChip citation={citation} />;
    // A thread link names a thread in this message's environment, or the environment it is
    // qualified with, and opens it in the app.
    const threadLink = href ? parseThreadLink(href) : null;
    if (threadLink) {
      const label = hastPlainTextDeep(node) || threadLink.threadId;
      const linkEnvironmentId = threadLink.environmentId ?? environmentId;
      return linkEnvironmentId ? (
        <MarkdownThreadLink
          environmentId={linkEnvironmentId}
          threadId={threadLink.threadId}
          label={label}
          qualified={threadLink.environmentId !== null}
          foreign={threadLink.environmentId !== null && threadLink.environmentId !== environmentId}
        />
      ) : (
        <span>{label}</span>
      );
    }
    // A Build item on T3's HQ is a live chip. Until Build answers, or when it doesn't
    // know the number, a `#<number>` stays text and a written link stays an ordinary link.
    const buildNumber =
      href && buildOrigin !== null && threadRef && buildFallback !== true
        ? buildItemNumberFromUrl(href, buildOrigin)
        : null;
    if (buildNumber !== null && threadRef) {
      const reference = (props as Record<string, unknown>)["data-build-mention"] === "reference";
      return (
        <BuildMentionChip
          threadRef={threadRef}
          number={buildNumber}
          copy={reference ? `#${buildNumber}` : (href ?? "")}
          fallback={
            reference ? (
              <>{children}</>
            ) : (
              <MarkdownAnchor node={node} href={href} data-build-fallback {...props}>
                {children}
              </MarkdownAnchor>
            )
          }
        />
      );
    }
    const contextReference = href ? parseComposerContextHref(href) : null;
    if (contextReference) {
      const label = hastPlainTextDeep(node) || contextReference.contextId;
      return renderContextReference ? (
        renderContextReference({ ...contextReference, label })
      ) : (
        <span>{label}</span>
      );
    }
    const normalizedHref = href ? normalizeMarkdownLinkHrefKey(href) : "";
    const fileLinkMeta = normalizedHref
      ? (markdownFileLinkMetaByHref.get(normalizedHref) ??
        resolveMarkdownFileLinkMeta(normalizedHref, cwd, imageBaseDir ?? cwd))
      : null;
    if (!fileLinkMeta) {
      const faviconHost = resolveExternalWebLinkHost(href);
      const hasText = hastHasText(node);
      const pullRequestAutolink = String(
        (props as Record<string, unknown>)["data-pull-request-autolink"] ?? "",
      );
      const pullRequestCopy =
        pullRequestAutolink === "commit"
          ? /\/commit\/([0-9a-f]{40})$/iu.exec(href ?? "")?.[1]
          : pullRequestAutolink === "reference"
            ? plainHastText(node)
            : undefined;
      const isPullRequestAutolink = pullRequestCopy !== undefined;
      const confirmBeforeOpen = pullRequestAutolink === "reference";
      const pullRequestCandidateUrl =
        confirmBeforeOpen && href ? pullRequestCandidateUrlFromReferenceAutolink(href) : href;
      const pullRequestPreviewTarget = pullRequestCandidateUrl
        ? resolvePullRequestPreviewTarget({
            environmentId,
            projects,
            pullRequestsEnabled,
            url: pullRequestCandidateUrl,
          })
        : null;
      const isSameDocumentLink = href?.startsWith("#") ?? false;
      const onClick = props.onClick;
      const canOpenInPreview =
        canOperatePreview && Boolean(threadRef && isPreviewAvailableFor(threadRef.environmentId));
      const linkChildren = <MarkdownLinkContext value>{children}</MarkdownLinkContext>;
      const link = (
        <a
          {...props}
          className={cn(props.className, pullRequestAutolink === "commit" && "font-mono")}
          data-markdown-copy={pullRequestCopy}
          data-markdown-image-link={!hasText || undefined}
          href={href}
          target={isSameDocumentLink ? undefined : "_blank"}
          rel={isSameDocumentLink ? undefined : "noopener noreferrer"}
          onClick={(event) => {
            onClick?.(event);
            if (isSameDocumentLink && href) {
              handleMarkdownFragmentClick(event, href);
              return;
            }
            if (
              href &&
              faviconHost !== null &&
              mediaKindFromPath(href) !== null &&
              !event.defaultPrevented &&
              !event.metaKey &&
              !event.ctrlKey &&
              !event.shiftKey &&
              !event.altKey
            ) {
              event.preventDefault();
              event.stopPropagation();
              openMarkdownMedia(
                href,
                undefined,
                event.target instanceof HTMLImageElement
                  ? event.target
                  : event.currentTarget.querySelector("img"),
              );
              return;
            }
            if (
              !href ||
              openChangeRequestLink(event, href, undefined, environmentId ?? undefined)
            ) {
              return;
            }
            if (event.defaultPrevented) return;
            if (
              resolveLinkTarget({
                url: href,
                event,
                preference: linkTargetPreference,
                canOpenInApp: canOpenInPreview,
              }) !== "app"
            ) {
              // Chromium turns an Option/Alt-click into a download that never reaches the
              // shell. On desktop, open the link here while the key is still down, so link
              // routers such as Finicky can still read it.
              if (isElectron && event.altKey) {
                event.preventDefault();
                event.stopPropagation();
                void readLocalApi()
                  ?.shell.openExternal(href)
                  .catch((cause) =>
                    reportMarkdownActionFailure(
                      { operation: "open-link-external", target: href },
                      cause,
                    ),
                  );
              }
              return;
            }
            event.preventDefault();
            event.stopPropagation();
            void openExternalLinkInPreview(href).then((result) => {
              if (result._tag === "Success" || isAtomCommandInterrupted(result)) return;
              reportMarkdownActionFailure(
                { operation: "open-link-in-preview", target: href },
                result.cause,
              );
              if (squashAtomCommandFailure(result) instanceof BrowserSettingsReadError) return;
              void readLocalApi()?.shell.openExternal(href);
            });
          }}
          onContextMenu={(event) => {
            if (!href || !faviconHost) return;
            event.preventDefault();
            event.stopPropagation();
            const api = readLocalApi();
            if (!api) return;
            const threadLinkAction = !canOperateHost
              ? undefined
              : linkedThreadPullRequestFor(href) !== null
                ? "unlink-from-thread"
                : resolveThreadPullRequest(href) === null
                  ? undefined
                  : "link-to-thread";
            void showExternalLinkContextMenu({
              href,
              canOpenInPreview,
              threadLinkAction,
              position: { x: event.clientX, y: event.clientY },
              showContextMenu: (items, position) => api.contextMenu.show(items, position),
              openInPreview: async (target) => {
                const result = await openExternalLinkInPreview(target);
                if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
                  reportMarkdownActionFailure(
                    { operation: "open-link-in-preview", target },
                    result.cause,
                  );
                }
              },
              openExternal: (target) => api.shell.openExternal(target),
              copyLink: (target) => writeTextToClipboard(target, "link"),
              updateThreadLink: updateThreadPullRequestLink,
              reportFailure: (operation, cause) => {
                reportMarkdownActionFailure({ operation, target: href }, cause);
                if (
                  operation === "link-pull-request-to-thread" ||
                  operation === "unlink-pull-request-from-thread"
                ) {
                  toastManager.add(
                    stackedThreadToast({
                      type: "error",
                      title:
                        operation === "link-pull-request-to-thread"
                          ? "Unable to link pull request"
                          : "Unable to unlink pull request",
                      description: cause instanceof Error ? cause.message : "The request failed.",
                    }),
                  );
                }
              },
            });
          }}
        >
          {faviconHost && hasText && !isPullRequestAutolink ? (
            <MarkdownExternalLinkContent host={faviconHost} plainText={plainHastText(node)}>
              {linkChildren}
            </MarkdownExternalLinkContent>
          ) : (
            linkChildren
          )}
        </a>
      );
      if (!faviconHost || !href) {
        return link;
      }
      if (pullRequestPreviewTarget !== null) {
        return (
          <PullRequestLinkPreview
            link={link}
            originalUrl={href}
            target={pullRequestPreviewTarget}
            confirmBeforeOpen={confirmBeforeOpen}
            onOpenPullRequest={(targetUrl) =>
              openChangeRequestLink(
                {
                  metaKey: false,
                  ctrlKey: false,
                  preventDefault: () => undefined,
                  stopPropagation: () => undefined,
                },
                targetUrl,
                undefined,
                environmentId ?? undefined,
              )
            }
            onOpenFallback={openDeferredMarkdownLink}
          />
        );
      }
      return (
        <Tooltip>
          <TooltipTrigger render={link} />
          <TooltipPopup side="top">{href}</TooltipPopup>
        </Tooltip>
      );
    }

    const label = nodeToPlainText(children);
    const start = node?.position?.start.offset;
    const end = node?.position?.end.offset;
    const source = start !== undefined && end !== undefined ? text.slice(start, end) : "";
    const copyMarkdown =
      source.startsWith("[") && source.includes("](")
        ? source
        : `[${(label || fileLinkMeta.basename).replace(/[\\[\]]/g, "\\$&")}](${normalizedHref})`;
    const chip = fileLinkChip(fileLinkMeta, copyMarkdown, normalizedHref);
    return isMarkdownFileLinkLabel(label, normalizedHref) ? (
      chip
    ) : (
      <span data-markdown-copy={copyMarkdown}>
        {children} {chip}
      </span>
    );
  },
  code: function MarkdownCode({ node, children, className, ...props }) {
    const insideLink = use(MarkdownLinkContext);
    const { cwd, imageBaseDir, inlineCodeFileLinkMetaByText, fileLinkChip, mathEnabled, inline } =
      use(ChatMarkdownRendererContext);
    const math = mathEnabled ? mathKind(className) : null;
    if (math) {
      return (
        <MarkdownMath
          tex={nodeToPlainText(children)}
          display={math === "display"}
          focusable={!inline}
        />
      );
    }
    if (node?.properties?.dataInlineCode != null) {
      const codeText = nodeToPlainText(children);
      const fileLinkMeta =
        inlineCodeFileLinkMetaByText.get(codeText.trim()) ??
        resolveInlineCodeFileLinkMeta(codeText, cwd, imageBaseDir ?? cwd);
      if (fileLinkMeta) {
        return fileLinkChip(
          fileLinkMeta,
          `\`${codeText}\``,
          inlineCodeFilePathCandidate(codeText) ?? codeText.trim(),
        );
      }
    }
    if (node?.properties?.dataInlineCode != null && !insideLink) {
      return (
        <CopyableInlineCode {...props} className={className} text={nodeToPlainText(children)}>
          {children}
        </CopyableInlineCode>
      );
    }
    return (
      <code {...props} className={className}>
        {children}
      </code>
    );
  },
  img: function MarkdownImage({ node, title, src, alt, ...props }) {
    const {
      expandMedia,
      cwd,
      environmentId,
      githubMedia,
      imageBaseDir,
      threadRef,
      workspaceMutationId,
      renderContextReference,
    } = use(ChatMarkdownRendererContext);
    const imageExpand = use(MarkdownLinkContext) ? undefined : expandMedia;
    const contextReference = typeof src === "string" ? parseComposerContextHref(src) : null;
    if (contextReference) {
      const label = alt || contextReference.contextId;
      return renderContextReference ? (
        renderContextReference({ ...contextReference, label })
      ) : (
        <span>{label}</span>
      );
    }
    const localSrc = node?.properties?.dataLocalSrc;
    const markdownTitle = node?.properties?.dataMarkdownTitle;
    const standalone = node?.properties?.dataStandalone === true;
    const authoredSrc = typeof localSrc === "string" ? localSrc : src;
    const authoredTitle = typeof markdownTitle === "string" ? markdownTitle : title;
    const srcString =
      typeof authoredSrc === "string" ? normalizeMarkdownLinkDestination(authoredSrc) : "";
    const classifiedSrc =
      typeof localSrc === "string" ? srcString.replaceAll("\\", "/") : srcString;
    const altText = alt ?? "";
    const copyMarkdown = markdownImageCopy(altText, srcString, authoredTitle);
    const { className, style: _style, width, height, ...imageProps } = props;
    const authoredSizeStyle = authoredImageSizeStyle(width, height);
    const imageSource = classifyMarkdownImageSource(classifiedSrc, imageBaseDir ?? cwd);
    const kind = mediaKindFromPath(classifiedSrc) ?? "image";
    const directUri = imageSource._tag === "Direct" ? imageSource.uri : null;
    const githubMediaUrl =
      directUri === null ? null : githubMediaFetchUrl(resolveProtocolRelativeMediaUrl(directUri));
    if (
      githubMedia &&
      cwd !== undefined &&
      environmentId !== null &&
      directUri !== null &&
      githubMediaUrl !== null
    ) {
      return (
        <ChatMarkdownAssetImage
          environmentId={environmentId}
          resource={{ _tag: "github-media", cwd, url: githubMediaUrl }}
          alt={altText}
          kind={kind}
          copyMarkdown={copyMarkdown}
          standalone={standalone}
          className={className}
          style={authoredSizeStyle}
          imageProps={imageProps}
          srcFragment={markdownImageSourceFragment(classifiedSrc)}
          originalUrl={resolveProtocolRelativeMediaUrl(directUri)}
          framed={false}
          fallbackSrc={githubMediaUrl}
          onImageExpand={imageExpand}
        />
      );
    }
    if (imageSource._tag === "Direct") {
      const mediaSrc = resolveProtocolRelativeMediaUrl(imageSource.uri);
      const originalUrl =
        resolveExternalWebLinkHost(imageSource.uri) !== null ? imageSource.uri : undefined;
      const reference = mediaUrlReference(imageSource.uri);
      const actionsSource: MediaActionSource = {
        kind,
        name: altText || kind,
        src: mediaSrc,
        ...(reference ? { reference } : {}),
      };
      if (kind === "video") {
        return (
          <ChatMarkdownVideo
            src={mediaSrc}
            alt={altText}
            copyMarkdown={copyMarkdown}
            originalUrl={originalUrl}
            style={authoredSizeStyle}
            actionsSource={actionsSource}
          />
        );
      }
      return (
        <ChatMarkdownImage
          key={mediaSrc}
          src={mediaSrc}
          alt={altText}
          copyMarkdown={copyMarkdown}
          standalone={standalone}
          className={className}
          style={authoredSizeStyle}
          imageProps={imageProps}
          actionsSource={actionsSource}
          originalUrl={originalUrl}
          onImageExpand={imageExpand}
        />
      );
    }
    if (imageSource._tag === "WorkspaceFile" && threadRef) {
      return (
        <ChatMarkdownAssetImage
          environmentId={threadRef.environmentId}
          resource={{
            _tag: "media-file",
            threadId: threadRef.threadId,
            path: imageSource.path,
          }}
          alt={altText}
          kind={kind}
          copyMarkdown={copyMarkdown}
          srcFragment={markdownImageSourceFragment(classifiedSrc)}
          standalone={standalone}
          style={authoredSizeStyle}
          workspaceRoot={cwd}
          workspaceMutationId={workspaceMutationId}
          onImageExpand={imageExpand}
        />
      );
    }
    return <ChatMarkdownImageFallback alt={altText} copyMarkdown={copyMarkdown} kind={kind} />;
  },
  table: function MarkdownTableRenderer({ node: _node, ...props }) {
    return <MarkdownTable {...props} />;
  },
  details: function MarkdownDetailsRenderer({ node: _node, children, open: detailsOpen }) {
    return <MarkdownDetails open={detailsOpen}>{children}</MarkdownDetails>;
  },
  pre: function MarkdownPre({ node, children, ...props }) {
    const {
      resolvedTheme,
      diffThemeName,
      expandMedia,
      isStreaming,
      onRunShellCommand,
      inline,
      mathEnabled,
    } = use(ChatMarkdownRendererContext);
    const { source: text } = use(ChatMarkdownTextContext);
    const codeBlock = extractCodeBlock(children);
    if (!codeBlock) {
      return <pre {...props}>{children}</pre>;
    }

    const language = extractFenceLanguage(codeBlock.className);
    if (
      mathEnabled &&
      language === "math" &&
      (!isStreaming ||
        mathKind(codeBlock.className) === "display" ||
        isClosedCodeFence(node, text, codeBlock.code))
    ) {
      return <MarkdownMath tex={codeBlock.code} display focusable={!inline} />;
    }
    const fenceTitle = extractFenceTitle(extractPreCodeMeta(node));
    const highlightedCode = (
      <RenderErrorBoundary
        resetKeys={[codeBlock.code, language, diffThemeName, isStreaming]}
        fallback={<pre {...props}>{children}</pre>}
      >
        <Suspense
          fallback={
            <pre {...props} className="invisible" aria-hidden>
              {children}
            </pre>
          }
        >
          <SuspenseShikiCodeBlock
            className={codeBlock.className}
            code={codeBlock.code}
            themeName={diffThemeName}
            isStreaming={isStreaming}
          />
        </Suspense>
      </RenderErrorBoundary>
    );
    if (language === "mermaid") {
      return (
        <MarkdownMermaidCodeBlock
          code={codeBlock.code}
          fenceTitle={fenceTitle}
          theme={resolvedTheme}
          isStreaming={isStreaming && !isClosedCodeFence(node, text, codeBlock.code)}
          onExpand={(src) => expandMedia({ images: [{ src, name: "Mermaid diagram" }], index: 0 })}
        >
          {highlightedCode}
        </MarkdownMermaidCodeBlock>
      );
    }
    return (
      <MarkdownCodeBlock
        code={codeBlock.code}
        language={language}
        fenceTitle={fenceTitle}
        theme={resolvedTheme}
        onRunShellCommand={
          onRunShellCommand && !isStreaming && isClosedCodeFence(node, text, codeBlock.code)
            ? onRunShellCommand
            : undefined
        }
        isStreaming={isStreaming}
      >
        {highlightedCode}
      </MarkdownCodeBlock>
    );
  },
} satisfies Components;

/**
 * One top-level block of a message. Memoised, so a streamed token re-renders only
 * the block it changed rather than re-parsing and re-rendering the whole message.
 */
const ChatMarkdownBlock = memo(function ChatMarkdownBlock({
  source,
  offset,
  remarkPlugins,
  rehypePlugins,
  urlTransform,
}: {
  source: string;
  offset: number;
  remarkPlugins: NonNullable<ReactMarkdownOptions["remarkPlugins"]>;
  rehypePlugins: NonNullable<ReactMarkdownOptions["rehypePlugins"]>;
  urlTransform: ReactMarkdownOptions["urlTransform"];
}) {
  return (
    <ChatMarkdownTextContext value={{ source, offset }}>
      <ReactMarkdown
        remarkPlugins={remarkPlugins}
        rehypePlugins={rehypePlugins}
        skipHtml={false}
        components={CHAT_MARKDOWN_COMPONENTS}
        urlTransform={urlTransform}
      >
        {source}
      </ReactMarkdown>
    </ChatMarkdownTextContext>
  );
});

function ChatMarkdown({
  text,
  className,
  inline = false,
  lineBreaks = false,
  parseRawHtml = true,
  extraRemarkPlugins = EMPTY_REMARK_PLUGINS,
  revealWords = false,
  ...props
}: ChatMarkdownProps) {
  const {
    buildOrigin,
    componentState,
    handleCopy,
    markdownRef,
    markdownUrlTransform,
    localMediaPreview,
    closeLocalMediaPreview,
  } = useChatMarkdownState({ text, inline, ...props });
  // One parse cache per message, so finding the blocks of a streaming, code-heavy
  // reply does not re-parse its completed prefix on every token.
  const [incrementalParser] = useState(createIncrementalMarkdownPlugin);
  const incrementalParsing = props.isStreaming === true && /(?:^|\n) {0,3}(?:`{3}|~{3})/.test(text);
  // Extra syntax plugins can change the block structure, so those messages render whole.
  const blocks =
    extraRemarkPlugins.length === 0 && !componentState.mathEnabled
      ? splitMarkdownBlocks(text, incrementalParsing ? [incrementalParser] : [])
      : [{ source: text, offset: 0 }];
  const Root = inline ? "span" : "div";
  const bindMarkdownRef = (node: HTMLElement | null) => {
    markdownRef.current = node;
  };
  const remarkPlugins = [
    ...(lineBreaks ? CHAT_MARKDOWN_REMARK_PLUGINS_WITH_BREAKS : CHAT_MARKDOWN_REMARK_PLUGINS),
    ...extraRemarkPlugins,
  ];
  if (componentState.mathEnabled)
    remarkPlugins.unshift([remarkMath, { singleDollarTextMath: true }]);

  const rehypePlugins = (() => {
    const mentions: NonNullable<ReactMarkdownOptions["rehypePlugins"]> =
      buildOrigin === null
        ? EMPTY_REHYPE_PLUGINS
        : [[rehypeBuildMentions, { origin: buildOrigin }]];
    const base = parseRawHtml
      ? // Heading ids are added after sanitizing, which would prefix them a second time.
        [...createChatMarkdownRehypePlugins(mentions), rehypeHeadingIds, rehypeTextDirection]
      : [...mentions, ...CHAT_MARKDOWN_LITERAL_HTML_REHYPE_PLUGINS];
    return base;
  })();
  const streamWordsRehypePlugins =
    revealWords && props.isStreaming ? [...rehypePlugins, rehypeStreamWords] : rehypePlugins;

  return (
    <Root
      ref={bindMarkdownRef}
      className={cn(
        "chat-markdown w-full min-w-0 [overflow-wrap:anywhere] [word-break:break-word]",
        !inline &&
          "text-sm leading-relaxed text-foreground/[calc(80%+var(--appearance-contrast-boost)/5)]",
        className,
      )}
      data-streaming={componentState.isStreaming ? "" : undefined}
      onCopy={handleCopy}
    >
      <ChatMarkdownRendererContext value={componentState}>
        {blocks.map((block, index) => (
          <ChatMarkdownBlock
            // Appended text never moves an earlier block's start, so each keeps its subtree.
            key={block.offset}
            source={block.source}
            offset={block.offset}
            remarkPlugins={remarkPlugins}
            rehypePlugins={
              index >= blocks.length - STREAM_WORD_BLOCKS ? streamWordsRehypePlugins : rehypePlugins
            }
            urlTransform={markdownUrlTransform}
          />
        ))}
      </ChatMarkdownRendererContext>
      {localMediaPreview ? (
        <ExpandedImageDialog preview={localMediaPreview} onClose={closeLocalMediaPreview} />
      ) : null}
    </Root>
  );
}

export default memo(ChatMarkdown);
