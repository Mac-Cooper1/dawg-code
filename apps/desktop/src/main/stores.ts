/**
 * The app's settings (`settings.json` → "desktop") and per-window state (`state.json` →
 * "windows" → id). Both files are shared with the rest of dawg; see json-file.ts for the rules.
 */
import {
  DEFAULT_SETTINGS,
  type DesktopSettings,
  type DesktopSettingsPatch,
  DesktopSettingsPatchSchema,
  DesktopSettingsSchema,
  type WindowState,
  WindowStateSchema,
} from "../shared/bridge.ts";
import { createJsonFile, isJsonObject, type Logger } from "./json-file.ts";
import { parseWithFieldDefaults, validateInput } from "./validate.ts";

export const SETTINGS_KEY = "desktop";
export const WINDOWS_KEY = "windows";

export interface SettingsStore {
  /** The current settings. Read from disk once, then kept in memory. */
  get(): Promise<DesktopSettings>;
  /**
   * Applies a validated patch and saves it. When the file cannot be parsed, the change still
   * applies for this run (the window must not ignore the click) but is not written.
   */
  update(patch: unknown): Promise<DesktopSettings>;
}

export function createSettingsStore(file: string, log: Logger): SettingsStore {
  const json = createJsonFile(file, log);
  let current: DesktopSettings | null = null;
  let loading: Promise<DesktopSettings> | null = null;

  async function load(): Promise<DesktopSettings> {
    const read = await json.read();
    if (read.kind === "missing") return { ...DEFAULT_SETTINGS };
    if (read.kind === "unreadable") {
      log(`Using default settings: ${file} could not be read (${read.reason}).`);
      return { ...DEFAULT_SETTINGS };
    }
    const { value, invalidFields } = parseWithFieldDefaults(
      DesktopSettingsSchema,
      read.value[SETTINGS_KEY],
    );
    if (invalidFields.length > 0) {
      log(`Ignoring invalid settings in ${file}: ${SETTINGS_KEY}.${invalidFields.join(", ")}`);
    }
    return value;
  }

  async function get(): Promise<DesktopSettings> {
    if (current) return current;
    loading ??= load();
    current = await loading;
    return current;
  }

  /** Updates run one at a time, so each builds on the one before. */
  let queue: Promise<unknown> = Promise.resolve();

  async function apply(patch: DesktopSettingsPatch): Promise<DesktopSettings> {
    const before = await get();
    const next: DesktopSettings = { ...before };
    if (patch.appearance !== undefined) next.appearance = patch.appearance;
    if (patch.toolCalls !== undefined) next.toolCalls = patch.toolCalls;
    current = next;
    await json.update((file) => {
      // Keys a newer version of the app wrote under "desktop" are kept too.
      const section = isJsonObject(file[SETTINGS_KEY]) ? file[SETTINGS_KEY] : {};
      return { ...file, [SETTINGS_KEY]: { ...section, ...next } };
    });
    return next;
  }

  return {
    get,
    update(input) {
      let patch: DesktopSettingsPatch;
      try {
        patch = validateInput(DesktopSettingsPatchSchema, input, "settings");
      } catch (error) {
        return Promise.reject(error);
      }
      const run = queue.then(
        () => apply(patch),
        () => apply(patch),
      );
      queue = run.catch(() => {});
      return run;
    },
  };
}

export interface WindowStateStore {
  load(windowId: string): Promise<WindowState>;
  save(windowId: string, state: unknown): Promise<void>;
}

export function createWindowStateStore(file: string, log: Logger): WindowStateStore {
  const json = createJsonFile(file, log);

  return {
    async load(windowId) {
      const read = await json.read();
      if (read.kind === "missing") return WindowStateSchema.parse({});
      if (read.kind === "unreadable") {
        log(`Using the default window layout: ${file} could not be read (${read.reason}).`);
        return WindowStateSchema.parse({});
      }
      const windows = read.value[WINDOWS_KEY];
      const raw = isJsonObject(windows) ? windows[windowId] : undefined;
      const { value, invalidFields } = parseWithFieldDefaults(WindowStateSchema, raw);
      if (invalidFields.length > 0) {
        log(`Ignoring invalid window state in ${file}: ${windowId}.${invalidFields.join(", ")}`);
      }
      return value;
    },
    async save(windowId, input) {
      const state = validateInput(WindowStateSchema, input, "window state");
      await json.update((file) => {
        const windows = isJsonObject(file[WINDOWS_KEY]) ? file[WINDOWS_KEY] : {};
        return { ...file, [WINDOWS_KEY]: { ...windows, [windowId]: state } };
      });
    },
  };
}
