/**
 * What main's IPC handlers and the engine host's model requests use: the real model manager
 * (manager.ts) or, with DAWG_ENGINE=mock, the mock (mock.ts).
 */
import type {
  AddedModelFile,
  ConnectServerInput,
  ModelOption,
  ModelStatus,
  ModelsState,
  ServerInfo,
  Unsubscribe,
} from "../../shared/bridge.ts";
import {
  HostToMainSchema,
  type MainToHost,
  type ModelGrant,
} from "../../shared/engine-host-messages.ts";

export type ModelAnswer =
  | { ok: true; grant: ModelGrant }
  | { ok: false; message: string; retryable: boolean };

export interface ModelService {
  /** Loads what was saved and starts the background work (scan, server checks). */
  init(): Promise<void>;
  /** Stops downloads and the runtime. No llama-server outlives this. */
  dispose(): Promise<void>;

  state(): Promise<ModelsState>;
  list(): Promise<ModelOption[]>;
  status(): Promise<ModelStatus>;
  /** The whole state after every change; download progress at most about 4 times a second. */
  onState(listener: (state: ModelsState) => void): Unsubscribe;
  /** The runtime status, when it changes. */
  onStatus(listener: (status: ModelStatus) => void): Unsubscribe;

  download(modelId: string): Promise<void>;
  pauseDownload(modelId: string): Promise<void>;
  cancelDownload(modelId: string): Promise<void>;
  dismissDownload(modelId: string): Promise<void>;
  useExisting(modelId: string): Promise<void>;
  remove(modelId: string): Promise<void>;
  start(modelId: string): Promise<void>;
  stop(): Promise<void>;
  setDefault(modelId: string): Promise<void>;
  setIdleUnload(minutes: number | null): Promise<void>;
  /** `choose` opens the native picker; null when the person cancels. */
  addModelFile(choose: () => Promise<string | null>): Promise<AddedModelFile | null>;
  connectServer(input: ConnectServerInput): Promise<ServerInfo>;
  removeServer(serverId: string): Promise<void>;
  refreshServers(): Promise<void>;

  /** Makes a model available to the engine host (null asks for the default). */
  requestModel(modelId: string | null): Promise<ModelAnswer>;
  /** Called after anything that can make a grant out of date. */
  onModelsChanged(listener: () => void): Unsubscribe;
}

/**
 * Answers one message from the engine host. Returns the reply to post, or null when the message
 * is not one main understands (it is logged and dropped).
 */
export async function answerHostMessage(
  service: Pick<ModelService, "requestModel">,
  raw: unknown,
  log: (message: string) => void,
): Promise<MainToHost | null> {
  const parsed = HostToMainSchema.safeParse(raw);
  if (!parsed.success) {
    log(`Ignoring a message from the engine host that main does not understand.`);
    return null;
  }
  const { requestId, modelId } = parsed.data;
  let answer: ModelAnswer;
  try {
    answer = await service.requestModel(modelId);
  } catch (error) {
    answer = {
      ok: false,
      message: error instanceof Error ? error.message : String(error),
      retryable: false,
    };
  }
  return answer.ok
    ? { type: "model-grant", requestId, grant: answer.grant }
    : { type: "model-refused", requestId, message: answer.message, retryable: answer.retryable };
}

/** A tiny listener set. */
export function listeners<T extends unknown[]>() {
  const set = new Set<(...args: T) => void>();
  return {
    add(listener: (...args: T) => void): Unsubscribe {
      set.add(listener);
      return () => {
        set.delete(listener);
      };
    },
    emit(...args: T): void {
      for (const listener of [...set]) listener(...args);
    },
  };
}
