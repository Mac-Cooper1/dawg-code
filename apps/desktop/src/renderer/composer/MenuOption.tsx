import { DropdownMenu } from "radix-ui";
import menu from "../app/menu.module.css";
import { Icon } from "../ui/index.ts";

/**
 * A choice in one of the composer's pickers: a check while it is the current one, its name in
 * bold and a line under it (mockup .mi). A menuitemradio, so VoiceOver reads which is checked.
 */
export function MenuOption(props: { value: string; title: string; description?: string }) {
  return (
    <DropdownMenu.RadioItem value={props.value} className={menu.item}>
      <span className={menu.check}>
        <DropdownMenu.ItemIndicator>
          <Icon name="check" size={14} />
        </DropdownMenu.ItemIndicator>
      </span>
      <span className={menu.text}>
        <span className={menu.title}>{props.title}</span>
        {props.description && <span className={menu.description}>{props.description}</span>}
      </span>
    </DropdownMenu.RadioItem>
  );
}
