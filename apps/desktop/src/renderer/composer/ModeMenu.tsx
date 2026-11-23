import type { PermissionMode } from "@dawg/protocol";
import { DropdownMenu } from "radix-ui";
import menu from "../app/menu.module.css";
import { MODE_INFO, MODE_ORDER, type ModeTone } from "../lib/modes.ts";
import { Icon, Kbd } from "../ui/index.ts";
import styles from "./Composer.module.css";
import { MenuOption } from "./MenuOption.tsx";

const TONE_CLASS: Record<ModeTone, string | undefined> = {
  neutral: undefined,
  accent: styles.toneAccent,
  blue: styles.toneBlue,
  amber: styles.toneAmber,
  red: styles.toneRed,
};

function isMode(value: string): value is PermissionMode {
  return (MODE_ORDER as readonly string[]).includes(value);
}

/** The permission-mode pill and its menu. ⇧⇥ in the textarea cycles the common modes. */
export function ModeMenu(props: {
  mode: PermissionMode;
  disabled?: boolean;
  onSetMode(mode: PermissionMode): void;
}) {
  const info = MODE_INFO[props.mode];
  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger asChild disabled={props.disabled}>
        <button
          type="button"
          className={`${styles.pill} ${TONE_CLASS[info.tone] ?? ""}`}
          aria-label={`Permission mode: ${info.label}`}
        >
          <Icon name="shield" size={14} />
          {info.label}
          <Kbd>⇧⇥</Kbd>
        </button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content
          className={`${menu.content} ${menu.medium}`}
          side="top"
          align="start"
          sideOffset={8}
        >
          <DropdownMenu.Label className={menu.label}>Permission mode</DropdownMenu.Label>
          <DropdownMenu.RadioGroup
            value={props.mode}
            onValueChange={(value) => {
              if (isMode(value) && value !== props.mode) props.onSetMode(value);
            }}
          >
            {MODE_ORDER.map((mode) => (
              <MenuOption
                key={mode}
                value={mode}
                title={MODE_INFO[mode].label}
                description={MODE_INFO[mode].description}
              />
            ))}
          </DropdownMenu.RadioGroup>
          <div className={menu.footer}>
            <Kbd>⇧⇥</Kbd> cycles through the modes
          </div>
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}
