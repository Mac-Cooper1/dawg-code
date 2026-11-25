import { useId, useState } from "react";
import type {
  AddedModelFile,
  CatalogModel,
  DownloadState,
  ModelOption,
  ModelsState,
  ServerInfo,
} from "../../shared/bridge.ts";
import { run } from "../app/run.ts";
import { formatBytes, formatMemory } from "../lib/format.ts";
import { CancelDownloadDialog } from "../models/CancelDownloadDialog.tsx";
import modelStyles from "../models/Models.module.css";
import { ProgressBar } from "../models/ProgressBar.tsx";
import { ServerForm } from "../models/ServerForm.tsx";
import { catalogFacts, downloadLine, originTag, serverFacts } from "../models/text.ts";
import {
  findCatalogEntry,
  foundInName,
  isRunningDownload,
  modelName,
  serverName,
} from "../state/models.ts";
import type { AppActions } from "../state/types.ts";
import { Button, ConfirmDialog, Icon, IconButton, Spinner, Tag } from "../ui/index.ts";
import styles from "./Settings.module.css";

export type ModelsPageActions = Pick<
  AppActions,
  | "startModel"
  | "stopModel"
  | "setDefaultModel"
  | "removeModel"
  | "setIdleUnload"
  | "downloadModel"
  | "pauseDownload"
  | "cancelDownload"
  | "dismissDownload"
  | "adoptExistingModel"
  | "addModelFile"
  | "connectServer"
  | "removeServer"
  | "refreshServers"
  | "openExternal"
>;

export interface ModelsPageProps {
  /** Null while it loads. */
  state: ModelsState | null;
  actions: ModelsPageActions;
}

const IDLE_CHOICES: readonly { minutes: number | null; label: string }[] = [
  { minutes: null, label: "Never" },
  { minutes: 15, label: "After 15 minutes" },
  { minutes: 30, label: "After 30 minutes" },
  { minutes: 60, label: "After 1 hour" },
  { minutes: 120, label: "After 2 hours" },
];

/** The bundled runtime: what runs, its memory, Stop or Start, and when it unloads by itself. */
function RunningCard(props: { state: ModelsState; actions: ModelsPageActions }) {
  const { state, actions } = props;
  const { status, machine } = state;
  const idleId = useId();
  const loaded =
    status.modelId !== null ? state.installed.find((o) => o.id === status.modelId) : undefined;
  const bundled = state.installed.filter((option) => option.source === "bundled");
  const startTarget =
    bundled.find((option) => option.id === state.defaultModelId) ?? bundled[0] ?? null;
  const running = status.state === "ready" || status.state === "loading";
  const name =
    status.label ?? loaded?.label ?? (running ? status.modelId : null) ?? "Nothing running";
  const tag =
    status.state === "ready" ? (
      <Tag tone="green">Ready</Tag>
    ) : status.state === "loading" ? (
      <Tag tone="accent">Loading</Tag>
    ) : status.state === "error" ? (
      <Tag tone="red">Error</Tag>
    ) : (
      <Tag>Stopped</Tag>
    );
  const meta =
    status.state === "ready"
      ? (loaded?.description ?? "Bundled runtime")
      : status.state === "loading"
        ? (status.message ?? "Loading into memory")
        : status.state === "error"
          ? (status.message ?? "The model stopped")
          : startTarget
            ? `Sessions on this Mac wait until a model starts. Start loads ${startTarget.label}.`
            : "No model on this Mac yet.";
  const idleChoices = IDLE_CHOICES.some((choice) => choice.minutes === state.idleUnloadMinutes)
    ? IDLE_CHOICES
    : [
        ...IDLE_CHOICES,
        { minutes: state.idleUnloadMinutes, label: `After ${state.idleUnloadMinutes} minutes` },
      ];

  return (
    <div className={modelStyles.card}>
      <div className={`${modelStyles.row} ${modelStyles.rowTop}`}>
        <span className={modelStyles.statusMark} aria-hidden="true">
          {status.state === "loading" ? (
            <Spinner size={10} />
          ) : (
            <span className={modelStyles.dot} data-state={status.state} />
          )}
        </span>
        <div className={modelStyles.grow}>
          <div className={modelStyles.titleLine}>
            <span className={`${modelStyles.name} ${modelStyles.runningName}`}>{name}</span>
            {tag}
          </div>
          <p className={status.state === "error" ? modelStyles.warning : modelStyles.meta}>
            {meta}
          </p>
          {status.memoryBytes !== null && machine.memoryBytes > 0 && (
            <div className={modelStyles.memoryBlock}>
              <meter
                className={modelStyles.memory}
                aria-label="Memory the model uses"
                aria-valuetext={`${formatMemory(status.memoryBytes)} of ${formatMemory(machine.memoryBytes)}`}
                min={0}
                max={machine.memoryBytes}
                value={Math.min(status.memoryBytes, machine.memoryBytes)}
              />
              <div className={modelStyles.legend}>
                <span>
                  <span className={modelStyles.swatch} />
                  Model {formatMemory(status.memoryBytes)}
                </span>
                <span className={modelStyles.grow} />
                <span>
                  {formatMemory(Math.max(0, machine.memoryBytes - status.memoryBytes))} left of{" "}
                  {formatMemory(machine.memoryBytes)}
                </span>
              </div>
            </div>
          )}
        </div>
        {running ? (
          <Button onClick={() => run(actions.stopModel())}>Stop</Button>
        ) : (
          <Button
            disabled={startTarget === null}
            onClick={() => startTarget && run(actions.startModel(startTarget.id))}
          >
            Start
          </Button>
        )}
      </div>
      <div className={modelStyles.row}>
        <label className={`${modelStyles.grow} ${modelStyles.meta}`} htmlFor={idleId}>
          Unload the model after it sits idle, to give the memory back. It loads again with your
          next message.
        </label>
        <select
          id={idleId}
          className={modelStyles.select}
          value={state.idleUnloadMinutes === null ? "never" : String(state.idleUnloadMinutes)}
          onChange={(event) => {
            const value = event.target.value;
            run(actions.setIdleUnload(value === "never" ? null : Number(value)));
          }}
        >
          {idleChoices.map((choice) => (
            <option
              key={choice.label}
              value={choice.minutes === null ? "never" : String(choice.minutes)}
            >
              {choice.label}
            </option>
          ))}
        </select>
      </div>
    </div>
  );
}

