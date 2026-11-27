/**
 * Settings → Web: what the two web tools do, and the search service WebSearch uses. WebFetch
 * needs no setup. WebSearch has no service of its own, so the person picks one and gives it their
 * own key (Brave Search, Tavily) or an address (SearXNG). Keys go to main, which keeps them in the
 * Keychain and never sends them back; the page only learns whether one is stored. Talks to main
 * through `web` on the bridge (src/main/web/service.ts).
 */
import { RadioGroup } from "radix-ui";
import { type FormEvent, useEffect, useId, useState } from "react";
import {
  type DawgBridge,
  type KeyedSearchProvider,
  type SearchProviderId,
  ServerUrlSchema,
  type WebSettingsState,
} from "../../shared/bridge.ts";
import { Button, Icon, Tag } from "../ui/index.ts";
import settingsStyles from "./Settings.module.css";
import styles from "./WebPage.module.css";

type Choice = SearchProviderId | "off";

interface ChoiceInfo {
  value: Choice;
  title: string;
  description: string;
  /** Where to get a key or learn more. */
  site?: { label: string; url: string };
  /** The one dawg suggests, chosen by the project owner (Phase 4 spec, Web tools). */
  suggested?: boolean;
}

const CHOICES: readonly ChoiceInfo[] = [
  { value: "off", title: "Off", description: "The model is not offered web search." },
  {
    value: "brave",
    title: "Brave Search",
    description: "An independent search index, with a free plan. Uses your own API key.",
    suggested: true,
    site: { label: "Get a Brave Search key", url: "https://brave.com/search/api/" },
  },
  {
    value: "tavily",
    title: "Tavily",
    description: "A search API made for agents. Uses your own API key.",
    site: { label: "Get a Tavily key", url: "https://tavily.com" },
  },
  {
    value: "searxng",
    title: "SearXNG",
    description: "A SearXNG instance you run or trust, with its JSON format switched on.",
    site: { label: "About SearXNG", url: "https://docs.searxng.org" },
  },
];

const LABEL: Record<SearchProviderId, string> = {
  brave: "Brave Search",
  tavily: "Tavily",
  searxng: "SearXNG",
};

const isKeyed = (choice: Choice): choice is KeyedSearchProvider =>
  choice === "brave" || choice === "tavily";

type Outcome = { tone: "error" | "success"; text: string } | null;

export interface WebPageProps {
  api: DawgBridge["web"];
  /** Opens a link in the system browser. */
  onOpenLink(url: string): void;
}

function ChoiceOption(props: ChoiceInfo & { hasKey: boolean }) {
  const titleId = useId();
  const descriptionId = useId();
  return (
    <RadioGroup.Item
      value={props.value}
      className={settingsStyles.option}
      aria-labelledby={titleId}
      aria-describedby={descriptionId}
    >
      <span className={settingsStyles.radio} aria-hidden="true" />
      <span className={settingsStyles.optionText}>
        <span id={titleId} className={`${settingsStyles.optionTitle} ${styles.optionTitle}`}>
          {props.title}
          {props.suggested === true && <Tag tone="accent">Suggested</Tag>}
          {props.hasKey && <Tag tone="neutral">Key in your Keychain</Tag>}
        </span>
        <span id={descriptionId} className={settingsStyles.optionDescription}>
          {props.description}
        </span>
      </span>
    </RadioGroup.Item>
  );
}

