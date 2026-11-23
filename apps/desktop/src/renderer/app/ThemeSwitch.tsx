import type { ResolvedTheme } from "../../shared/bridge.ts";
import { IconButton } from "../ui/index.ts";

/**
 * The title bar's moon / sun button. It switches to the opposite of what is showing and saves
 * that as the appearance (so it also leaves "Match macOS"). The icon shows where it goes: a sun
 * while dark, a moon while light.
 */
export function ThemeSwitch(props: {
  theme: ResolvedTheme;
  onSetAppearance(appearance: ResolvedTheme): void;
}) {
  const next: ResolvedTheme = props.theme === "dark" ? "light" : "dark";
  return (
    <IconButton
      icon={props.theme === "dark" ? "sun" : "moon"}
      label={`Switch to ${next} appearance`}
      onClick={() => props.onSetAppearance(next)}
    />
  );
}