/** An installed model on this Mac: default, loaded, start, make default, delete. */
function InstalledRow(props: {
  state: ModelsState;
  option: ModelOption;
  actions: ModelsPageActions;
  onDelete(option: ModelOption): void;
}) {
  const { state, option, actions } = props;
  const isDefault = state.defaultModelId === option.id;
  const loaded = state.status.modelId === option.id;
  return (
    <div className={modelStyles.row}>
      <div className={modelStyles.grow}>
        <div className={modelStyles.titleLine}>
          <span className={modelStyles.name}>{option.label}</span>
          {isDefault && <Tag tone="accent">Default</Tag>}
          {loaded && state.status.state === "ready" && <Tag tone="green">Running</Tag>}
          {loaded && state.status.state === "loading" && <Tag tone="accent">Loading</Tag>}
          <Tag>{originTag(option)}</Tag>
        </div>
        <p className={modelStyles.meta}>{option.description}</p>
      </div>
      <div className={modelStyles.buttons}>
        {!isDefault && (
          <Button
            variant="ghost"
            aria-label={`Make ${option.label} the default`}
            onClick={() => run(actions.setDefaultModel(option.id))}
          >
            Make default
          </Button>
        )}
        {!loaded && (
          <Button
            aria-label={`Start ${option.label}`}
            onClick={() => run(actions.startModel(option.id))}
          >
            Start
          </Button>
        )}
        {option.removable && (
          <IconButton
            icon="trash"
            label={`Delete ${option.label}`}
            onClick={() => props.onDelete(option)}
          />
        )}
      </div>
    </div>
  );
}

