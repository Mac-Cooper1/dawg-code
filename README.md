# dawg-code

A Mac desktop coding agent that runs local models. Download a model with one click and work with an agent that reads code, edits files and runs commands, entirely on your own machine.

**Status:** early development. Nothing here is usable yet.

- [PLAN.md](PLAN.md) — what is being built and why.
- [docs/specs](docs/specs/README.md) — a technical spec for each phase.

## Compatibility

dawg-code reads Claude Code configuration files (`CLAUDE.md`, `.claude/skills`, `.claude/agents`, `.claude/commands`, hooks and `.mcp.json`) so an existing setup carries over.

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
