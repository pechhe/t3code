import { buildSessionThreadLink } from "@t3tools/client-runtime/build-session-thread-link";
import {
  type ForgeStatusTone,
  forgeItemLabel,
  forgeItemNumberHint,
  buildKindGlyph,
  buildSessionLabel,
  buildStatusLabel,
  buildStatusTone,
  describeForgeWait,
  presentSpecTickets,
} from "@t3tools/client-runtime/state/forge-work-items";
import type { ForgeWorkItemCard, EnvironmentId, ThreadId } from "@t3tools/contracts";
import { formatThreadLink } from "@t3tools/shared/threadLinks";
import { useNavigation, type StaticScreenProps } from "@react-navigation/native";
import { type ReactNode, useState } from "react";
import { Linking, Platform, ScrollView, View } from "react-native";
import { Screen, ScreenStack, ScreenStackHeaderConfig } from "react-native-screens";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AndroidSheetHeader } from "../../components/ui/AndroidScreenHeader";
import { AppText as Text } from "../../components/ui/AppText";
import { Button } from "../../components/ui/Button";
import { ScreenContent } from "../../components/ui/ScreenContent";
import { cn } from "../../lib/cn";
import { relativeTime } from "../../lib/time";
import { uuidv4 } from "../../lib/uuid";
import { useUniwindTheme } from "../../lib/useUniwindTheme";
import { NativeStackScreenOptions, nativeHeaderScrollEdgeEffects } from "../../native/StackHeader";
import { forgeWorkItems } from "../../state/forge-work-items";
import { useThreadShell } from "../../state/entities";
import { useEnvironments } from "../../state/environments";
import { useEnvironmentQuery } from "../../state/query";
import { SelectableMarkdownText } from "../../native/SelectableMarkdownText";
import { useMarkdownPreviewStyles } from "../files/FileMarkdownPreview";
import { useAdaptiveWorkspaceLayout } from "../layout/AdaptiveWorkspaceLayout";

const HEADER_SCROLL_EDGE_EFFECTS = nativeHeaderScrollEdgeEffects(Platform.OS, Platform.Version);

/** The thread's own link, or an item its chat mentions, which carries no `itemId` until read. */
type ForgeItemTarget = {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly itemId?: string;
  readonly number: number;
  readonly url: string;
};

const DOT_CLASSES: Record<ForgeStatusTone, string> = {
  "not-started": "border border-foreground-muted",
  "in-progress": "bg-amber-500",
  landed: "bg-emerald-500",
  accepted: "bg-emerald-500",
  dropped: "bg-foreground-muted",
  unknown: "bg-foreground-muted",
};

function Dot(props: { status: string }) {
  return (
    <View
      className={cn("size-2 rounded-full", DOT_CLASSES[buildStatusTone({ status: props.status })])}
    />
  );
}

function ItemLine(props: {
  item: { number: number; ref?: string | null; title: string; status: string };
}) {
  const { item } = props;
  return (
    <View className="flex-row items-center gap-2 py-1">
      <Dot status={item.status} />
      <Text className="text-sm text-foreground-muted">{forgeItemLabel(item)}</Text>
      <Text className="min-w-0 flex-1 text-sm text-foreground" numberOfLines={1}>
        {item.title}
      </Text>
      {forgeItemNumberHint(item) === undefined ? null : (
        <Text className="text-xs text-foreground-muted/70">{forgeItemNumberHint(item)}</Text>
      )}
    </View>
  );
}

function Section(props: { title: string; children: ReactNode }) {
  return (
    <View className="mt-5">
      <Text className="mb-1 text-xs font-t3-bold uppercase text-foreground-muted">
        {props.title}
      </Text>
      {props.children}
    </View>
  );
}

function Banner(props: { tone: "held" | "blocked" | "accepted"; children: string }) {
  return (
    <View
      className={cn(
        "mt-4 rounded-xl px-3 py-2.5",
        props.tone === "held" && "bg-orange-500/15",
        props.tone === "blocked" && "bg-red-500/15",
        props.tone === "accepted" && "bg-emerald-500/15",
      )}
    >
      <Text
        className={cn(
          "text-sm",
          props.tone === "held" && "text-orange-500",
          props.tone === "blocked" && "text-red-500",
          props.tone === "accepted" && "text-emerald-500",
        )}
      >
        {props.children}
      </Text>
    </View>
  );
}

