# Phase 1 — Model layer

_Draft spec. Roadmap: [PLAN.md](../../PLAN.md) section 9. Shared conventions: [README](README.md)._

## Outcome

A person installs the app on a clean Mac, clicks one button, and is chatting with a local model. No terminal, no other software. Behind that button: a hardware probe, a model catalog, a resumable downloader, and a supervisor that runs `llama-server` with the right settings.

## Scope

**In**

- `packages/models`: hardware probe, catalog, downloader, existing-model scanner, runtime supervisor, endpoint abstraction.
- Bundling the pinned `llama-server` into the app.
- Attaching to a running Ollama or LM Studio, or to a remote URL.
- A minimal app: onboarding, download progress, plain streaming chat, a models settings page.

**Out**

- Tools, permissions, sessions (Phase 2). The chat here is plain text.
- The MLX engine pack (Phase 5).
- Code signing and notarization (Phase 5). Dev builds run unsigned.

## Depends on

- Phase 0: workspace, CI, the runtime pin and fetch script.
- The reference Mac for sign-off. Everything else can be built and tested without it.

## Design

### Components

```
packages/models
  hardware.ts     probe the machine
  catalog.ts      load, validate, recommend
  download.ts     Hugging Face listing, resumable transfer, verification
  scan.ts         find models other apps already downloaded
  runtime.ts      spawn and supervise llama-server
  endpoint.ts     one shape for "something that serves chat completions"
```

The package runs in the main process and exposes a small API to the renderer through the preload bridge: list and recommend models, start / pause / cancel a download, start and stop the runtime, and streams of progress and status events.

### Hardware probe

Reads once at launch, via `sysctl` and the filesystem:

```ts
interface HardwareProfile {
  arch: "arm64" | "x64";
  chip: string; // e.g. "Apple M4 Max"
  chipClass: "base" | "pro" | "max" | "ultra" | "intel";
  memoryBytes: number;
  performanceCores: number;
  freeDiskBytes: number; // on the volume holding the model cache
  macosVersion: string;
}
```

### Catalog

A JSON file validated against a schema. The app loads the bundled copy, then tries to fetch a newer one from the repo and caches it. A failed or invalid fetch falls back silently to the last good copy.

```ts
interface CatalogEntry {
  id: string; // "qwen3.8-27b-q8"
  displayName: string;
  licence: { spdx: string; url: string };
  source: { repo: string; revision: string; file: string; sha256: string; sizeBytes: number };
  projector?: { file: string; sha256: string; sizeBytes: number }; // vision models
  minMemoryBytes: number;
  chipClasses?: HardwareProfile["chipClass"][]; // omit = any Apple Silicon
  context: { default: number; max: number };
  capabilities: { tools: boolean; vision: boolean; reasoning: boolean };
  profile: string; // id of the per-model profile, used from Phase 2
  rank: number; // order among entries that fit the same machine
}
```

- `source.revision` is a commit hash, not a branch, so a catalog entry always means the same bytes.
- **Recommendation:** keep entries where `minMemoryBytes` fits and the chip class matches, then take the highest `rank`. `minMemoryBytes` is set per entry using the rule in PLAN.md section 6 (weights + cache at the default context + 2 GB within about 70% of memory).
- Machines below the smallest tier get no recommendation. They see "Load a model file" and "Connect to a server" instead.

### Downloader

| Step        | How                                                                                 |
| ----------- | ----------------------------------------------------------------------------------- |
| List        | `GET /api/models/{repo}/tree/{revision}` gives each file's size and SHA-256         |
| Check space | Require the file size plus 10% free; fail before starting if not                    |
| Transfer    | `GET /{repo}/resolve/{revision}/{file}` with a `Range` header, following redirects  |
| Resume      | Partial data lives in `<sha256>.incomplete`; on restart, continue from its length   |
| Verify      | Hash while writing; compare to the catalog's SHA-256; delete and report on mismatch |
| Commit      | Atomic rename into the cache                                                        |

