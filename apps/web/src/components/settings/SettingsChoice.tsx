import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";

export function SettingsChoice({
  label,
  value,
  values,
  disabled,
  onChange,
}: {
  label: string;
  value: string;
  values: ReadonlyArray<{ value: string; label: string }>;
  disabled?: boolean;
  onChange: (value: string) => void;
}) {
  return (
    <Select
      value={value}
      disabled={disabled ?? false}
      onValueChange={(next) => {
        if (next !== null) onChange(next);
      }}
    >
      <SelectTrigger size="sm" aria-label={label}>
        <SelectValue>{values.find((item) => item.value === value)?.label ?? value}</SelectValue>
      </SelectTrigger>
      <SelectPopup>
        {values.map((item) => (
          <SelectItem key={item.value} value={item.value}>
            {item.label}
          </SelectItem>
        ))}
      </SelectPopup>
    </Select>
  );
}
