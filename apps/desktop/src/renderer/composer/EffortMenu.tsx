import { DropdownMenu } from "radix-ui";
import menu from "../app/menu.module.css";
import { EFFORT_INFO } from "../lib/modes.ts";
import type { EffortView } from "../state/types.ts";
import { Icon } from "../ui/index.ts";
import styles from "./Composer.module.css";
import { MenuOption } from "./MenuOption.tsx";

/** Radix radio values are strings; this one stands for "no effort set" (null). */
const MODEL_DEFAULT = "model-default";

/** The reasoning-effort pill and its menu. Not shown when the model reports no levels. */
export function EffortMenu(props: {
  effort: EffortView;
  modelLabel: string;
  disabled?: boolean;
  onSetEffort(effort: string | null): void;
}) {
  const { value, levels } = props.effort;
  if (levels.length === 0) return null;
  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger asChild disabled={props.disabled}>
        <button type="button" className={styles.pill}>
          Effort: {value ?? "default"}
          <Icon name="chevron-down" size={12} />
        </button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content
          className={`${menu.content} ${menu.medium}`}
          side="top"
          align="start"
          sideOffset={8}
        >
          <DropdownMenu.Label className={menu.label}>
            Reasoning effort · {props.modelLabel}
          </DropdownMenu.Label>
          <DropdownMenu.RadioGroup
            value={value ?? MODEL_DEFAULT}
            onValueChange={(next) => {
              const effort = next === MODEL_DEFAULT ? null : next;
              if (effort !== value) props.onSetEffort(effort);
            }}
          >
            <MenuOption
              value={MODEL_DEFAULT}
              title="Model default"
              description="Uses the model’s own default level"
            />
            {levels.map((level) => (
              <MenuOption
                key={level}
                value={level}
                title={level}
                description={EFFORT_INFO[level]}
              />
            ))}
          </DropdownMenu.RadioGroup>
          <div className={menu.footer}>
            Levels come from the model. Lower effort answers sooner.
          </div>
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}
