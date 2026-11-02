# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses [Semantic Versioning](https://semver.org/).
Before 1.0, minor versions may contain breaking changes to the CLI, the config and the JSON report.

## [0.1.1] - 2026-11-02

Faster and tidier on code that loops over a count or allocates by a length. On the playground demo PR, one run went
from 55 s to 9 s, and every function is now explored to the full input budget.

### Changed

- **Realistic sizes.** Parameters used as counts, lengths, indexes or loop bounds (`for (…; i < n; …)`,
  `Array.from({ length: n })`, `s.repeat(n)`, `xs[i]`, or names such as `count`, `size`, `limit`) are generated
  mostly as small non-negative integers and values from the code and its tests. Huge values and NaN/Infinity
  stay in as rare edge cases (about 1.5%).
- **Timeouts no longer stop a function.** A timeout on an edge-case input (huge number, NaN, …) does not count
  towards stopping. After two, similar inputs are skipped and exploration continues. A timeout on an ordinary
  input is re-run once on its own before it counts, because a busy machine can make a fast call miss its
  deadline.
- **Compact report.** Long arrays, objects, maps and sets are abbreviated (`[0, 1, 0, 1, 0, 1, … 994 more]`), or
  shown in full when abbreviating would hide the difference. Examples with long outputs rank lower. Behaviors
  that involve a timeout get one example in the collapsed edge-case section, with a one-line note of which
  functions timed out on edge-case inputs.
- JSON report: optional `edgeTimeouts` and `skippedEdgeInputs` per function.

### Fixed

- After a call was stopped by the in-process timeout, the runner kept its heap. A call that grew a huge array
  slowed the following inputs into false timeouts. The runner process is now replaced after such a timeout.

## [0.1.0] - 2026-11-02

First public release.

### Differential testing

- Detects changed exported functions between two git revisions (ESM, CommonJS, TypeScript and JavaScript with
  JSDoc types), including functions affected through changed helpers in the same file or in other files.
- Runs the old and new version of each function on generated inputs (1,000 per function by default) in sandboxed
  child processes: Node permission model, no network, frozen clock, seeded randomness, per-call timeouts.
- Inputs are derived from the parameter types and biased with values from the code (literals, regexes, property
  names, module-level constants), from the project's tests and literal call sites, and with strings on which a
  changed regex disagrees between the two versions. Supports primitives, objects, arrays, tuples, unions, records,
  `Date`, `Map`, `Set`, binary data (`DataView`, `ArrayBuffer`, typed arrays), callbacks and recursive types.
- Shrinks counterexamples, groups them into behaviors and picks readable examples.
- Rates every example by realism (seen in tests/call sites, ordinary, unusual, edge) and collapses behaviors that
  only happen on edge-case inputs. Input domains come from the old version's guard clauses, or from `where` in
  `doppeldiff.config.ts`.
- Compares return values, thrown errors, resolved/rejected promises and argument mutations.
- Generates regression tests (Vitest or Jest) for the reported behaviors.
- Works in npm workspaces (each version uses its own workspace packages) and with tsconfig path aliases. Installs the base version's dependencies with scripts disabled when the lockfile changed.

### Claim matching

- Compares observed behaviors with the PR title and description using documented, deterministic rules: no LLM,
  no API key, no network ([docs/CLAIMS.md](docs/CLAIMS.md)).
- Optional LLM labels with a local model (Ollama or any OpenAI-compatible server), or Anthropic/OpenAI with your
  own key. Never used unless turned on.

### Interfaces

- CLI with terminal, Markdown and JSON output (`--json`, JSON Schema in `schema/report.schema.json`), exit codes
  for CI (`--fail-on any|unclaimed|never`).
- GitHub Action with a fork-safe two-workflow setup that posts and updates one sticky PR comment.
- MCP server for coding agents (`verify_change`, `verify_refactor`).

### Known limitations

- Not verified: class methods, overloaded functions, UMD/IIFE modules, class-instance parameters and exported
  values that are not functions. They are listed in every report.
- Random generation misses bugs that need several specific conditions at once; see
  [docs/EVALUATION.md](docs/EVALUATION.md) for measured detection rates and every miss.

[0.1.1]: https://github.com/7suheel/doppeldiff/releases/tag/v0.1.1
[0.1.0]: https://github.com/7suheel/doppeldiff/releases/tag/v0.1.0
