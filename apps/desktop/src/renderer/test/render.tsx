/**
 * Helpers for component tests. Every component is tested in both themes, dark first:
 *
 *   describe.each(THEMES)("PermissionCard (%s)", (theme) => {
 *     it("allows once", async () => {
 *       renderInTheme(<PermissionCard ... />, theme);
 *       ...
 *     });
 *   });
 */
import { type RenderOptions, type RenderResult, render } from "@testing-library/react";
import type { ReactElement } from "react";
import type { ResolvedTheme } from "../../shared/bridge.ts";

/** Dark first, as designs are shown. */
export const THEMES: readonly ResolvedTheme[] = ["dark", "light"];

/** Sets `<html data-theme>` (as the app shell does) and renders. */
export function renderInTheme(
  ui: ReactElement,
  theme: ResolvedTheme,
  options?: Omit<RenderOptions, "queries">,
): RenderResult {
  document.documentElement.dataset.theme = theme;
  return render(ui, options);
}