/** A download: progress and its controls, or how it ended. */
function DownloadRow(props: {
  state: ModelsState;
  download: DownloadState;
  actions: ModelsPageActions;
  onCancel(download: DownloadState): void;
}) {
  const { state, download, actions } = props;
  const name = modelName(state, download.modelId);
  const { modelId } = download;
  return (
    <div className={`${modelStyles.row} ${modelStyles.rowTop}`}>
      <div className={modelStyles.grow}>
        <div className={modelStyles.titleLine}>
          <span className={modelStyles.name}>{name}</span>
          {download.phase === "done" && <Tag tone="green">Downloaded</Tag>}
          {download.phase === "failed" && <Tag tone="red">Failed</Tag>}
          {download.phase === "paused" && <Tag>Paused</Tag>}
        </div>
        {download.phase !== "done" && (
          <div className={modelStyles.downloadBar}>
            <ProgressBar download={download} label={`Downloading ${name}`} />
          </div>
        )}
        {download.phase === "failed" ? (
          <p className={modelStyles.warning} role="alert">
            <Icon name="alert" size={14} />
            {downloadLine(download)}
          </p>
        ) : (
          <p className={modelStyles.meta}>{downloadLine(download)}</p>
        )}
      </div>
      <div className={modelStyles.buttons}>
        {isRunningDownload(download) && (
          <Button
            disabled={download.phase === "verifying"}
            onClick={() => run(actions.pauseDownload(modelId))}
          >
            Pause
          </Button>
        )}
        {(download.phase === "paused" || download.phase === "failed") && (
          <Button onClick={() => run(actions.downloadModel(modelId))}>
            {download.phase === "failed" ? "Retry" : "Resume"}
          </Button>
        )}
        {(isRunningDownload(download) || download.phase === "paused") && (
          <Button
            variant="ghost"
            disabled={download.phase === "verifying"}
            onClick={() => props.onCancel(download)}
          >
            Cancel
          </Button>
        )}
        {(download.phase === "done" || download.phase === "failed") && (
          <IconButton
            icon="close"
            size="sm"
            label={`Clear ${name} from the list`}
            onClick={() => run(actions.dismissDownload(modelId))}
          />
        )}
      </div>
    </div>
  );
}

/** A catalog model to download: size, memory, licence, whether it fits. */
function CatalogRow(props: { entry: CatalogModel; actions: ModelsPageActions }) {
  const { entry, actions } = props;
  const noteId = useId();
  return (
    <div className={`${modelStyles.row} ${modelStyles.rowTop}`}>
      <div className={modelStyles.grow}>
        <div className={modelStyles.titleLine}>
          <span className={modelStyles.name}>{entry.displayName}</span>
          {entry.recommended && <Tag tone="accent">Recommended</Tag>}
          {entry.fits ? <Tag tone="green">Fits</Tag> : <Tag tone="amber">Does not fit</Tag>}
          {entry.foundIn !== null && <Tag>Found in {foundInName(entry.foundIn)}</Tag>}
        </div>
        <p className={modelStyles.meta}>
          {catalogFacts(entry)} ·{" "}
          <button
            type="button"
            className={modelStyles.link}
            aria-label={`Read the ${entry.licence.spdx} licence of ${entry.displayName}`}
            onClick={() => run(actions.openExternal(entry.licence.url))}
          >
            Licence
          </button>
        </p>
        {!entry.fits && entry.fitNote && (
          <p id={noteId} className={modelStyles.warning}>
            {entry.fitNote}
          </p>
        )}
      </div>
      <div className={modelStyles.buttons}>
        {entry.fits && entry.foundIn !== null && (
          <Button onClick={() => run(actions.adoptExistingModel(entry.id))}>
            Use the copy from {foundInName(entry.foundIn)}
          </Button>
        )}
        <Button
          disabled={!entry.fits}
          aria-label={`Download ${entry.displayName}, ${formatBytes(entry.sizeBytes)}`}
          aria-describedby={!entry.fits && entry.fitNote ? noteId : undefined}
          onClick={() => run(actions.downloadModel(entry.id))}
        >
          Download
        </Button>
      </div>
    </div>
  );
}

const SERVER_NOTES: Record<ServerInfo["kind"], string> = {
  ollama: "No prompt-cache control, so long sessions answer more slowly",
  lmstudio: "No prompt-cache control, so long sessions answer more slowly",
  remote: "",
};

