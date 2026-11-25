import { PROVIDER_DISPLAY_NAMES, type ServerProvider } from "@t3tools/contracts";
import { T, useGT } from "gt-react";

import { Toggle, ToggleGroup } from "../ui/toggle-group";
import { ScopedSwitch } from "./ScopedSwitch";
import { SettingsRow, SettingResetButton } from "./settingsLayout";
import { useSearchableSetting } from "./settingsSearch";
import { useScopedSettings, useUpdateScopedSettings } from "./useScopedSettings";

/** Pi threads keep the pi-blackhole extension, so T3's Blackhole settings never reach them. */
const EXTENSION_DRIVER = "pi";

/** T3's Blackhole compaction and memory for every harness but Pi (fork: T3-916). */
export function BlackholeSettings(props: { readonly providers: ReadonlyArray<ServerProvider> }) {
  const gt = useGT();
  const setting = useSearchableSetting();
  const settings = useScopedSettings();
  const updateSettings = useUpdateScopedSettings();
  const { compaction, memory, memoryOffDrivers } = settings.blackhole;
  const drivers = [
    ...new Set(
      props.providers
        .filter((provider) => provider.enabled && provider.driver !== EXTENSION_DRIVER)
        .map((provider) => provider.driver),
    ),
  ];

  return (
    <>
      <SettingsRow
        serverScoped
        settingKeys={["blackhole"]}
        {...setting("blackhole-compaction")}
        description={gt(
          "At a thread's compact point, start a fresh session from Blackhole's summary of the conversation. The harness's own compaction stays as a later backstop. Pi threads use the pi-blackhole extension instead.",
        )}
        resetAction={
          compaction ? null : (
            <SettingResetButton
              ariaLabel={gt("Reset Blackhole compaction to default")}
              onClick={() => updateSettings({ blackhole: { compaction: true } })}
            />
          )
        }
        control={
          <ScopedSwitch
            settingKeys={["blackhole"]}
            checked={compaction}
            onCheckedChange={(checked) =>
              updateSettings({ blackhole: { compaction: Boolean(checked) } })
            }
            aria-label={gt("Blackhole compaction")}
          />
        }
      />
      <SettingsRow
        serverScoped
        settingKeys={["blackhole"]}
        {...setting("blackhole-memory")}
        description={gt(
          "As a thread grows, the utility model notes what matters and carries it through each compaction. Turning it off keeps compaction.",
        )}
        resetAction={
          memory && memoryOffDrivers.length === 0 ? null : (
            <SettingResetButton
              ariaLabel={gt("Reset Blackhole memory to default")}
              onClick={() => updateSettings({ blackhole: { memory: true, memoryOffDrivers: [] } })}
            />
          )
        }
        control={
          <ScopedSwitch
            settingKeys={["blackhole"]}
            checked={memory}
            onCheckedChange={(checked) =>
              updateSettings({ blackhole: { memory: Boolean(checked) } })
            }
            aria-label={gt("Blackhole memory")}
          />
        }
      >
        {memory && drivers.length > 0 ? (
          <div className="flex flex-wrap items-center gap-2 pb-3.5">
            <span className="text-xs text-muted-foreground">
              <T>Remembers on</T>
            </span>
            <ToggleGroup
              aria-label={gt("Providers that run Blackhole memory")}
              multiple
              value={drivers.filter((driver) => !memoryOffDrivers.includes(driver))}
              onValueChange={(value: ReadonlyArray<string>) =>
                updateSettings({
                  blackhole: {
                    // Drivers not listed now (a disabled provider) keep their choice.
                    memoryOffDrivers: [
                      ...memoryOffDrivers.filter(
                        (driver) => !drivers.some((listed) => listed === driver),
                      ),
                      ...drivers.filter((driver) => !value.includes(String(driver))),
                    ],
                  },
                })
              }
            >
              {drivers.map((driver) => (
                <Toggle key={driver} value={driver}>
                  {PROVIDER_DISPLAY_NAMES[driver] ?? driver}
                </Toggle>
              ))}
            </ToggleGroup>
          </div>
        ) : null}
      </SettingsRow>
    </>
  );
}
