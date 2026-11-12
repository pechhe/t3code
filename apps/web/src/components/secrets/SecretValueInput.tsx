import type { ComponentProps } from "react";
import { Input } from "../ui/input";
import { Button } from "../ui/button";

type Props = Omit<ComponentProps<typeof Input>, "value" | "onChange" | "type"> & {
  readonly value: string;
  readonly onValueChange: (value: string) => void;
};

export function SecretValueInput({ value, onValueChange, ...props }: Props) {
  const multiline = /[\r\n]/.test(value);
  return (
    <div className="space-y-2">
      <Input
        {...props}
        type="password"
        value={multiline ? "••••••••" : value}
        readOnly={multiline}
        autoComplete="off"
        data-1p-ignore
        data-lpignore
        data-bwignore
        onChange={(event) => {
          if (!multiline) onValueChange(event.currentTarget.value);
        }}
        onPaste={(event) => {
          if (multiline) {
            event.preventDefault();
            return;
          }
          const pasted = event.clipboardData.getData("text");
          if (!/[\r\n]/.test(pasted)) return;
          event.preventDefault();
          const { selectionStart, selectionEnd } = event.currentTarget;
          onValueChange(
            value.slice(0, selectionStart ?? 0) +
              pasted +
              value.slice(selectionEnd ?? value.length),
          );
        }}
      />
      {multiline ? (
        <div className="flex items-center gap-2">
          <p className="text-xs text-muted-foreground">Multiline value pasted.</p>
          <Button
            type="button"
            size="xs"
            variant="outline"
            disabled={props.disabled}
            onClick={() => onValueChange("")}
          >
            Clear pasted value
          </Button>
        </div>
      ) : null}
    </div>
  );
}