function SessionThreadLink(props: {
  link: NonNullable<ReturnType<typeof buildSessionThreadLink>>;
  role: string;
  activity: string;
}) {
  const navigation = useNavigation();
  const { presentationById } = useEnvironments();
  const thread = useThreadShell(props.link);
  const styles = useMarkdownPreviewStyles();
  const theme = useUniwindTheme();
  const label = thread?.title.trim() || "T3 thread";
  if (!presentationById.has(props.link.environmentId)) {
    return (
      <Text className="text-xs text-foreground-muted">
        {`${props.role}: ${label} (environment ${props.link.environmentId}) · ${props.activity}`}
      </Text>
    );
  }
  return (
    <SelectableMarkdownText
      markdown={`${props.role}: ${formatThreadLink(props.link.threadId, label, props.link.environmentId)} · ${props.activity}`}
      textStyle={{
        ...styles.nativeTextStyle,
        color: theme["--color-foreground-muted"],
        fontSize: 12,
        lineHeight: 16,
      }}
      marginBottom={0}
      onLinkPress={() =>
        navigation.navigate("Thread", {
          environmentId: String(props.link.environmentId),
          threadId: String(props.link.threadId),
        })
      }
    />
  );
}

function CardBody(props: { card: ForgeWorkItemCard }) {
  const { card } = props;
  const { item, detail } = card;
  const waits = item.waits.map(describeForgeWait);
  const session = detail.kind === "spec" ? detail.lead : detail.worker;
  const threadLink = buildSessionThreadLink(session);
  const tickets = detail.kind === "spec" ? presentSpecTickets(detail) : null;

  return (
    <View>
      <View className="flex-row items-center gap-2">
        <Text className="min-w-0 flex-1 text-xs text-foreground-muted" numberOfLines={1}>
          {detail.kind === "spec"
            ? [`${buildKindGlyph("spec")} Spec`, detail.specKind, detail.horizon]
                .filter(Boolean)
                .join(" · ")
            : `${buildKindGlyph("ticket")} Ticket${detail.spec ? ` in ${buildKindGlyph("spec")} ${detail.spec.title}` : ""}`}
        </Text>
        <Dot status={item.status} />
        <Text className="text-xs text-foreground-muted">{buildStatusLabel(item.status)}</Text>
      </View>
      {forgeItemNumberHint({ number: card.number, ref: item.ref }) === undefined ? null : (
        <Text className="mt-2 text-xs text-foreground-muted/70">
          {forgeItemNumberHint({ number: card.number, ref: item.ref })}
        </Text>
      )}
      <Text className="mt-1 text-lg font-t3-bold text-foreground">{item.title}</Text>
      {card.summary ? (
        <Text className="mt-1 text-sm text-foreground-muted" numberOfLines={3}>
          {card.summary}
        </Text>
      ) : null}

      {item.holds.map((hold) => (
        <Banner key={`${hold.kind}:${hold.note}`} tone="held">
          {`⏸ Held · ${hold.kind}${hold.note ? `: ${hold.note}` : ""}`}
        </Banner>
      ))}
      {waits.map((wait) => (
        <Banner key={wait.blocker} tone="blocked">
          {`⛓ Blocked by ${wait.blocker} (${wait.status}). ${wait.startsWhen}`}
        </Banner>
      ))}
      {detail.kind === "spec" && detail.acceptedAt ? (
        <Banner tone="accepted">{`Accepted ${relativeTime(detail.acceptedAt)} ago`}</Banner>
      ) : null}

      {detail.kind === "spec" && tickets ? (
        <Section title={`Tickets · ${tickets.total}`}>
          {tickets.total > 0 ? (
            <>
              <View className="my-1.5 h-1.5 flex-row overflow-hidden rounded-full bg-secondary">
                {tickets.segments.map((segment) => (
                  <View
                    key={segment.status}
                    className={DOT_CLASSES[segment.tone]}
                    style={{ width: `${(segment.count / tickets.total) * 100}%` }}
                  />
                ))}
              </View>
              <Text className="mb-1 text-xs text-foreground-muted">
                {tickets.segments
                  .map((segment) => `${segment.count} ${segment.label.toLowerCase()}`)
                  .join(" · ")}
              </Text>
              {detail.tickets.map((ticket) => (
                <ItemLine key={ticket.number} item={ticket} />
              ))}
              {tickets.more > 0 ? (
                <Text className="text-xs text-foreground-muted">+{tickets.more} more</Text>
              ) : null}
            </>
          ) : (
            <Text className="text-sm text-foreground-muted">No Tickets</Text>
          )}
        </Section>
      ) : null}
      {detail.kind === "spec" && detail.governedBy.length > 0 ? (
        <Section title="Decisions">
          {detail.governedBy.map((decision) => (
            <ItemLine key={decision.number} item={decision} />
          ))}
        </Section>
      ) : null}

      {detail.kind === "ticket" ? (
        <>
          {item.waits.length > 0 ? (
            <Section title="Blocked by">
              {item.waits.map((blocker) => (
                <ItemLine key={blocker.number} item={blocker} />
              ))}
            </Section>
          ) : null}
          <Section title="Delivery">
            <Text className="text-sm text-foreground">
              {detail.latestAttempt
                ? `${detail.attempts} ${detail.attempts === 1 ? "attempt" : "attempts"} · latest ${detail.latestAttempt.status} ${relativeTime(detail.latestAttempt.at)} ago`
                : "No attempts yet"}
            </Text>
            {detail.lastFailure ? (
              <Text className="mt-1 text-sm text-foreground-muted" numberOfLines={3}>
                Last failure · {detail.lastFailure.stage}: {detail.lastFailure.cause}
              </Text>
            ) : null}
          </Section>
        </>
      ) : null}

      <View className="mt-5 border-t border-border pt-3">
        {session && threadLink ? (
          <SessionThreadLink
            link={threadLink}
            role={detail.kind === "spec" ? "Lead" : "Worker"}
            activity={session.activity}
          />
        ) : (
          <Text className="text-xs text-foreground-muted">
            {session
              ? `${detail.kind === "spec" ? "Lead" : "Worker"}: ${buildSessionLabel(session)}`
              : detail.kind === "spec"
                ? "No lead thread"
                : "No thread working on it"}
          </Text>
        )}
        <Text className="mt-1 text-xs text-foreground-muted">
          {card.unavailable
            ? `Build couldn't be reached · updated ${relativeTime(card.readAt)} ago`
            : `Updated ${relativeTime(card.updatedAt)} ago`}
        </Text>
      </View>
    </View>
  );
}

