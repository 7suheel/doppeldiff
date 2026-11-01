# Contributing to doppeldiff

Thanks for helping! Issues with a minimal reproduction (two versions of a function and the command you ran) are
the most useful bug reports.

## Development

```bash
npm ci
npm run check        # typecheck, lint, format check, all tests
npm test             # tests only (unit + end-to-end; spawns sandboxed Node processes)
npm run build        # dist/ (CLI and library)
npm run build:action # action/dist (committed; CI checks it is up to date)
npm run bench        # runner throughput
```

Node.js 22.13+ and git are required. Tests never call LLM APIs or GitHub; they use fakes and local mock servers.

## Layout

| Path                                      |                                                                               |
| ----------------------------------------- | ----------------------------------------------------------------------------- |
| `src/core/detect`                         | git diff → changed exported functions, transitive impact                      |
| `src/core/git`                            | worktrees, dependency reuse/install                                           |
| `src/core/types`                          | TypeScript types → `ArbSpec`                                                  |
| `src/core/arbitraries`                    | `ArbSpec` → fast-check, value mining                                          |
| `src/core/runner`                         | sandboxed child processes, encoding, determinism                              |
| `src/core/compare`, `src/core/explore`    | comparison, exploration, shrinking, clustering                                |
| `src/core/report`                         | report model (zod), terminal, Markdown, regression tests                      |
| `src/core/claims`                         | optional LLM layer                                                            |
| `src/cli.ts`, `src/mcp.ts`, `src/action/` | interfaces                                                                    |
| `examples/demo-shop`                      | demo library and scenario patches (do not reformat: the patches depend on it) |

## Guidelines

- TypeScript strict; keep the core deterministic (seeded) and free of network access.
- New generators or comparison rules need unit tests. Changes that affect what doppeldiff finds should be run
  against the evaluation (`scripts/evaluate.sh`) and reported honestly in the PR, including regressions.
- Keep the security model intact: nothing from the code under test or from a pull request may reach secrets or
  decide which findings exist.