export function WebPage(props: WebPageProps) {
  const { api } = props;
  const keyId = useId();
  const urlId = useId();
  const outcomeId = useId();
  const [state, setState] = useState<WebSettingsState | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [choice, setChoice] = useState<Choice>("off");
  const [apiKey, setApiKey] = useState("");
  const [url, setUrl] = useState("");
  const [busy, setBusy] = useState<"save" | "check" | "remove" | null>(null);
  const [outcome, setOutcome] = useState<Outcome>(null);

  useEffect(() => {
    let live = true;
    api.read().then(
      (next) => {
        if (!live) return;
        setState(next);
        setChoice(next.provider ?? "off");
        setUrl(next.searxngUrl ?? "");
      },
      (error: unknown) => {
        if (live) setLoadError(error instanceof Error ? error.message : String(error));
      },
    );
    return () => {
      live = false;
    };
  }, [api]);

  const hasKey = state !== null && isKeyed(choice) && state.keys[choice];
  const keyTyped = apiKey.trim();
  const urlTyped = url.trim();
  const saved = state?.provider ?? "off";
  const changed =
    choice !== saved ||
    keyTyped !== "" ||
    (choice === "searxng" && urlTyped !== (state?.searxngUrl ?? ""));

  const run = async (kind: "save" | "check" | "remove", work: () => Promise<Outcome>) => {
    if (busy !== null) return;
    setBusy(kind);
    setOutcome(null);
    try {
      setOutcome(await work());
    } catch (error) {
      setOutcome({ tone: "error", text: error instanceof Error ? error.message : String(error) });
    } finally {
      setBusy(null);
    }
  };

  /** What the form says is missing before anything is sent, or null. */
  const missing = (forCheck: boolean): string | null => {
    if (choice === "searxng" && !ServerUrlSchema.safeParse(urlTyped).success) {
      return "Enter the instance's http or https address, such as http://localhost:8888.";
    }
    if (isKeyed(choice) && keyTyped === "" && !hasKey) {
      return `Enter your ${LABEL[choice]} API key${forCheck ? " to check it" : ""}.`;
    }
    return null;
  };

  const save = (event: FormEvent) => {
    event.preventDefault();
    const problem = choice === "off" ? null : missing(false);
    if (problem !== null) {
      setOutcome({ tone: "error", text: problem });
      return;
    }
    void run("save", async () => {
      const next = await api.write({
        provider: choice === "off" ? null : choice,
        ...(isKeyed(choice) && keyTyped !== "" ? { apiKey: keyTyped } : {}),
        ...(choice === "searxng" ? { searxngUrl: urlTyped } : {}),
      });
      setState(next);
      setApiKey("");
      return {
        tone: "success",
        text:
          next.provider === null
            ? "Saved. New sessions are not offered web search."
            : `Saved. New sessions search with ${LABEL[next.provider]}.`,
      };
    });
  };

  const check = () => {
    if (choice === "off") return;
    const problem = missing(true);
    if (problem !== null) {
      setOutcome({ tone: "error", text: problem });
      return;
    }
    void run("check", async () => {
      const result = await api.check({
        provider: choice,
        ...(isKeyed(choice) && keyTyped !== "" ? { apiKey: keyTyped } : {}),
        ...(choice === "searxng" ? { searxngUrl: urlTyped } : {}),
      });
      return { tone: result.ok ? "success" : "error", text: result.message };
    });
  };

  const removeKey = () => {
    if (!isKeyed(choice)) return;
    const provider = choice;
    void run("remove", async () => {
      const next = await api.removeKey(provider);
      setState(next);
      if (next.provider === null) setChoice("off");
      return { tone: "success", text: `Removed the ${LABEL[provider]} key from your Keychain.` };
    });
  };

  const site = CHOICES.find((c) => c.value === choice)?.site;
  const keychainMissing = state !== null && !state.keychainAvailable;

  return (
    <>
      <h1 className={settingsStyles.h1}>Web</h1>
      <p className={settingsStyles.lead}>
        Two tools let the model use the web. Both reach the internet from this Mac, and ask before
        they do unless a rule in Settings → Permissions allows it.
      </p>

      <section aria-labelledby={`${urlId}-fetch`}>
        <h2 id={`${urlId}-fetch`} className={settingsStyles.h2}>
          Fetching pages
        </h2>
        <p className={styles.text}>
          WebFetch reads a public web page and answers the model's question about it. It asks before
          each new site, never reaches this Mac or your local network, and keeps pages for 15
          minutes. Nothing to set up.
        </p>
      </section>

      <section aria-labelledby={`${urlId}-search`}>
        <h2 id={`${urlId}-search`} className={settingsStyles.h2}>
          Searching the web
        </h2>
        <p className={styles.text}>
          WebSearch gives the model the titles, links and short excerpts of matching pages, and the
          model reads them with WebFetch. dawg-code has no search service of its own: choose one
          below, with your own key. Sessions you open after a change use it.
        </p>
        {loadError !== null ? (
          <p className={styles.error} role="alert">
            <Icon name="alert" size={14} />
            The web settings could not be read: {loadError}
          </p>
        ) : state === null ? (
          <p className={settingsStyles.muted}>Loading…</p>
        ) : (
          <form className={styles.form} aria-label="Search service" noValidate onSubmit={save}>
            <p className={styles.status} role="status">
              {state.provider === null
                ? "Web search is off."
                : `Web search uses ${LABEL[state.provider]}.`}
            </p>
            {keychainMissing && (
              <p className={styles.error}>
                <Icon name="alert" size={14} />
                Keys cannot be stored safely on this Mac because the Keychain is not available, so
                Brave Search and Tavily cannot be used.
              </p>
            )}
            <RadioGroup.Root
              className={settingsStyles.options}
              value={choice}
              aria-label="Search service"
              onValueChange={(value) => {
                const next = CHOICES.find((c) => c.value === value);
                if (next === undefined) return;
                setChoice(next.value);
                setApiKey("");
                setOutcome(null);
              }}
            >
              {CHOICES.map((c) => (
                <ChoiceOption
                  key={c.value}
                  {...c}
                  hasKey={isKeyed(c.value) && state.keys[c.value]}
                />
              ))}
            </RadioGroup.Root>

            {isKeyed(choice) && (
              <div className={styles.field}>
                <label className={styles.label} htmlFor={keyId}>
                  {LABEL[choice]} API key
                </label>
                <div className={styles.row}>
                  <input
                    id={keyId}
                    className={styles.input}
                    type="password"
                    autoComplete="off"
                    spellCheck={false}
                    placeholder={
                      hasKey
                        ? "Stored in your Keychain. Type a new key to replace it."
                        : "Stored in your Keychain"
                    }
                    value={apiKey}
                    disabled={keychainMissing}
                    aria-describedby={outcome?.tone === "error" ? outcomeId : undefined}
                    onChange={(event) => setApiKey(event.target.value)}
                  />
                  {hasKey && (
                    <Button size="sm" variant="ghost" disabled={busy !== null} onClick={removeKey}>
                      Remove key
                    </Button>
                  )}
                </div>
              </div>
            )}

            {choice === "searxng" && (
              <div className={styles.field}>
                <label className={styles.label} htmlFor={urlId}>
                  Instance address
                </label>
                <input
                  id={urlId}
                  className={`${styles.input} ${styles.mono}`}
                  type="url"
                  inputMode="url"
                  autoComplete="off"
                  spellCheck={false}
                  placeholder="http://localhost:8888"
                  value={url}
                  aria-describedby={outcome?.tone === "error" ? outcomeId : undefined}
                  onChange={(event) => setUrl(event.target.value)}
                />
              </div>
            )}

            <div className={styles.actions}>
              {site !== undefined && (
                <button
                  type="button"
                  className={styles.link}
                  onClick={() => props.onOpenLink(site.url)}
                >
                  {site.label}
                  <Icon name="external" size={12} />
                </button>
              )}
              <span className={styles.grow} />
              {choice !== "off" && (
                <Button disabled={busy !== null} onClick={check}>
                  {busy === "check" ? "Checking…" : "Check it works"}
                </Button>
              )}
              <Button type="submit" variant="primary" disabled={busy !== null || !changed}>
                {busy === "save" ? "Saving…" : "Save"}
              </Button>
            </div>
            <p
              id={outcomeId}
              className={outcome?.tone === "error" ? styles.error : styles.success}
              role={outcome?.tone === "error" ? "alert" : "status"}
            >
              {outcome !== null && (
                <>
                  <Icon name={outcome.tone === "error" ? "alert" : "check"} size={14} />
                  {outcome.text}
                </>
              )}
            </p>
          </form>
        )}
      </section>
    </>
  );
}