/** A server: found or added, answering or not, its models, Remove for a remote one. */
function ServerRow(props: {
  state: ModelsState;
  server: ServerInfo;
  actions: ModelsPageActions;
  onRemove(server: ServerInfo): void;
}) {
  const { state, server, actions } = props;
  const local = server.kind !== "remote";
  const models = server.modelIds.map(
    (id) => state.installed.find((option) => option.id === id) ?? null,
  );
  const meta = [
    serverFacts(server),
    server.reachable ? SERVER_NOTES[server.kind] : local ? "Start it and choose Look again" : "",
    server.hasKey ? "key in your Keychain" : "",
  ]
    .filter((part) => part !== "")
    .join(" · ");
  return (
    <div className={`${modelStyles.row} ${modelStyles.rowTop}`}>
      <Icon name="server" className={modelStyles.icon} />
      <div className={modelStyles.grow}>
        <div className={modelStyles.titleLine}>
          <span className={modelStyles.name}>{serverName(server)}</span>
          {server.reachable ? (
            <Tag tone="green">{local ? "Running" : "Connected"}</Tag>
          ) : (
            <Tag tone={local ? "neutral" : "amber"}>{local ? "Not running" : "Not answering"}</Tag>
          )}
        </div>
        <p className={modelStyles.meta}>{meta}</p>
        {models.length > 0 && (
          <ul className={modelStyles.serverModels} aria-label={`Models on ${serverName(server)}`}>
            {server.modelIds.map((id, index) => {
              const option = models[index];
              const label = option?.label ?? id;
              const isDefault = state.defaultModelId === id;
              return (
                <li key={id} className={modelStyles.serverModel}>
                  <span className={modelStyles.grow}>{label}</span>
                  {isDefault ? (
                    <Tag tone="accent">Default</Tag>
                  ) : (
                    option && (
                      <Button
                        variant="ghost"
                        size="sm"
                        aria-label={`Make ${label} the default`}
                        onClick={() => run(actions.setDefaultModel(id))}
                      >
                        Make default
                      </Button>
                    )
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </div>
      {!local && (
        <Button variant="ghost" onClick={() => props.onRemove(server)}>
          Remove
        </Button>
      )}
    </div>
  );
}

/**
 * Settings → Models: the running model and its memory, idle unload, the models on this Mac,
 * downloads, the catalog, and the servers dawg can use.
 */
export function ModelsPage(props: ModelsPageProps) {
  const { state, actions } = props;
  const [deleting, setDeleting] = useState<ModelOption | null>(null);
  const [removingServer, setRemovingServer] = useState<ServerInfo | null>(null);
  const [cancelling, setCancelling] = useState<DownloadState | null>(null);
  const [added, setAdded] = useState<AddedModelFile | null>(null);

  if (!state) {
    return (
      <>
        <h1 className={styles.h1}>Models</h1>
        <p className={styles.lead}>Looking at this Mac…</p>
      </>
    );
  }

  const bundled = state.installed.filter((option) => option.source === "bundled");
  const downloads = state.downloads.filter((download) => download.phase !== "cancelled");
  const available = state.catalog.filter(
    (entry) =>
      entry.state !== "installed" &&
      !downloads.some((download) => download.modelId === entry.id) &&
      !state.installed.some((option) => option.id === entry.id),
  );
  const deletingEntry = deleting ? findCatalogEntry(state, deleting.id) : undefined;
  const cancellingName = cancelling ? modelName(state, cancelling.modelId) : "";

  const addModelFile = async () => {
    const result = await actions.addModelFile();
    if (result) setAdded(result);
  };

  return (
    <>
      <h1 className={styles.h1}>Models</h1>
      <p className={styles.lead}>
        What runs your sessions. Everything here stays on this Mac unless you connect a server.
      </p>

      <h2 className={styles.h2}>Running now</h2>
      <RunningCard state={state} actions={actions} />

      <h2 className={styles.h2}>On this Mac</h2>
      <div className={modelStyles.card}>
        {bundled.length === 0 && (
          <div className={modelStyles.row}>
            <p className={modelStyles.empty}>No models on this Mac yet. Download one below.</p>
          </div>
        )}
        {bundled.map((option) => (
          <InstalledRow
            key={option.id}
            state={state}
            option={option}
            actions={actions}
            onDelete={setDeleting}
          />
        ))}
        {added && (
          <div className={`${modelStyles.row} ${modelStyles.rowTop}`}>
            <Icon name="check" className={modelStyles.icon} />
            <div className={modelStyles.grow}>
              <span className={modelStyles.name}>Added {added.option.label}</span>
              {added.memoryWarning ? (
                <p className={modelStyles.warning} role="status">
                  <Icon name="alert" size={14} />
                  {added.memoryWarning}
                </p>
              ) : (
                <p className={modelStyles.meta}>It is in the model picker now.</p>
              )}
            </div>
            <IconButton icon="close" size="sm" label="Dismiss" onClick={() => setAdded(null)} />
          </div>
        )}
        <div className={modelStyles.row}>
          <Button variant="ghost" icon="file" onClick={() => void addModelFile()}>
            Add a model file (.gguf)…
          </Button>
          <span className={`${modelStyles.grow} ${modelStyles.meta}`}>
            Any GGUF works. The memory check is skipped after a warning.
          </span>
        </div>
      </div>

      {downloads.length > 0 && (
        <>
          <h2 className={styles.h2}>Downloads</h2>
          <div className={modelStyles.card}>
            {downloads.map((download) => (
              <DownloadRow
                key={download.modelId}
                state={state}
                download={download}
                actions={actions}
                onCancel={setCancelling}
              />
            ))}
          </div>
        </>
      )}

      <h2 className={styles.h2}>
        Available for this Mac <span className={styles.muted}>From the dawg catalog</span>
      </h2>
      <div className={modelStyles.card}>
        {available.length === 0 ? (
          <div className={modelStyles.row}>
            <p className={modelStyles.empty}>Every catalog model is on this Mac.</p>
          </div>
        ) : (
          available.map((entry) => <CatalogRow key={entry.id} entry={entry} actions={actions} />)
        )}
      </div>

      <h2 className={styles.h2}>
        Servers
        <span className={modelStyles.grow} />
        <Button variant="ghost" size="sm" onClick={() => run(actions.refreshServers())}>
          Look again
        </Button>
      </h2>
      <div className={modelStyles.card}>
        {state.servers.length === 0 && (
          <div className={modelStyles.row}>
            <p className={modelStyles.empty}>
              Ollama and LM Studio are not running. Start one and choose Look again.
            </p>
          </div>
        )}
        {state.servers.map((server) => (
          <ServerRow
            key={server.id}
            state={state}
            server={server}
            actions={actions}
            onRemove={setRemovingServer}
          />
        ))}
        <div className={`${modelStyles.row} ${modelStyles.rowStack}`}>
          <h3 className={modelStyles.cardTitle}>Another server</h3>
          <ServerForm onConnect={(input) => actions.connectServer(input)} />
        </div>
      </div>

      <ConfirmDialog
        open={deleting !== null}
        onOpenChange={(open) => {
          if (!open) setDeleting(null);
        }}
        title={`Delete ${deleting?.label ?? "the model"}?`}
        confirmLabel="Delete"
        destructive
        onConfirm={() => {
          if (deleting) run(actions.removeModel(deleting.id));
          setDeleting(null);
        }}
      >
        <p>
          {deletingEntry
            ? `Its ${formatBytes(deletingEntry.sizeBytes)} of files are deleted from this Mac.`
            : "Its files are deleted from this Mac."}{" "}
          {state.status.modelId === deleting?.id ? "It stops first. " : ""}You can download it again
          later.
        </p>
      </ConfirmDialog>
      <ConfirmDialog
        open={removingServer !== null}
        onOpenChange={(open) => {
          if (!open) setRemovingServer(null);
        }}
        title={`Remove ${removingServer ? serverName(removingServer) : "the server"}?`}
        confirmLabel="Remove"
        destructive
        onConfirm={() => {
          if (removingServer) run(actions.removeServer(removingServer.id));
          setRemovingServer(null);
        }}
      >
        <p>
          dawg forgets the server{removingServer?.hasKey ? " and the key in your Keychain" : ""}.
          Sessions that use its models need another model.
        </p>
      </ConfirmDialog>
      <CancelDownloadDialog
        download={cancelling}
        name={cancellingName}
        onOpenChange={(open) => {
          if (!open) setCancelling(null);
        }}
        onConfirm={() => {
          if (cancelling) run(actions.cancelDownload(cancelling.modelId));
          setCancelling(null);
        }}
      />
    </>
  );
}