- Retries use exponential backoff. A server that ignores `Range` restarts the file from zero rather than corrupting it.
- Pause, resume and cancel are first-class. Progress events carry bytes done, total, speed and estimated time left.
- **Storage** follows the standard Hugging Face cache layout so other tools can share the files: `hub/models--<org>--<name>/blobs/<sha256>`, with `snapshots/<revision>/<file>` linking to the blob. `HF_HOME` and `HF_HUB_CACHE` are honoured.
- Only ungated repos are in the catalog, so no Hugging Face login is needed.

### Existing-model scanner

Looks in three places and matches by SHA-256 against catalog entries, so a model the user already has is offered as "ready" instead of downloaded again:

| Source             | Location                                        |
| ------------------ | ----------------------------------------------- |
| Hugging Face cache | `~/.cache/huggingface/hub`                      |
| LM Studio          | `~/.lmstudio/models/<publisher>/<model>/*.gguf` |
| Ollama             | `~/.ollama/models/manifests` → `blobs/sha256-*` |

Files are used in place. The scanner never moves, links into, or modifies another app's directory. Hashing large files is slow, so results are cached by path, size and modification time.

### Runtime supervisor

Owns the single `llama-server` child process.

**Launch**

```
llama-server -m <model path> --host 127.0.0.1 --port <free port> --api-key-file <0600 temp file>
  -c <window + 8192> -np 2 --kv-unified --kv-unified-per-slot <window> -ngl all --no-ui --offline
  --slot-save-path ~/.dawg/runtime/slots --cache-ram <MiB>
  --ctx-checkpoints <n> --checkpoint-min-step <n>
  --log-file ~/.dawg/logs/llama-server.log
```

These flags were checked against the pinned build's `--help`. The pin is llama.cpp build `b12359`, the build behind the `v1.0.0` release, recorded with archive hashes in `runtime.lock.json`. The flags are re-checked whenever the pin is bumped. Template handling (`--jinja`), prompt caching and reasoning preservation are on by default in that build.

Findings from the first implementation, on the pinned build:

- `--no-webui` is deprecated in favour of `--no-ui`.
- `GET /v1/models` and `GET /props` require the API key; `GET /health` does not.
- A warm-up request must ask for one token: zero still generates one.
- The server does not validate slot ids, and restoring a missing slot file returns a misleading error, so the supervisor checks both itself.
- `--log-file` truncates on each launch. The supervisor keeps its own rotated capture in `runtime.log`.
- The child is tied to the app through a small watchdog process, so it dies even if the app is killed outright.

| Setting                 | Chosen from                                                                          |
| ----------------------- | ------------------------------------------------------------------------------------ |
| Context                 | The catalog entry's default, capped by what memory allows                            |
| Slots                   | 1 for the main agent, plus subagent slots when memory allows (see PLAN.md section 6) |
| Cache size, checkpoints | The model's profile                                                                  |
| Reasoning options       | The model's profile                                                                  |

**Lifecycle**

| State      | Meaning                        | Leaves when                                                        |
| ---------- | ------------------------------ | ------------------------------------------------------------------ |
| `starting` | Process spawned, model loading | `GET /health` returns 200 (it returns 503 while loading)           |
| `ready`    | Serving                        | Stop requested, crash, or idle timeout                             |
| `crashed`  | Exited unexpectedly            | Restarted with backoff, at most 3 times, then surfaced to the user |
| `stopped`  | Not running                    | Start requested                                                    |

- Stop is SIGTERM, then SIGKILL after a grace period. The child is also killed if the app exits for any reason.
- Changing model or context restarts the process.
- After an idle period (configurable, off by default) the model is unloaded to free memory and reloaded on the next message.
- After start, the supervisor reads `GET /props` and `GET /v1/models` and reports the _actual_ context window and template capabilities, which is what the rest of the app trusts.

**Prompt cache hooks.** The supervisor exposes two operations the engine uses from Phase 2: _warm_ (send a prefix so it is processed and cached before the user types) and _save / restore_ a slot through `POST /slots/{id}?action=save|restore`. Saved caches are keyed by a hash of the model file, the template and the prefix bytes, so a stale cache is never restored.

**Progress.** Chat requests set `return_progress`, so the UI can show how much of the prompt has been read while a long context is processed.

### Endpoint abstraction

Everything downstream talks to an `Endpoint`, never to the supervisor directly:

