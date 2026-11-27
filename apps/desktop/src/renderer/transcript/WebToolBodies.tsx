/**
 * The open bodies of WebFetch and WebSearch cards, from their displays (`web-fetch`,
 * `web-search` in @dawg/protocol): the page fetched (address, status, size, a short preview) or
 * the redirect reported instead, and a search's results as links. Every link goes through
 * SafeLink, which shows the full address and asks before opening it in the system browser.
 */
import type { WebFetchDisplay, WebSearchDisplay } from "@dawg/protocol";
import { formatBytes } from "../lib/format.ts";
import { OpenLinkContext, SafeLink } from "../markdown/SafeLink.tsx";
import type { TranscriptEnv } from "./env.ts";
import { OutputLines } from "./OutputLines.tsx";
import cardStyles from "./ToolCard.module.css";
import styles from "./WebToolBodies.module.css";

function WebFetchBody({ display }: { display: WebFetchDisplay }) {
  if (display.redirectUrl !== null) {
    return (
      <div className={styles.facts}>
        <p className={styles.line}>
          <SafeLink href={display.url}>{display.url}</SafeLink> redirects ({display.status}) to
          another host:
        </p>
        <p className={styles.line}>
          <SafeLink href={display.redirectUrl}>{display.redirectUrl}</SafeLink>
        </p>
        <p className={cardStyles.placeholder}>
          Not followed. The model was told, and fetches it only by asking again.
        </p>
      </div>
    );
  }
  const facts = [
    `${display.status}`,
    display.contentType || "no type",
    formatBytes(display.bytes),
    `${display.chars.toLocaleString("en-US")} characters`,
  ];
  return (
    <>
      <div className={styles.facts}>
        <p className={styles.line}>
          <SafeLink href={display.url}>{display.url}</SafeLink>
        </p>
        <p className={styles.meta}>{facts.join(" · ")}</p>
        <p className={styles.meta}>
          {display.answeredBy === "model"
            ? "The utility model read the page and answered the prompt."
            : "The page text was given to the model."}
          {display.cached ? " From the 15-minute cache." : ""}
        </p>
      </div>
      {display.preview === "" ? (
        <div className={cardStyles.placeholder}>No readable text.</div>
      ) : (
        <>
          <div className={cardStyles.section}>Preview</div>
          <OutputLines
            text={display.chars > display.preview.length ? `${display.preview}…` : display.preview}
            label="Preview"
            className={`${cardStyles.output} ${cardStyles.wrap}`}
          />
        </>
      )}
    </>
  );
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

function WebSearchBody({ display }: { display: WebSearchDisplay }) {
  if (display.results.length === 0) {
    return <div className={cardStyles.placeholder}>No results from {display.provider}.</div>;
  }
  return (
    <>
      <div className={cardStyles.section}>Results from {display.provider}</div>
      <ol className={styles.results} aria-label={`Results from ${display.provider}`}>
        {display.results.map((result) => (
          <li key={result.url} className={styles.result}>
            <SafeLink href={result.url}>{result.title}</SafeLink>
            <span className={styles.host}>{hostOf(result.url)}</span>
            {result.snippet !== "" && <span className={styles.snippet}>{result.snippet}</span>}
          </li>
        ))}
      </ol>
    </>
  );
}

/** The body for a finished WebFetch or WebSearch call that carries its display. */
export function WebToolBody({
  display,
  env,
}: {
  display: WebFetchDisplay | WebSearchDisplay;
  env: TranscriptEnv;
}) {
  return (
    <OpenLinkContext.Provider value={env.openLink}>
      {display.kind === "web-fetch" ? (
        <WebFetchBody display={display} />
      ) : (
        <WebSearchBody display={display} />
      )}
    </OpenLinkContext.Provider>
  );
}
