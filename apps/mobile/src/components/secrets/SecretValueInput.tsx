import * as Clipboard from "expo-clipboard";
import { useState } from "react";
import { View } from "react-native";
import { AppText as Text } from "../ui/AppText";
import { Button } from "../ui/Button";
import { SecretTextInput } from "../ui/SecretTextInput";
import type { SecretTextInputProps } from "../ui/SecretTextInput.types";

export function SecretValueInput(props: SecretTextInputProps) {
  const [failed, setFailed] = useState(false);
  const multiline = /[\r\n]/.test(props.value);
  return (
    <View className="gap-2">
      {multiline ? (
        <>
          <Text>••••••••••••</Text>
          <Text className="text-xs text-foreground-muted">Multiline value pasted.</Text>
          <Button
            label="Clear pasted value"
            tone="text"
            disabled={!props.editable}
            onPress={() => props.onChangeText("")}
          />
        </>
      ) : (
        <SecretTextInput {...props} />
      )}
      <Button
        label="Paste from clipboard"
        tone="text"
        disabled={!props.editable}
        onPress={() => {
          setFailed(false);
          void Clipboard.getStringAsync()
            .then((value) => props.onChangeText(value))
            .catch(() => setFailed(true));
        }}
      />
      {failed ? <Text accessibilityRole="alert">Could not read the clipboard.</Text> : null}
    </View>
  );
}