```ts
interface Endpoint {
  kind: "bundled" | "ollama" | "lmstudio" | "remote";
  baseUrl: string; // OpenAI-compatible root
  apiKey?: string;
  model: string;
  contextWindow: number; // the real one, as reported
  capabilities: { tools: boolean; vision: boolean; reasoning: boolean; cacheControl: boolean };
}
```

- **Bundled:** produced by the supervisor. `cacheControl` is true: slots, warm-up and save / restore are available.
- **Ollama / LM Studio:** detected by probing their default local ports. Offered in settings, never chosen silently. `cacheControl` is false.
- **Remote:** a URL and key typed by the user. The key is stored in the Keychain.

### Context and slots

Settled on 2026-11-24 against the pinned build (b12359). The bundled runtime runs two slots, one for conversations and one for side requests such as titles, over one unified KV cache: `-c <window + 8192> -np 2 --kv-unified --kv-unified-per-slot <window>`. Each slot's window is then `<window>` (llama-server reports it in `/props` as `n_ctx`), and the cache holds one window plus a small reserve for the side slot instead of two full windows. Without `--kv-unified`, llama-server splits `-c` evenly between slots. The app and the command-line tool both take this layout from `twoSlotLayout` (`packages/models/src/runtime/args.ts`), and the app's memory check counts `<window + 8192>` tokens of cache.

### Bundling the runtime

- A lock file records the llama.cpp release tag and the SHA-256 of each macOS archive (arm64 and x64).
- The fetch script downloads, verifies and unpacks them into `apps/desktop/resources/runtime/<arch>/`, including the libraries the binary loads.
- The packaged app carries llama.cpp's licence text.
- `DAWG_RUNTIME_BIN` points the supervisor at a different binary for development.

### Minimal app

| Screen            | Content                                                                                                                        |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| Welcome           | What was detected about this Mac; the recommended model with size and licence; **Download and start**; links to "More options" |
| Downloading       | Progress, speed, time left, pause and cancel                                                                                   |
| Starting          | Model loading state from the supervisor                                                                                        |
| Chat              | Plain streaming chat against the endpoint, with stop                                                                           |
| Settings → Models | Installed and available models, delete, load a model file, connect to a server                                                 |

"Load a model file" accepts any GGUF and skips the memory check after a warning. It is the supported way to try a small model on a small Mac.

## Work breakdown

1. Hardware probe and catalog schema, loader and recommendation.
2. Downloader with resume, verification and the shared cache layout.
3. Runtime supervisor: launch, health, restart, stop, logs.
4. Endpoint abstraction; Ollama, LM Studio and remote detection.
5. Electron shell with the preload bridge and the minimal screens.
6. Existing-model scanner.
7. Warm-up and slot save / restore hooks.
8. First catalog file with entries for 24 GB through 128 GB.

## Testing

| Layer       | What                                                                                                                      |
| ----------- | ------------------------------------------------------------------------------------------------------------------------- |
| Unit        | Recommendation across a table of hardware profiles; memory-fit maths; cache path layout                                   |
| Integration | Downloader against a local test server that supports ranges and can drop connections, send wrong bytes, or ignore `Range` |
| Integration | Supervisor against the real binary with a tiny model in CI: start, health, chat, kill and auto-restart, clean stop        |
| End-to-end  | The onboarding flow in the packaged app, with the catalog pointed at a tiny test model                                    |
| Manual      | The same flow on the reference Mac with its recommended catalog model                                                     |

## Done when

- On the reference Mac with nothing pre-installed: install, click once, and get a streamed reply from the recommended model.
- Killing the network mid-download and relaunching the app resumes the download and ends with a verified file.
- Killing `llama-server` during a chat is recovered without restarting the app.
- A model already downloaded by LM Studio or Ollama is detected and offered without a new download.
- No orphaned `llama-server` process remains after the app quits or crashes.

## Open questions

- Whether to use llama-server's own router mode for model switching instead of restarting. Restart is simpler; revisit if switching feels slow.
- Whether the catalog needs a signature beyond HTTPS from the repo.
- Local speed and memory numbers for every catalog entry. These can only be measured on the reference Mac.
