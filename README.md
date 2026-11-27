# dawg-code

A Mac desktop coding agent that runs local models. Download a model with one click and work with an agent that reads code, edits files and runs commands, entirely on your own machine.

**Status:** early development. Nothing here is usable yet.

- [PLAN.md](PLAN.md) — what is being built and why.
- [docs/specs](docs/specs/README.md) — a technical spec for each phase.

## Compatibility

dawg-code reads Claude Code configuration files (`CLAUDE.md`, `.claude/skills`, `.claude/agents`, `.claude/commands`, hooks and `.mcp.json`) so an existing setup carries over.

Where a project's own files could widen what dawg may do, dawg is stricter than Claude Code on purpose. The sandbox for shell commands (`sandbox` in settings) is one such place:

- A project's shared settings (`.claude/settings.json`, `.dawg/settings.json`) cannot let sandboxed commands run without asking, cannot loosen the sandbox's isolation (local ports, sockets, system services, weaker network or nested isolation), and can open writes only inside the project. Your own settings, and the project's personal file, can.
- Hosts a project's files let sandboxed commands reach (`sandbox.network.allowedDomains`, and `WebFetch(domain:…)` allow rules), in the shared or the personal file, wait for your approval of the project's setup, like its hooks and MCP servers. Your own settings' hosts do not.

`dawg compat` names each setting dawg ignores, and why.

This project is independent. It is not affiliated with, endorsed by, or sponsored by Anthropic. "Claude" and "Claude Code" are trademarks of Anthropic, PBC.

## Development

Requires Node 24 or later. pnpm comes through Corepack, which ships with Node. Enable it once:

```bash
corepack enable
```

Then:

```bash
pnpm install
```

Fetch the pinned binaries the tests and the app use (the `llama-server` runtime and ripgrep). Each is checked against a recorded SHA-256 before it is unpacked:

```bash
pnpm fetch-runtime
```

```bash
pnpm fetch-ripgrep
```

```bash
pnpm build
```

```bash
pnpm test
```

```bash
pnpm lint
```

Without `corepack enable`, prefix commands with `corepack` and call the recursive form directly, for example `corepack pnpm -r build`.

### Layout

| Path                | Contents                                                      |
| ------------------- | ------------------------------------------------------------- |
| `apps/desktop`      | The Electron app                                              |
| `packages/protocol` | Schemas for messages between the engine and its clients       |
| `packages/engine`   | The agent loop, tools, permissions, sessions                  |
| `packages/compat`   | Readers for Claude Code configuration conventions             |
| `packages/models`   | Hardware probe, model catalog, downloader, runtime supervisor |
| `packages/cli`      | The headless `dawg` command                                   |
| `packages/mock-model` | A scripted model server for deterministic tests             |
| `evals/runner`      | Eval task runner and scoreboard                               |
| `evals/proxy`       | Recording proxy used by evals                                 |
| `evals/tasks`       | Eval tasks                                                    |
| `catalog`           | Model catalog data                                            |

### Conventions

- TypeScript, ES modules. Relative imports use the `.ts` extension.
- Only erasable TypeScript syntax (no enums, namespaces or parameter properties), so Node can run source files directly.
- Tests live next to the code as `*.test.ts` and run with Vitest.

## Licence

Apache-2.0. See [LICENSE](LICENSE) and [NOTICE](NOTICE).
