import { Linking, Platform, Pressable, View } from "react-native";

import { AppText as Text } from "../../components/ui/AppText";

/**
 * The thread header's title with its linked Build item as the subtitle. Native header
 * subtitles cannot be pressed, so a linked thread draws its own title view; tapping the
 * subtitle opens the item in HQ.
 */
export function ThreadBuildHeaderTitle(props: {
  readonly title: string;
  readonly subtitle: string;
  readonly url: string;
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
        accessibilityRole="link"
        accessibilityHint="Opens the Build item in HQ"
        hitSlop={6}
        onPress={() => void Linking.openURL(props.url).catch(() => undefined)}
      >
        <Text className="text-foreground-muted" numberOfLines={1} style={{ fontSize: 12 }}>
          {props.subtitle}
        </Text>
      </Pressable>
    </View>
  );
}
