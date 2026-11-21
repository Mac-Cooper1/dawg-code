# Eval scoreboard

Sources: `2026-11-20-claude-code-qwen3.8-27b.jsonl`, `2026-11-20-opencode-qwen3.8-27b.jsonl`

| Agent | Model | Passed | Pass rate | Tasks | Skipped | Errors |
| --- | --- | --- | --- | --- | --- | --- |
| claude-code | qwen3.8-27b | 2/2 | 100% | 2 | 0 | 0 |
| opencode | qwen3.8-27b | 2/4 | 50% | 2 | 1 | 1 |

## claude-code / qwen3.8-27b

Endpoint: `https://api.example/v1`
Label: hosted bf16

Cost columns are medians per run.

| Task | Passed | Pass rate | Wall (s) | Requests | Prefix tokens | Prompt tokens | Completion tokens | Malformed tool calls (total) | Cache reuse |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `fix-test` | 1/1 | 100% | 900.0 | 30 | 19000 | 600000 | 9000 | 0 | - |
| `rename` | 1/1 | 100% | 120.0 | 8 | 19000 | 160000 | 1500 | 0 | - |
| **Overall** | 2/2 | 100% | 510.0 | 19 | 19000 | 380000 | 5250 | 0 | - |

## opencode / qwen3.8-27b

Endpoint: `https://api.example/v1`
Label: hosted bf16

Cost columns are medians per run.

| Task | Passed | Pass rate | Wall (s) | Requests | Prefix tokens | Prompt tokens | Completion tokens | Malformed tool calls (total) | Cache reuse |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `fix-test` | 2/3 | 67% | 50.0 | 14 | 9500 | 170000 | 2500 | 4 | 0.90 |
| `rename` | 0/1 | 0% | - | - | - | - | - | 0 | - |
| **Overall** | 2/4 | 50% | 50.0 | 14 | 9500 | 170000 | 2500 | 4 | 0.90 |

Skipped:

- `use-mcp`: agent lacks: mcp

Errors (counted as failures):

- `rename` trial 1: agent could not start: spawn opencode ENOENT
