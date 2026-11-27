import { useId, useState } from "react";
import type {
  AddedModelFile,
  CatalogModel,
  ConnectServerInput,
  ModelOption,
  ModelsState,
  ServerInfo,
} from "../../shared/bridge.ts";
import { formatBytes, formatMemory } from "../lib/format.ts";
import modelStyles from "../models/Models.module.css";
import { ServerForm } from "../models/ServerForm.tsx";
import { abilitySentence, archName, catalogFacts, contextLine, originTag } from "../models/text.ts";
import { foundInName, helperToSetUp, leadModel, serverOf } from "../state/models.ts";
import type { SetUpModelOptions } from "../state/types.ts";
import { Button, Icon, Tag } from "../ui/index.ts";
import styles from "./FirstRun.module.css";

export interface WelcomeProps {
  state: ModelsState;
  /**
   * Downloads (unless on this Mac already), starts, and makes it the default. The lead card asks
   * for the helper model too (`withHelper`) when the catalog offers it.
   */
  onSetUp(modelId: string, options?: SetUpModelOptions): void;
  onAddModelFile(): Promise<AddedModelFile | null>;
  onConnectServer(input: ConnectServerInput): Promise<{ server: ServerInfo } | { error: string }>;
  onOpenLink(url: string): void;
}

/** What was found about this Mac. */
function MachineFacts(props: { state: ModelsState }) {
  const { machine } = props.state;
  const cells = [
    { term: "Chip", value: machine.chip, sub: archName(machine) },
    {
      term: "Memory",
      value: formatMemory(machine.memoryBytes),
      sub: machine.arch === "arm64" ? "unified" : "",
    },
    { term: "Free disk", value: formatBytes(machine.freeDiskBytes), sub: "where models are kept" },
    { term: "System", value: `macOS ${machine.macosVersion}`, sub: "" },
  ];
  return (
    <section aria-labelledby="welcome-machine">
      <h2 id="welcome-machine" className={styles.label}>
        What we found
      </h2>
      <dl className={styles.machine}>
        {cells.map((cell) => (
          <div key={cell.term} className={styles.machineCell}>
            <dt>{cell.term}</dt>
            <dd>{cell.value}</dd>
            {cell.sub && <dd className={styles.sub}>{cell.sub}</dd>}
          </div>
        ))}
      </dl>
    </section>
  );
}

/** The model to lead with: name, size, memory, licence, what it can do, one button. */
function LeadCard(props: {
  state: ModelsState;
  entry: CatalogModel;
  more: boolean;
  moreId: string;
  onToggleMore(): void;
  onSetUp: WelcomeProps["onSetUp"];
  onOpenLink(url: string): void;
}) {
  const { entry, state } = props;
  const installed = state.installed.some((option) => option.id === entry.id);
  const can = abilitySentence(entry);
  // The one click also gets the helper model, which writes titles and reads web pages so the
  // main model stays on the conversation.
  const helper = helperToSetUp(state);
  const helperNoteId = useId();
  const describedBy = helper ? helperNoteId : undefined;
  const withHelper = helper !== null;
  return (
    <section className={styles.feature} aria-labelledby="welcome-lead">
      <div className={styles.featureHead}>
        <Tag tone="accent">{entry.recommended ? "Recommended for this Mac" : "Fits this Mac"}</Tag>
        {entry.foundIn !== null && <Tag tone="green">Found in {foundInName(entry.foundIn)}</Tag>}
      </div>
      <div>
        <h2 id="welcome-lead" className={styles.featureName}>
          {entry.displayName}
        </h2>
        <p className={styles.featureText}>
          Uses about {formatMemory(entry.memoryBytes)} of this Mac’s{" "}
          {formatMemory(state.machine.memoryBytes)} of memory while it runs.
          {can && ` ${can}`}
        </p>
      </div>
      <dl className={styles.facts}>
        <div>
          <dt>Download</dt>
          <dd>
            {entry.foundIn !== null || installed ? "None needed" : formatBytes(entry.sizeBytes)}
          </dd>
        </div>
        <div>
          <dt>Memory</dt>
          <dd>{formatMemory(entry.memoryBytes)}</dd>
        </div>
        <div>
          <dt>Licence</dt>
          <dd>
            {entry.licence.spdx}
            <button
              type="button"
              className={modelStyles.link}
              aria-label={`Read the ${entry.licence.spdx} licence`}
              onClick={() => props.onOpenLink(entry.licence.url)}
            >
              Read
            </button>
          </dd>
        </div>
        <div>
          <dt>Context</dt>
          <dd>{contextLine(entry)}</dd>
        </div>
      </dl>
      {helper && (
        <p id={helperNoteId} className={styles.helperNote}>
          <Icon name="download" size={14} className={styles.helperNoteIcon} />
          <span>
            Plus a small helper model ({formatBytes(helper.sizeBytes)}) for titles and page
            summaries, so {entry.displayName} stays on your conversation.
          </span>
        </p>
      )}
      <div className={styles.buttons}>
        {installed ? (
          <Button
            variant="primary"
            size="lg"
            icon="send"
            aria-describedby={describedBy}
            onClick={() => props.onSetUp(entry.id, { withHelper })}
          >
            Start
          </Button>
        ) : entry.foundIn !== null ? (
          <Button
            variant="primary"
            size="lg"
            icon="check"
            aria-describedby={describedBy}
            onClick={() => props.onSetUp(entry.id, { useExisting: true, withHelper })}
          >
            Use the copy from {foundInName(entry.foundIn)}
          </Button>
        ) : (
          <Button
            variant="primary"
            size="lg"
            icon="download"
            aria-describedby={describedBy}
            onClick={() => props.onSetUp(entry.id, { withHelper })}
          >
            Download and start
          </Button>
        )}
        <Button
          variant="ghost"
          aria-expanded={props.more}
          aria-controls={props.moreId}
          onClick={props.onToggleMore}
        >
          {props.more ? "Fewer options" : "More options"}
        </Button>
      </div>
    </section>
  );
}

