import { type ButtonHTMLAttributes, forwardRef, type ReactNode } from "react";
import { Icon, type IconName } from "./Icon.tsx";
import { Kbd } from "./Kbd.tsx";
import styles from "./ui.module.css";

/** "danger" is red text; "destructive" fills red, for the button that confirms a deletion. */
export type ButtonVariant = "default" | "primary" | "ghost" | "danger" | "destructive";
export type ButtonSize = "sm" | "md" | "lg";

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  /** An icon before the label. */
  icon?: IconName;
  /** A keyboard hint after the label, for example "⏎" or "⌘⏎". */
  kbd?: string;
  children?: ReactNode;
}

function cx(...names: (string | false | null | undefined)[]): string {
  return names.filter(Boolean).join(" ");
}

/** A text button. `type` defaults to "button". */
export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = "default", size = "md", icon, kbd, className, children, type = "button", ...rest },
  ref,
) {
  return (
    <button
      ref={ref}
      type={type}
      className={cx(
        styles.button,
        variant === "primary" && styles.primary,
        variant === "ghost" && styles.ghost,
        variant === "danger" && styles.danger,
        variant === "destructive" && styles.destructive,
        size === "sm" && styles.sm,
        size === "lg" && styles.lg,
        className,
      )}
      {...rest}
    >
      {icon && <Icon name={icon} size={size === "sm" ? 14 : 16} />}
      {children}
      {kbd && <Kbd>{kbd}</Kbd>}
    </button>
  );
});

export interface IconButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  icon: IconName;
  /** Required: the accessible name, also shown as the tooltip. */
  label: string;
  /** Shows the pressed/hover background, for toggles. */
  active?: boolean;
  size?: "sm" | "md";
}

/** A square icon-only button (30 px, or 24 px when small). */
export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(function IconButton(
  { icon, label, active, size = "md", className, type = "button", ...rest },
  ref,
) {
  return (
    <button
      ref={ref}
      type={type}
      aria-label={label}
      title={label}
      data-active={active ? "true" : undefined}
      className={cx(styles.iconButton, size === "sm" && styles.iconButtonSmall, className)}
      {...rest}
    >
      <Icon name={icon} size={size === "sm" ? 14 : 16} />
    </button>
  );
});
