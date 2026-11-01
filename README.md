<div align="center">

# 🔬 doppeldiff

**See what your PR actually changed.**

doppeldiff runs the old and the new version of every changed function on thousands of generated inputs
and shows you, as concrete examples, every input where they behave differently.

<img src="docs/assets/pr-comment.png" alt="A doppeldiff pull request comment listing unclaimed behavior changes with concrete inputs and old/new results" width="760">

```bash
npx doppeldiff
```

</div>

## The problem

Writing code got cheap; verifying it did not. AI-written pull requests compile, pass CI and read well, yet quietly
change behavior on inputs nobody wrote a test for. AI review bots answer with opinions ("looks good to me"), so
you end up checking one model's code with another model's guess.

doppeldiff answers with evidence instead: **"for `cartTotal([{ unitPrice: -1, quantity: 1 }])` the old code
returned `-1` and the new code returns `0`"**. You can run that example yourself, and doppeldiff can write it into
a regression test for you.

## How it works

```
 git diff ──▶ changed exported functions (+ functions that call changed helpers)
                 │
                 ▼
 base version ──▶ sandboxed Node process ─┐
                                          ├──▶ same generated inputs ──▶ compare ──▶ shrink ──▶ group
 head version ──▶ sandboxed Node process ─┘     (types + values mined         returns, throws,    minimal,
                                                 from the code + regex         mutations, async,  readable
                                                 formats + edge cases)         timeouts           examples
                 │
                 ▼
 report: terminal · PR comment · JSON · regression tests        (optional LLM: claimed vs unclaimed)
```

1. **Find what changed.** It compares each module-level declaration with comments and formatting ignored, and
   follows changed helpers, constants and imports to the exported functions that use them.
2. **Load both versions side by side.** The base commit goes into a git worktree that reuses your
   `node_modules`, and each version is bundled with esbuild (TypeScript, ESM/CJS, tsconfig `paths`, workspaces).
