import { DropdownMenu } from "radix-ui";
import type { ModelOption } from "../../shared/bridge.ts";
import menu from "../app/menu.module.css";
import { Icon } from "../ui/index.ts";
import styles from "./Composer.module.css";
import { MenuOption } from "./MenuOption.tsx";

export interface ModelMenuProps {
  current: { id: string | null; label: string };
  models: readonly ModelOption[];
  /** The model loaded in the bundled runtime, if any. Only one runs at a time. */
  loadedModelId?: string | null;
  disabled?: boolean;
  onSetModel(id: string): void;
  onManageModels(): void;
}

/**
 * The line under a model's name. The bundled runtime holds one model at a time, so a bundled
 * model other than the loaded one says that switching to it reloads the model.
 */
function optionLine(model: ModelOption, loadedModelId: string | null | undefined): string {
  const anotherLoaded = loadedModelId != null && loadedModelId !== model.id;
  if (model.source !== "bundled" || !anotherLoaded || /reload/i.test(model.description)) {
    return model.description;
  }
  return `${model.description} · switching reloads the model`;
}

/** The model pill and its menu: models on this Mac, then models on servers. */
export function ModelMenu(props: ModelMenuProps) {
  const loaded = props.models.find((model) => model.id === props.loadedModelId);
  const loadedBundled = loaded?.source === "bundled" ? loaded.id : null;
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
                  description={optionLine(model, loadedBundled)}
                />
              ))}
            </DropdownMenu.RadioGroup>
          ))}
          <DropdownMenu.Item
            className={`${menu.item} ${menu.footerItem}`}
            onSelect={props.onManageModels}
          >
            Manage models…
          </DropdownMenu.Item>
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}