/** Nothing in the catalog fits: say so, and lead with a model file and a server. */
function NothingFitsCard(props: {
  state: ModelsState;
  more: boolean;
  moreId: string;
  onToggleMore(): void;
  onAddModelFile(): void;
  onShowServer(): void;
}) {
  const { state } = props;
  const smallest = state.catalog.reduce<number | null>(
    (least, entry) => (least === null ? entry.memoryBytes : Math.min(least, entry.memoryBytes)),
    null,
  );
  return (
    <section className={styles.feature} aria-labelledby="welcome-lead">
      <div>
        <h2 id="welcome-lead" className={styles.featureName}>
          No catalog model fits this Mac
        </h2>
        <p className={styles.featureText}>
          {smallest !== null
            ? `The smallest needs ${formatMemory(smallest)} of memory; this Mac has ${formatMemory(state.machine.memoryBytes)}. `
            : ""}
          You can still run a model file you choose, or use a model on another computer.
        </p>
      </div>
      <div className={styles.buttons}>
        <Button variant="primary" size="lg" icon="file" onClick={props.onAddModelFile}>
          Add a model file…
        </Button>
        <Button size="lg" icon="server" onClick={props.onShowServer}>
          Connect to a server…
        </Button>
        {state.catalog.length > 0 && (
          <Button
            variant="ghost"
            aria-expanded={props.more}
            aria-controls={props.moreId}
            onClick={props.onToggleMore}
          >
            {props.more ? "Hide the catalog" : "Show the catalog"}
          </Button>
        )}
      </div>
    </section>
  );
}

/** A catalog entry under "More options": fits, or why not; download, or use another app's copy. */
function CatalogRow(props: { entry: CatalogModel; onSetUp: WelcomeProps["onSetUp"] }) {
  const { entry } = props;
  const noteId = useId();
  return (
    <div className={`${modelStyles.row} ${modelStyles.rowTop}`}>
      <div className={modelStyles.grow}>
        <div className={modelStyles.titleLine}>
          <span className={modelStyles.name}>{entry.displayName}</span>
          {entry.fits ? (
            entry.foundIn !== null ? (
              <Tag tone="green">On this Mac already</Tag>
            ) : (
              <Tag tone="green">Fits</Tag>
            )
          ) : (
            <Tag tone="amber">Does not fit</Tag>
          )}
        </div>
        <p className={modelStyles.meta}>
          {entry.foundIn !== null && entry.fits
            ? `Found in ${foundInName(entry.foundIn)}’s folder and used in place · `
            : ""}
          {catalogFacts(entry)}
        </p>
        {!entry.fits && entry.fitNote && (
          <p id={noteId} className={modelStyles.warning}>
            {entry.fitNote}
          </p>
        )}
      </div>
      {entry.fits && entry.foundIn !== null ? (
        <Button onClick={() => props.onSetUp(entry.id, { useExisting: true })}>
          Use the copy from {foundInName(entry.foundIn)}
        </Button>
      ) : (
        <Button
          disabled={!entry.fits}
          aria-label={`Download ${entry.displayName}`}
          aria-describedby={!entry.fits && entry.fitNote ? noteId : undefined}
          onClick={() => props.onSetUp(entry.id)}
        >
          Download
        </Button>
      )}
    </div>
  );
}

/** A model that can run already (a server's, or one on this Mac): "Use this". */
function ReadyRow(props: { state: ModelsState; option: ModelOption; onUse(): void }) {
  const { option } = props;
  const server = option.source === "server" ? serverOf(props.state, option.id) : undefined;
  const tag =
    option.origin === "ollama" || option.origin === "lmstudio"
      ? `Found in ${option.origin === "ollama" ? "Ollama" : "LM Studio"}`
      : originTag(option);
  return (
    <div className={modelStyles.row}>
      <div className={modelStyles.grow}>
        <div className={modelStyles.titleLine}>
          <span className={modelStyles.name}>{option.label}</span>
          <Tag tone="green">{tag}</Tag>
          {server && !server.reachable && <Tag tone="amber">Not answering</Tag>}
        </div>
        <p className={modelStyles.meta}>{option.description}</p>
      </div>
      <Button aria-label={`Use ${option.label}`} onClick={props.onUse}>
        Use this
      </Button>
    </div>
  );
}