3. **Generate inputs.** It derives input generators from the parameter types (via the TypeScript checker,
   [fast-check](https://fast-check.dev) underneath), biased towards values mined from the code: comparison
   thresholds ±1, string literals, regex formats, property names, and boundaries such as `NaN`, `-0` and lone
   surrogates.
4. **Run both, compare everything.** It compares return values (`NaN` equals `NaN`, `-0` differs from `0`; Dates,
   Maps, Sets and class instances structurally), thrown errors, argument mutations, async results, hangs and
   crashes. The clock is frozen and randomness seeded, so the comparison is reproducible.
5. **Explain it.** Each difference is shrunk to a minimal example, made readable (`2000` instead of
   `9007199254740991`), re-run to confirm, and grouped into behaviors such as _"now returns NaN (previously a
   number)"_.

## Three scenarios

The [`examples/demo-shop`](examples/demo-shop) library ships with three pull requests. All three pass the existing
test suite.

| PR                                                            | What doppeldiff says                                                                                                                                                                                                      |
| ------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Honest fix**: "Fix discount rounding for prices over $1000" | One behavior change, only for prices above 1000: `applyDiscount(2000, 0.07)` was `1859.99`, now `1860`.                                                                                                                   |
| **"AI refactor"**: "Pure refactor, no behavior change"        | ⚠️ 3 unclaimed changes: negative totals are now clamped to `0`, `cartTotal` returns `NaN` for zero-quantity items with a non-finite price, and `slugify("é")` was `"e"` and is now `""`. `itemCount` really is unchanged. |
| **Pure refactor**: "No behavior change intended"              | ✅ No behavior change in 4 functions across 3,242 inputs. The report notes that `addBusinessDays` stopped early (242 inputs) because huge `days` values make both versions loop past the timeout.                         |

Try it: `node examples/demo-shop/try.mjs ai-refactor` creates a scenario repository and prints the command.

<img src="docs/assets/demo.gif" alt="Terminal recording of doppeldiff on the AI refactor scenario" width="760">

<sub>The image and recording above are rendered from real doppeldiff output on the demo scenario
(`scripts/render-assets.ts`); the PR comment is rendered with GitHub's Markdown stylesheet.</sub>

## Results on real commits

We ran doppeldiff on 21 historical commits from ufo, validator.js, defu, es-toolkit, change-case, ms, slugify and
semver. **The full write-up, misses included, is in [docs/EVALUATION.md](docs/EVALUATION.md).** In short:

- It found **9 of 13** behavioral bug fixes, with minimal examples. One is `withoutBase("///", "//")`, the
  protocol-relative URL that a ufo security fix was about. Another is `isByteLength("\ud800")`, which used to
  throw `URIError`.
- On the **held-out** commits, with the code frozen, it found **2 of 6**. Two more were found only after we added
  regex-derived inputs, so we report them separately.
- It surfaced things the commit title did not say: validator's "restrict allowed characters" also started
  accepting one- and two-character slugs.
- It **could not verify 5 of 21 commits**: class methods, overloaded functions and UMD modules. Every report
  lists these explicitly.
- Each run took 1–6 seconds.

## Quick start

### CLI

```bash
npx doppeldiff                                  # your uncommitted changes vs HEAD
npx doppeldiff --base main                      # this branch vs main (merge base, like a PR)
npx doppeldiff --base main --claim "Fix rounding for prices over $1000"
npx doppeldiff --refactor                       # assert: no behavior change (exit 1 otherwise)
npx doppeldiff --write-tests                    # pin the examples in tests/doppeldiff/*.test.ts
npx doppeldiff --json report.json --markdown report.md
```

| Flag                                    | Default               |                                           |
| --------------------------------------- | --------------------- | ----------------------------------------- |
| `--base` / `--head`                     | `HEAD` / working tree | Revisions to compare (via merge base)     |
| `--claim`, `--claim-file`, `--refactor` |                       | What the change claims to do              |
| `--runs`                                | `1000`                | Max inputs per function                   |
| `--timeout`                             | `250`                 | Per-call timeout (ms)                     |
| `--budget`                              |                       | Total exploration time budget (s)         |
| `--seed`                                | `1`                   | Every run is reproducible                 |
| `--fail-on`                             | `unclaimed`           | Exit 1 on `unclaimed`, `any` or `never`   |
| `--include` / `--exclude` / `--only`    |                       | Limit files or functions                  |
| `--no-freeze`                           |                       | Do not freeze the clock / seed randomness |
| `--llm`, `--llm-model`                  | `auto`                | Optional LLM layer (below)                |

Node.js 22.13 or newer. Exit codes: `0` OK, `1` findings matching `--fail-on`, `2` tool error.

### GitHub Action

Copy [`examples/workflows/doppeldiff.yml`](examples/workflows/doppeldiff.yml) to `.github/workflows/`. That is the
whole setup. It posts one sticky comment per PR and updates it on every push. It is safe for pull requests from
forks: the job that runs PR code has no secrets and a read-only token, and the job that comments never runs PR
code. See [docs/ACTION.md](docs/ACTION.md).

### MCP server for coding agents

```bash
claude mcp add doppeldiff -- npx -y doppeldiff mcp
```

Two tools: `verify_change` (what did my edit change?) and `verify_refactor` (PASS, or FAIL with
counterexamples). An agent can check its own refactor before telling you it is done. Setup for Cursor and Codex
is in [docs/MCP.md](docs/MCP.md).

### Optional: claim matching with an LLM

With `ANTHROPIC_API_KEY` or `OPENAI_API_KEY` set, doppeldiff compares each behavior change with the PR
description and labels it **claimed**, **unclaimed** or **suspicious**, with a one-sentence explanation. It can
also suggest targeted edge-case inputs. The LLM only labels changes that the deterministic engine actually
observed. Its output is checked against the evidence (no invented IDs, no values that do not appear in the
examples), and without a key everything works the same, just without the labels. A PR description that says
"no behavior change" is enough to flag every difference, no LLM needed.

### Configuration (optional)

```ts
// doppeldiff.config.ts
import { defineConfig } from 'doppeldiff';

export default defineConfig({
  exclude: ['src/legacy/**'],
  compare: { epsilon: 1e-9 },
  functions: {
    // Declare the real input domain when generated inputs are too broad.
    'src/semver.ts#compareIdentifiers': {
      args: (fc) => fc.tuple(fc.nat(), fc.nat()),
    },
    parseConfig: { skip: 'reads files; covered by integration tests' },
  },
});
```

## Limitations

v1 is deliberately narrow. Known gaps:

- **Exported functions only.** It does not test class methods, overloaded functions, generators, or UMD/IIFE
  modules. They are listed as "not verified" in every report. Class methods are the biggest gap in practice.
- **Pure-ish code.** Functions that read files, call the network or depend on global state either fail in the
  sandbox or are reported as nondeterministic. They are not mocked.
- **Generated inputs are not a proof.** "No behavior change across 10,000 inputs" is strong evidence, not a
  guarantee. Bugs that need a very specific input (a valid ISO ordinal date, prototype-chain objects, `DataView`)
  can be missed; see the [misses in the evaluation](docs/EVALUATION.md#why-the-misses-happen). Optional LLM input
  suggestions help with some of these.
- **Input domain.** Generators follow the types, not the documentation. A function that is only ever called with
  non-negative numbers may report differences for negative ones. Declare the domain in the config (`args`).
- **Signature changes.** If the parameter types change incompatibly, the old and new versions cannot receive
  the same inputs, so the function is reported as skipped.
- **Slow paths.** Functions that loop for a long time on large inputs hit the per-call timeout. Exploration stops
  after 20 such inputs, and the report says how many inputs actually ran.
- **The sandbox is a guardrail, not a security boundary.** The code under test runs with the Node.js permission
  model, no network and a scrubbed environment, but you should only run doppeldiff on code you would run tests
  for. See [SECURITY.md](SECURITY.md).
- **JavaScript and TypeScript only.**

## How it compares

|                                                                                                                                                                                                           | What it does                                                                                                                                    | How doppeldiff differs                                                                                                                                                                       |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **AI review bots**                                                                                                                                                                                        | Read the diff and give an opinion                                                                                                               | doppeldiff runs the code and shows inputs and results                                                                                                                                        |
| **[fast-check](https://fast-check.dev)**                                                                                                                                                                  | Property-based testing library                                                                                                                  | doppeldiff is built on it; it adds change detection, loading both versions in isolation, generators derived from types and code, comparison semantics and reporting. You write no properties |
| **[RealDiff](https://github.com/issacnitin/RealDiff)** (formerly BehaviorDiff)                                                                                                                            | Runs your **existing tests** on both sides of a PR and diffs recorded values (6 languages)                                                      | doppeldiff **generates** inputs, so it finds differences on inputs no test covers. RealDiff sees real call sites; the two are complementary                                                  |
| **[receipts-cli](https://www.npmjs.com/package/receipts-cli)**                                                                                                                                            | Enforces that an agent's fix comes with a test that is red on base and green on head, checks that the test has teeth, and adds agent guardrails | It verifies the test the author wrote for the claim; doppeldiff looks for changes nobody claimed or tested. They work well together: doppeldiff's `--write-tests` can produce such tests     |
| **[ProofDiff](https://www.npmjs.com/package/proofdiff)**                                                                                                                                                  | Reports what changed, which related tests ran and what remains unverified (static by default)                                                   | ProofDiff tracks test evidence; doppeldiff creates behavioral evidence by running old and new code                                                                                           |
| **[Keploy](https://keploy.io)**                                                                                                                                                                           | Records and replays API traffic as tests                                                                                                        | API level with recorded traffic; doppeldiff works at function level on generated inputs                                                                                                      |
| **[Testora](https://conf.researchr.org/details/icse-2026/icse-2026-research-track/10/Testora-Using-Natural-Language-Intent-to-Detect-Behavioral-Regressions)**, **DiffTestGen**, Mokav (research, Python) | LLM-generated tests that expose differences between versions; Testora classifies them against the PR text                                       | The same idea, and evidence that it works. doppeldiff is a deterministic-first tool you can install (no key needed), for TypeScript, with an Action and an MCP server                        |
| **[CrossHair `diffbehavior`](https://crosshair.readthedocs.io/en/latest/diff_behavior.html)** (Python)                                                                                                    | Symbolic execution finds inputs where two functions differ                                                                                      | Python only, and you target functions by hand; no git or PR integration                                                                                                                      |
| **BERT** (Jin, Orso, Xie 2010; Java)                                                                                                                                                                      | The original "behavioral regression testing"                                                                                                    | The academic origin of the technique                                                                                                                                                         |

## Roadmap

- Class methods (construct instances from constructor parameters, compare state after each call)
- Coverage-guided input generation (V8 coverage of the changed lines)
- Overloaded functions and UMD modules
- Side-effect sandboxing: virtual filesystem and recorded `fetch` for less pure code
- HTTP-level diffs for request handlers
- Python

## Contributing

Contributions are welcome. See [CONTRIBUTING.md](CONTRIBUTING.md). The design is documented in
[docs/DESIGN.md](docs/DESIGN.md).

## License

[MIT](LICENSE)
