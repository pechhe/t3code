import { Platform, Pressable, View } from "react-native";

import { AppText as Text } from "../../components/ui/AppText";

/**
 * The thread header's title with its linked Build item as the subtitle. Native header
 * subtitles cannot be pressed, so a linked thread draws its own title view; tapping the
 * subtitle opens the item's card.
 */
export function ThreadForgeHeaderTitle(props: {
  readonly title: string;
  readonly subtitle: string;
  readonly onOpenItem: () => void;
}) {
  return (
    <View style={{ alignItems: Platform.OS === "ios" ? "center" : "flex-start", minWidth: 0 }}>
      <Text
        className="font-t3-bold text-foreground"
        numberOfLines={1}
        style={{ fontSize: 17, fontWeight: "800" }}
      >
        {props.title}
      </Text>
      <Pressable
        accessibilityRole="button"
        accessibilityHint="Shows the Build item"
        hitSlop={6}
        onPress={props.onOpenItem}
      >
        <Text className="text-foreground-muted" numberOfLines={1} style={{ fontSize: 12 }}>
          {props.subtitle}
        </Text>
      </Pressable>
    </View>
  );
}
