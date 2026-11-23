import { DropdownMenu } from "radix-ui";
import type { ModelOption } from "../../shared/bridge.ts";
import menu from "../app/menu.module.css";
import { Icon } from "../ui/index.ts";
import styles from "./Composer.module.css";
import { MenuOption } from "./MenuOption.tsx";

export interface ModelMenuProps {
  current: { id: string | null; label: string };
  models: readonly ModelOption[];
  disabled?: boolean;
  onSetModel(id: string): void;
  onManageModels(): void;
}

/** The model pill and its menu: models on this Mac, then models on servers. */
export function ModelMenu(props: ModelMenuProps) {
  const groups = [
    { label: "On this Mac", models: props.models.filter((model) => model.source === "bundled") },
    { label: "Servers", models: props.models.filter((model) => model.source === "server") },
  ].filter((group) => group.models.length > 0);

  const choose = (id: string) => {
    if (id !== props.current.id) props.onSetModel(id);
  };

  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger asChild disabled={props.disabled}>
        <button type="button" className={styles.pill} aria-label={`Model: ${props.current.label}`}>
          <Icon name="model" size={14} />
          {props.current.label}
          <Icon name="chevron-down" size={12} />
        </button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content
          className={`${menu.content} ${menu.wide}`}
          side="top"
          align="start"
          sideOffset={8}
        >
          {groups.length === 0 && <div className={menu.label}>No models yet</div>}
          {groups.map((group) => (
            <DropdownMenu.RadioGroup
              key={group.label}
              value={props.current.id ?? ""}
              onValueChange={choose}
            >
              <DropdownMenu.Label className={menu.label}>{group.label}</DropdownMenu.Label>
              {group.models.map((model) => (
                <MenuOption
                  key={model.id}
                  value={model.id}
                  title={model.label}
                  description={model.description}
                />
              ))}
            </DropdownMenu.RadioGroup>
          ))}
          <DropdownMenu.Item
            className={`${menu.item} ${menu.footerItem}`}
            onSelect={props.onManageModels}
          >
            Manage models and servers…
          </DropdownMenu.Item>
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}
