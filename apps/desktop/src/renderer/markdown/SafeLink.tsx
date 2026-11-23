import { Popover } from "radix-ui";
import { createContext, type ReactNode, useContext, useState } from "react";
import { Button } from "../ui/index.ts";
import styles from "./SafeLink.module.css";

/**
 * Who opens links from model output. Provided by `<Markdown>` so the components it hands to
 * react-markdown can stay module constants (new component types on every render would remount
 * every link and close an open confirmation while a reply streams).
 */
export const OpenLinkContext = createContext<(url: string) => void>(() => {});

/** The URL when it is an absolute http(s) URL, otherwise null. Only those may leave the app. */
export function openableUrl(href: string | null | undefined): string | null {
  if (!href) return null;
  try {
    const url = new URL(href);
    return url.protocol === "http:" || url.protocol === "https:" ? url.href : null;
  } catch {
    return null;
  }
}

/**
 * A link from model output. It never navigates: clicking shows the full URL and asks before
 * opening it in the browser, so a misleading label cannot send the person somewhere unexpected.
 * Anything but http(s) renders as plain text.
 */
export function SafeLink({
  href,
  children,
}: {
  href: string | null | undefined;
  children: ReactNode;
}) {
  const onOpenLink = useContext(OpenLinkContext);
  const [open, setOpen] = useState(false);
  const url = openableUrl(href);
  if (url === null) return <span className={styles.plain}>{children}</span>;
  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger asChild>
        <button type="button" className={styles.link} title={url}>
          {children}
        </button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          className={styles.popover}
          side="top"
          align="start"
          sideOffset={6}
          collisionPadding={12}
          aria-label="Open link"
        >
          <p className={styles.question}>
            Open <span className={styles.url}>{url}</span> in your browser?
          </p>
          <div className={styles.actions}>
            <Button
              size="sm"
              variant="primary"
              onClick={() => {
                setOpen(false);
                onOpenLink(url);
              }}
            >
              Open
            </Button>
            <Popover.Close asChild>
              <Button size="sm" variant="ghost">
                Cancel
              </Button>
            </Popover.Close>
          </div>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}