/**
 * The thread's linked Build item as a sheet: mobile's form of the web hover card. It reads the
 * card only while open, and re-reads it once a minute.
 */
export function ThreadForgeItemSheet({ route }: StaticScreenProps<ForgeItemTarget>) {
  const target = route.params;
  const { layout } = useAdaptiveWorkspaceLayout();
  const navigation = useNavigation();
  const insets = useSafeAreaInsets();
  const theme = useUniwindTheme();
  // One opening per time the sheet is shown, so showing it reads Build at once.
  const [opening] = useState(uuidv4);
  // A mention's chat text already read this, so it answers from the same query at once.
  const mention = useEnvironmentQuery(
    target.itemId === undefined
      ? forgeWorkItems.mentions({
          environmentId: target.environmentId,
          input: { threadId: target.threadId, numbers: [target.number] },
        })
      : null,
  );
  const itemId =
    target.itemId ?? mention.data?.items.find((found) => found.number === target.number)?.itemId;
  const unknown = target.itemId === undefined && mention.data !== null && itemId === undefined;
  const unreachable = mention.data?.unavailable === true;
  const cardQuery = useEnvironmentQuery(
    itemId === undefined
      ? null
      : forgeWorkItems.card({
          environmentId: target.environmentId,
          input: { threadId: target.threadId, itemId, open: opening },
        }),
  );
  const title = `Build ${forgeItemLabel({ number: target.number, ref: cardQuery.data?.item.ref })}`;

  const content = (
    <ScrollView
      className="flex-1"
      contentInsetAdjustmentBehavior={Platform.OS === "ios" ? "automatic" : "never"}
      contentContainerClassName="px-5 pt-2"
      contentContainerStyle={{ paddingBottom: Math.max(insets.bottom, 16) + 8 }}
    >
      {cardQuery.data ? (
        <CardBody card={cardQuery.data} />
      ) : (
        <Text className="pt-6 text-center text-sm text-foreground-muted">
          {cardQuery.error !== null || mention.error !== null || (unknown && unreachable)
            ? "Build couldn't be reached."
            : unknown
              ? `Build has no item #${target.number} you can see.`
              : "Reading Build…"}
        </Text>
      )}
      <View className="mt-6">
        <Button
          label="Open in Weave"
          icon="safari"
          fullWidth
          onPress={() => void Linking.openURL(target.url).catch(() => undefined)}
        />
      </View>
    </ScrollView>
  );

  if (Platform.OS === "ios") {
    // A plain formSheet screen never renders a stack header, so it comes from a nested native
    // stack inside the sheet, as in the agents sheet.
    return (
      <View collapsable={false} className="flex-1 bg-sheet">
        <ScreenStack style={{ flex: 1 }}>
          <Screen
            activityState={2}
            enabled
            isNativeStack
            screenId="thread-build-item-sheet-native"
            scrollEdgeEffects={HEADER_SCROLL_EDGE_EFFECTS}
            style={{ backgroundColor: theme["--color-sheet"], flex: 1 }}
          >
            {content}
            <ScreenStackHeaderConfig
              backgroundColor="rgba(0,0,0,0)"
              color={theme["--color-foreground"]}
              hideBackButton
              hideShadow={false}
              title={title}
              titleColor={theme["--color-foreground"]}
              titleFontSize={18}
              titleFontWeight="800"
              translucent
            />
          </Screen>
        </ScreenStack>
      </View>
    );
  }

  return (
    <View collapsable={false} className="flex-1 bg-sheet">
      <NativeStackScreenOptions options={{ sheetCornerRadius: 28 }} />
      <AndroidSheetHeader title={title} onBack={() => navigation.goBack()} />
      <ScreenContent insetHorizontal={layout.usesSplitView}>{content}</ScreenContent>
    </View>
  );
}
