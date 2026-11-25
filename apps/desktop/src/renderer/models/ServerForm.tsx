import { type FormEvent, useId, useState } from "react";
import { type ConnectServerInput, type ServerInfo, ServerUrlSchema } from "../../shared/bridge.ts";
import { serverName } from "../state/models.ts";
import { Button, Icon } from "../ui/index.ts";
import styles from "./Models.module.css";

export interface ServerFormProps {
  /** Adds the server; resolves to it, or to the sentence saying why it could not be added. */
  onConnect(input: ConnectServerInput): Promise<{ server: ServerInfo } | { error: string }>;
  onConnected?(server: ServerInfo): void;
  autoFocus?: boolean;
}

type Outcome = { tone: "error" | "success"; text: string } | null;

/**
 * "Another server": an OpenAI-compatible address and an optional key. The app checks the server
 * answers before adding it; the key goes to the Keychain and never comes back.
 */
export function ServerForm(props: ServerFormProps) {
  const urlId = useId();
  const keyId = useId();
  const outcomeId = useId();
  const [url, setUrl] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState<Outcome>(null);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (busy) return;
    const address = url.trim();
    if (!ServerUrlSchema.safeParse(address).success) {
      setOutcome({
        tone: "error",
        text: "Enter an http or https address, such as http://studio.local:8080/v1.",
      });
      return;
    }
    const key = apiKey.trim();
    setBusy(true);
    setOutcome(null);
    const result = await props.onConnect(
      key === "" ? { url: address } : { url: address, apiKey: key },
    );
    setBusy(false);
    if ("error" in result) {
      setOutcome({ tone: "error", text: result.error });
      return;
    }
    const count = result.server.modelIds.length;
    setOutcome({
      tone: "success",
      text: `Added ${serverName(result.server)}: ${count} ${count === 1 ? "model" : "models"}.`,
    });
    setUrl("");
    setApiKey("");
    props.onConnected?.(result.server);
  };

  return (
    <form
      className={styles.form}
      aria-label="Connect to a server"
      // The form says what is wrong itself, in words, instead of the browser's bubble.
      noValidate
      onSubmit={(event) => void submit(event)}
    >
      <div className={styles.grid2}>
        <div>
          <label className={styles.label} htmlFor={urlId}>
            OpenAI-compatible address
          </label>
          <input
            id={urlId}
            className={`${styles.input} ${styles.mono}`}
            type="url"
            inputMode="url"
            placeholder="http://studio.local:8080/v1"
            spellCheck={false}
            autoComplete="off"
            // biome-ignore lint/a11y/noAutofocus: the person just asked for this form
            autoFocus={props.autoFocus}
            value={url}
            aria-describedby={outcome?.tone === "error" ? outcomeId : undefined}
            aria-invalid={outcome?.tone === "error" ? true : undefined}
            onChange={(event) => setUrl(event.target.value)}
          />
        </div>
        <div>
          <label className={styles.label} htmlFor={keyId}>
            API key (optional)
          </label>
          <input
            id={keyId}
            className={styles.input}
            type="password"
            placeholder="Stored in your Keychain"
            autoComplete="off"
            value={apiKey}
            onChange={(event) => setApiKey(event.target.value)}
          />
        </div>
      </div>
      <div className={styles.actions}>
        {outcome && (
          <p
            id={outcomeId}
            className={outcome.tone === "error" ? styles.error : styles.success}
            role={outcome.tone === "error" ? "alert" : "status"}
          >
            <Icon name={outcome.tone === "error" ? "alert" : "check"} size={14} />
            {outcome.text}
          </p>
        )}
        <span className={styles.grow} />
        <Button type="submit" variant="primary" disabled={busy}>
          {busy ? "Checking the server…" : "Add server"}
        </Button>
      </div>
    </form>
  );
}