/** The model file just added, with its memory warning, and a button to start it. */
function AddedFileCard(props: { added: AddedModelFile; onStart(): void }) {
  const { option, memoryWarning } = props.added;
  return (
    <section className={modelStyles.card} aria-label="Added model file">
      <div className={`${modelStyles.row} ${modelStyles.rowTop}`}>
        <Icon name="file" className={modelStyles.icon} />
        <div className={modelStyles.grow}>
          <div className={modelStyles.titleLine}>
            <span className={modelStyles.name}>{option.label}</span>
            <Tag>Model file</Tag>
          </div>
          <p className={modelStyles.meta}>{option.description}</p>
          {memoryWarning && (
            <p className={modelStyles.warning} role="status">
              <Icon name="alert" size={14} />
              {memoryWarning}
            </p>
          )}
        </div>
        <Button variant="primary" onClick={props.onStart}>
          {memoryWarning ? "Start anyway" : "Start"}
        </Button>
      </div>
    </section>
  );
}

/**
 * The first screen while nothing is installed: what was found about this Mac, the model to lead
 * with and its one button, and more options (the rest of the catalog, models other apps have,
 * a model file, a server). When nothing fits it says so and leads with a model file or a server.
 */
export function Welcome(props: WelcomeProps) {
  const { state } = props;
  const moreId = useId();
  const lead = leadModel(state);
  const [more, setMore] = useState(false);
  const [serverOpen, setServerOpen] = useState(false);
  const [added, setAdded] = useState<AddedModelFile | null>(null);

  const addModelFile = async () => {
    const result = await props.onAddModelFile();
    if (result) setAdded(result);
  };

  const ready = state.installed.filter((option) => option.id !== added?.option.id);
  const others = state.catalog.filter(
    (entry) => entry.id !== lead?.id && !state.installed.some((option) => option.id === entry.id),
  );
  const ollama = state.servers.find((server) => server.kind === "ollama" && server.reachable);

  return (
    <>
      <div>
        <h1 className={styles.h1}>A coding agent that runs on your Mac</h1>
        <p className={styles.lead}>
          Choose a model once. After the download everything runs here: no account, and nothing
          leaves this Mac.
        </p>
      </div>
      <MachineFacts state={state} />
      {lead ? (
        <LeadCard
          state={state}
          entry={lead}
          more={more}
          moreId={moreId}
          onToggleMore={() => setMore(!more)}
          onSetUp={props.onSetUp}
          onOpenLink={props.onOpenLink}
        />
      ) : (
        <NothingFitsCard
          state={state}
          more={more}
          moreId={moreId}
          onToggleMore={() => setMore(!more)}
          onAddModelFile={() => void addModelFile()}
          onShowServer={() => setServerOpen(true)}
        />
      )}
      {added && <AddedFileCard added={added} onStart={() => props.onSetUp(added.option.id)} />}
      {serverOpen && (
        <section className={modelStyles.card} aria-labelledby="welcome-server">
          <div className={`${modelStyles.row} ${modelStyles.rowStack}`}>
            <div>
              <h2 id="welcome-server" className={modelStyles.cardTitle}>
                Connect to a server
              </h2>
              <p className={modelStyles.meta}>
                Another computer running llama-server, LM Studio, Ollama or any OpenAI-compatible
                server. Its models then show below.
              </p>
            </div>
            <ServerForm
              autoFocus
              onConnect={props.onConnectServer}
              onConnected={() => setMore(true)}
            />
          </div>
        </section>
      )}
      {more && (
        <section id={moreId} className={modelStyles.card} aria-label="More options">
          {ready.map((option) => (
            <ReadyRow
              key={option.id}
              state={state}
              option={option}
              onUse={() => props.onSetUp(option.id)}
            />
          ))}
          {others.map((entry) => (
            <CatalogRow key={entry.id} entry={entry} onSetUp={props.onSetUp} />
          ))}
          {lead && (
            <div className={modelStyles.row}>
              <div className={modelStyles.actions}>
                <Button variant="ghost" icon="file" onClick={() => void addModelFile()}>
                  Add a model file (.gguf)…
                </Button>
                <Button
                  variant="ghost"
                  icon="server"
                  aria-expanded={serverOpen}
                  onClick={() => setServerOpen(!serverOpen)}
                >
                  Connect to a server…
                </Button>
              </div>
              <span className={modelStyles.grow} />
              {ollama && <span className={modelStyles.meta}>Ollama is running on this Mac</span>}
            </div>
          )}
        </section>
      )}
      <p className={styles.note}>
        Models come from Hugging Face. Downloads resume after a dropped connection and are checked
        against their SHA-256 before use.
      </p>
    </>
  );
}
