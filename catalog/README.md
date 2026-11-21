# Model catalog

`catalog.json` lists the models the app can download with one click. The app ships a copy, then
tries to fetch a newer one at launch; an invalid or failed fetch silently falls back to the last
good cached copy, then to the bundled one. The schema lives in
`packages/models/src/catalog/schema.ts` and the tests in
`packages/models/src/catalog/catalog.test.ts` check this file on every run.

## File format

```json
{ "schemaVersion": 1, "version": 1, "entries": [ ... ] }
```

| Field           | Meaning                                                                         |
| --------------- | ------------------------------------------------------------------------------- |
| `schemaVersion` | Format of this file. Always `1` for now.                                        |
| `version`       | Increase by one with every change. A fetched or cached copy is used only if its version is not older than the bundled one. |
| `entries`       | One object per downloadable model and quantization.                            |

## Entry fields

| Field                 | Meaning                                                                                                   |
| --------------------- | --------------------------------------------------------------------------------------------------------- |
| `id`                  | Stable id, lowercase: `<model>-<quant>`, for example `qwen3.8-27b-q8`. Never reuse an id for other bytes. |
| `displayName`         | What the user sees.                                                                                       |
| `licence.spdx`        | SPDX identifier, or `LicenseRef-<name>` when the licence is not on the SPDX list.                         |
| `licence.url`         | HTTPS link to the licence text, shown before download.                                                    |
| `source.repo`         | Hugging Face repo, `org/name`. Ungated repos only: no login is needed.                                    |
| `source.revision`     | Full 40-character commit hash, never a branch, so an entry always means the same bytes.                   |
| `source.file`         | Path of the GGUF file in the repo. Single-file models only.                                               |
| `source.sha256`       | SHA-256 of the file (`lfs.oid` in the tree API). The download is checked against it.                      |
| `source.sizeBytes`    | Exact size in bytes (`size` in the tree API).                                                             |
| `projector`           | Vision projector (`mmproj`) from the same repo and revision: `file`, `sha256`, `sizeBytes`. Required exactly when `capabilities.vision` is true. |
| `minMemoryBytes`      | Smallest unified memory (as `hw.memsize` reports it, so 32 GB is `34359738368`) the entry is offered on.   |
| `chipClasses`         | Optional. Restricts the entry to these chip classes (`base`, `pro`, `max`, `ultra`). Omit for any Apple Silicon. |
| `context.default`     | Context the runtime starts with. Must satisfy the memory rule below at `minMemoryBytes`.                  |
| `context.max`         | The model's native maximum context.                                                                       |
| `capabilities`        | `tools`, `vision`, `reasoning`, from the model card.                                                      |
| `profile`             | Id of the per-model profile (sampler, reasoning, template settings).                                      |
| `rank`                | Order among entries that fit the same machine. Higher wins; the top fitting entry is the recommendation.  |

## The memory rule

From PLAN.md section 6: **model file + projector + cache at `context.default` + 2 GiB must fit in
70% of `minMemoryBytes`.** The cache size per token is an estimate per repo in
`CACHE_BYTES_PER_TOKEN` (`packages/models/src/catalog/memory.ts`): f16 keys and values for every
full-attention layer, `2 × kv_heads × head_dim × 2 bytes`, read from the model's `config.json`.
Sliding-window and linear-attention layers keep a fixed-size state that the 2 GiB covers.

## Adding an entry

1. Pick an ungated repo and get the commit hash: `GET https://huggingface.co/api/models/<repo>` → `sha`.
2. List the files at that commit: `GET https://huggingface.co/api/models/<repo>/tree/<sha>?recursive=true`.
   Copy the file's `path`, `size` and `lfs.oid` exactly. Do the same for the `mmproj` file if the
   model has vision (prefer the F16 projector).
3. Read the model card for the licence, native context length and capabilities.
4. Add the repo's cache-per-token estimate to `CACHE_BYTES_PER_TOKEN` if it is a new architecture,
   with the arithmetic in a comment.
5. Set `minMemoryBytes` to a real Mac memory size (24, 32, 36, 48, 64, 96, 128 GiB …) where the
   memory rule holds at `context.default`; choose the highest precision that fits and never go
   below 4-bit.
6. Set `rank` so it orders correctly against existing entries on every machine it fits, and bump
   `version`.
7. Run the catalog tests. Never guess a hash, size or file name: if a value cannot be read from the
   Hugging Face API, leave the entry out.

No model enters the default catalog without passing the eval suite (PLAN.md section 6).

## Current entries (checked against the Hugging Face API on 2026-11-20)

| Id                   | Repo and file                                                  | Size     | Tier        | Notes |
| -------------------- | -------------------------------------------------------------- | -------- | ----------- | ----- |
| `gpt-oss-20b-q4`     | `unsloth/gpt-oss-20b-GGUF` / `gpt-oss-20b-Q4_K_M.gguf`         | 11.6 GB  | 24 GiB      | Text only, 64K default context |
| `qwen3.8-27b-q4`     | `unsloth/Qwen3.8-27B-GGUF` / `Qwen3.8-27B-UD-Q4_K_M.gguf`      | 16.6 GB  | 32 GiB      | Plus `mmproj-F16.gguf` (0.93 GB), 64K |
| `qwen3.6-35b-a3b-q4` | `unsloth/Qwen3.6-35B-A3B-GGUF` / `Qwen3.6-35B-A3B-UD-IQ4_NL.gguf` | 18.0 GB | 32 GiB, base and Pro | Sparse; plus `mmproj-F16.gguf` (0.90 GB), 128K as its card advises |
| `laguna-xs-2.1-q4`   | `poolside/Laguna-XS-2.1-GGUF` / `Laguna-XS-2.1-Q4_K_M.gguf`     | 20.3 GB  | 36 GiB, base and Pro | Sparse, text only, 64K; OpenMDW-1.1 licence |
| `qwen3.8-27b-q6`     | `unsloth/Qwen3.8-27B-GGUF` / `Qwen3.8-27B-UD-Q6_K.gguf`        | 22.0 GB  | 48 GiB      | Plus projector, 128K |
| `qwen3.8-27b-q8`     | `unsloth/Qwen3.8-27B-GGUF` / `Qwen3.8-27B-Q8_0.gguf`           | 29.0 GB  | 64 GiB and up | Plus projector, 200K |
