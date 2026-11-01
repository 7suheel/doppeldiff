# Design: behavioral diffs for pull requests

> Status: **Approved (2026-11-01).** Name: **doppeldiff**. Decisions are recorded in §7.

Tagline: **"See what your PR actually changed."**

---

## 0. One-paragraph summary

For every exported function whose behavior may have changed between two git revisions, the tool
loads the old and new versions into two isolated, sandboxed Node processes. It derives input
generators from the TypeScript parameter types, enriches them with values mined from the code and
the existing tests, and feeds identical inputs to both versions. Every observable difference
(return value, thrown error, argument mutation, async resolution, timeout or crash) is shrunk to a
minimal counterexample and clustered into distinct behavior changes. Optionally, an LLM matches each
cluster against the PR description, and the tool validates the LLM's output against the evidence.
The output is a terminal report, a sticky PR comment, a stable JSON report and a ready-to-commit
regression test file. The core runs with no API key and is reproducible from a seed.

---

## 1. Name availability

Checked on 2026-11-01 (npm registry plus GitHub repository search):

| Name            | npm        | GitHub                    | Notes                                                                                                                           |
| --------------- | ---------- | ------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `receipts`      | **taken**  | crowded (641 repos match) | npm package dates from 2017. Its current description is "Deterministic evidence for code changes", which overlaps conceptually. |
| `receipts-cli`  | **taken**  | —                         | Active (created 2026-06, updated 2026-10-23): _"Verification gates for AI-written code"_. Direct positioning collision.         |
| `@receipts/cli` | scope free | —                         | `npx receipts` would still resolve to the _other_ package. Confusing.                                                           |
| `doppeldiff`    | free       | 0 repos                   |                                                                                                                                 |
| `twinrun`       | free       | 6 repos                   |                                                                                                                                 |
| `counterproof`  | free       | 6 repos                   |                                                                                                                                 |
| `behaviordiff`  | free       | taken                     | `BehaviorDiff` was the earlier name of RealDiff (prior art, see §2), so avoid it.                                               |

**Conclusion: do not ship as `receipts`, and do not use "receipts" as vocabulary either** (it would
send people to a similarly-described package). Chosen name: **doppeldiff**. The PR comment header is
"🔬 doppeldiff"; the regression test folder is `tests/doppeldiff/`. Candidates considered:

1. **`doppeldiff`** _(recommended)_. Runs your function's doppelgänger (old version) next to it and
   diffs behavior. Memorable, unique (0 GitHub repos, so we would own the search results), and says
   "diff", so developers immediately get that it compares versions. `npx doppeldiff`.
2. **`twinrun`**. Short and describes the mechanism. Slightly generic, and it does not say "diff"
   or "verify".
3. **`counterproof`**. Emphasizes counterexamples. Risk: "proof" overclaims, since we test and do not
   prove, and Hacker News will point that out.

→ Decision needed from you.

---

## 2. Prior art and positioning

| Project                                                                                | What it does                                                                                                                                                                                                    | Gap that we fill                                                                                                                                                                                                                                                                   |
| -------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **fast-check** (JS)                                                                    | Property-based testing library with excellent arbitraries and shrinking.                                                                                                                                        | A library, not a tool. You must write the properties, load both versions yourself, and handle isolation. **We build on it** (generation and shrinking) and add everything around it.                                                                                               |
| **RealDiff** (formerly _BehaviorDiff_, issacnitin, MIT; .NET/Java/Node/Go/Rust/Python) | Instruments both sides of a PR, runs the **existing test suite**, and diffs recorded arguments and return values. Comments on PRs.                                                                              | Only observes inputs that the existing tests already exercise. It cannot find a difference on an input nobody wrote a test for, which is exactly the AI-PR failure mode. We **generate** inputs (types + mined literals + shrinking) and use existing tests only as a seed source. |
| **Keploy**                                                                             | Record/replay of API traffic (eBPF) into integration tests with mocks. A separate LLM unit-test generator (Go-first).                                                                                           | HTTP/API level, needs a running app and recorded traffic. No function-level old/new diff on generated inputs. Complementary ("HTTP-level diffs" is on our roadmap).                                                                                                                |
| **Testora** (Pradel, ICSE 2026; Python)                                                | An LLM writes tests for the PR, runs them on old and new code, and classifies differences as intended or unintended using the PR text. Found 19 regressions in popular Python projects, at about $0.003 per PR. | Closest academic prior art for **claim matching**, and it validates our framing. Research prototype, Python, LLM-_required_ for input generation. We are deterministic-first (no key needed), TypeScript, with a shipped CLI, Action and MCP server.                               |
| **DiffTestGen** (Hu, Cadar, Pradel, 2026; Python)                                      | Change-directed LLM test generation using call graphs and union-coverage feedback. Exposes differences in 78% of PRs.                                                                                           | Research. LLM-driven. Its **coverage-feedback idea** is a strong v2 direction for us (see roadmap).                                                                                                                                                                                |
| **Mokav**, **Differential Prompting** (Python)                                         | LLM-generated difference-exposing tests.                                                                                                                                                                        | Research, LLM-only, Python.                                                                                                                                                                                                                                                        |
| **CrossHair `diffbehavior`** (Python)                                                  | Symbolic execution finds inputs where two functions differ.                                                                                                                                                     | Python-only. Manual targeting ("one function at a time"). No git or PR integration.                                                                                                                                                                                                |
| **BERT** (Jin/Orso/Xie 2010; Java)                                                     | Original "behavioral regression testing". Generates tests for the changed code and diffs behavior.                                                                                                              | Academic, Java, unmaintained. It reported many differences that were not regressions, which is the noise problem we address with clustering and claim matching.                                                                                                                    |
| **AI review bots** (CodeRabbit, Copilot review, …)                                     | Read the diff and give opinions.                                                                                                                                                                                | No execution, no evidence.                                                                                                                                                                                                                                                         |

**One-line positioning for the README:** _"fast-check gives you the engine, RealDiff replays
the tests you already have, Testora showed the idea works in research. We are the zero-config tool that
generates the inputs your tests never tried, runs both versions, and hands you the counterexamples."_

---

## 3. Architecture

```
            ┌───────────── interfaces ─────────────┐
            │  CLI      GitHub Action     MCP      │
            └───────────────┬──────────────────────┘
                            │ RunOptions
┌───────────────────────────▼────────────────────────────────────────────────┐
│ core/orchestrator (main process; never executes code under test)          │
│                                                                            │
│  1 detect ─▶ 2 materialize ─▶ 3 analyze types ─▶ 4 explore ─▶ 5 shrink    │
│   git diff     worktrees +       ts-morph →          batched      per      │
│   + ts-morph   node_modules      ArbSpec IR          generate     cluster  │
│   → targets    + esbuild bundle  + mined values      + compare             │
│                                                         │                 │
│  6 cluster ─▶ 7 confirm (re-run, nondeterminism) ─▶ 8 claims (LLM, opt.)  │
│        ─▶ 9 Report model ─▶ terminal │ markdown │ json │ test-file         │
└──────────────────────┬──────────────────────────┬──────────────────────────┘
                       │ IPC batches (v8 serialize)│
            ┌──────────▼─────────┐      ┌──────────▼─────────┐
            │ runner pool: BASE  │      │ runner pool: HEAD  │   child processes
            │ node --permission  │      │ node --permission  │   memory-capped,
            │ frozen clock/rand  │      │ frozen clock/rand  │   killable,
            └────────────────────┘      └────────────────────┘   respawned
```

### 3.1 Change detection (`core/detect`)

- `git diff --no-renames -U0 base head`. The default `head` is the **working tree** (staged and unstaged),
  `base` is `HEAD`. The Action uses PR base and head SHAs (merge-base of base, so unrelated base
  commits do not appear as changes).
- Parse both versions of each changed `.ts/.tsx/.mts/.cts/.js/.mjs/.cjs` file with ts-morph (no type
  checking needed for this step). Map hunks to **declarations**: `function` exports,
  `export const f = (…) => …` / function expressions, `export default function`, `export { f as g }`
  and re-exports via `export … from` (resolved to the declaring module). Functions are matched across
  versions by **module path + export name**.
- **Formatting-only fast path:** if the printed AST of both versions is identical (comments and
  whitespace stripped), mark it "no behavior change (identical AST)" without executing anything.
- **Transitive impact:** build an intra-module reference graph (identifiers, not types). An unchanged
  exported function that reaches a changed non-exported function within depth N (default 3) becomes a
  target with `reason: "calls changed helper toCents()"`.
  _Refinement proposed:_ also follow **cross-module imports with depth 1** (exported `b()` in module B
  imports changed `a()` from module A). It is cheap with the same graph and catches the common
  "changed a util" case. Behind a flag if it turns out noisy.
- Added and removed exports are listed separately. Class methods, getters/setters, generators,
  overloaded signatures and functions with `this` are listed as **skipped (reason)**, never dropped
  silently.

> **Implementation note (Phase 2):** rather than mapping diff hunks to line ranges, detection compares each
> module-level binding (functions, variables, classes, imports, CommonJS `exports.x` / `module.exports`)
> by its _token stream_ (comments, JSDoc and whitespace dropped; string literals by value). Formatting-only
> edits therefore fall out naturally, and transitive impact follows any changed helper, constant or import
> binding (within a module up to depth 3, across modules one hop, including unchanged files and workspace
> packages). In monorepos, workspace packages are bundled from each version's own tree, so the base never
> silently uses the working copy's sibling package.

### 3.2 Loading two versions (`core/materialize`, `runner/`)

- **Base**: `git worktree add --detach <tmp>/base <sha>`. **Head**: the real checkout when comparing
  against the working tree, otherwise a second worktree. Worktrees are cached per SHA in the OS temp
  dir and cleaned up on exit (`--keep-worktrees` for debugging).
- **Dependencies:** hash the lockfile(s). If the hash is equal, symlink each `node_modules` that exists
  in the checkout into the worktree (junctions on Windows). If the hash differs, install in the worktree
  with the detected package manager (`npm ci` / `pnpm i --frozen-lockfile` / `yarn --immutable`) **with
  `--ignore-scripts` by default**. The install is cached under `~/.cache/<name>/deps/<lockhash>` and
  reused across runs.
- **Transpile by bundling:** for each target module and version, run **esbuild** with
  `bundle: true, packages: "external", platform: "node"`, using the project's tsconfig (esbuild resolves
  `paths` natively). The output goes into the version's own directory, so bare imports resolve against the
  right `node_modules`. This one step handles TS, JSX, ESM/CJS interop and path aliases, and takes
  milliseconds. It also lets us load modules that were never built. We considered tsx/loader hooks, but
  they add per-import overhead and have more edge cases with `paths`.
- **Runners:** `child_process.fork` with `serialization: "advanced"` (structured clone keeps `Date`,
  `Map`, `Set`, `BigInt`, `-0`, `NaN`, `undefined`, typed arrays and cycles). Each version gets a pool of
  `max(1, floor(cpus/2))` runners. Flags:
  `--permission --allow-fs-read=<worktree>,<node_modules realpaths>` (no fs-write, no child processes, no
  workers, no addons), `--max-old-space-size=<limit>`, `--stack-size` default.
- **Timeouts and crashes:** the orchestrator owns the clock. A call that does not answer within
  `--timeout` (default 1000 ms) gets its runner **killed and respawned**, which is the only way to stop a
  synchronous infinite loop. The outcome is recorded as `{kind: "timeout"}`. A runner exit or OOM becomes
  `{kind: "crash", signal}`. Both are first-class outcomes: "old: returns 3, new: timeout" is a finding.
- **Module load failure** (e.g. top-level side effects that the sandbox denies) → the whole function is
  **skipped (reason)**, together with the denied permission from `ERR_ACCESS_DENIED`.

### 3.3 Input generation (`core/arbitraries`)

Two layers, so that generation is unit-testable without fast-check:

1. **`ArbSpec` IR** (plain JSON, serializable, hashable) is derived from parameter types via the type checker:
   `number | integer-hint | bigint | string | boolean | literal | enum | union | array | tuple (+rest) |
object {required, optional, nullable} | record | Date | Map | Set | function(returns ArbSpec) |
branded(base) | recursive(ref, depth) | anything | unsupported(reason)`.
   - `any`/`unknown` → `anything` (a broad but serializable value space, with no functions or class instances).
   - Branded types (`number & {__brand}`) → base type.
   - Recursive types → `ref` with a depth limit of 3.
   - Generics → constraint or `unknown`.
   - Classes as parameters → `unsupported` for v1. The function is skipped unless the config supplies
     an arbitrary.
   - Function-typed parameters (callbacks) → deterministic stub functions that return generated values.
     These are materialized _inside_ the runner from a tagged descriptor, because functions cannot cross IPC.
2. **Compiler** ArbSpec → fast-check `Arbitrary`, mixed with **mined values**:
   - Numeric and string literals from both versions of the target function and of every helper it
     reaches. For numbers: `v`, `v±1`, `v±0.01`, plus the universal boundaries `0, -0, 1, -1, NaN, ±Infinity,
MAX_SAFE_INTEGER, MIN_VALUE`. For strings: `""`, the literal itself, the literal with surrounding
     whitespace, and case variants. For arrays: empty and single-element.
     Comparison operands (`price > 1000`) are the highest-value literals, so they get extra weight.
   - **Values from existing tests:** statically scan test files for calls `targetName(<literal args>)` and
     evaluate literal-only argument expressions. These run first as explicit examples.
   - Mined values are injected per _type-compatible position_ via weighted `fc.oneof` (default 30 % mined,
     70 % type-driven), so the type-driven search still explores.

- **Signature changes:** derive an ArbSpec for both versions. If they are equal, use it. If the base spec
  _subsumes_ the head spec (e.g. a parameter became optional, or a union widened), use the head spec.
  Otherwise mark the function **skipped: "signature changed incompatibly"** and show both signatures.
- **Reproducibility:** one root seed (`--seed`, printed on every run). Each function gets
  `hash(rootSeed, moduleId, exportName)`, so adding a function does not reshuffle the others.

### 3.4 Execution and comparison (`core/compare`, `runner/encode`)

- The runner **encodes** every outcome into a canonical `Observed` IR before sending it back:
  `returned(value) | threw(errorClass, message, ownProps) | resolved(value) | rejected(…) | timeout |
crash`, plus `argsAfter` (snapshots for mutation detection). Values are encoded structurally: class
  instances become `{$instance: ctorName, props}`, functions become `{$fn: name, length}`, symbols
  become their description, and cycles become back-refs. Comparison is a **pure function over two
  `Observed` trees**, which makes it trivially unit-testable.
- **Deep clone per call:** the orchestrator sends one serialized copy and each runner deserializes it
  separately, so the versions cannot share references. Within a runner, a fresh deserialization happens
  per call.
- Semantics (all configurable): `NaN ≡ NaN`; `0 ≢ -0`; Dates by time value (Invalid Date ≡ Invalid Date);
  Map/Set by contents (order-insensitive for Set, insertion order ignored for Map by default); class
  instances by constructor name + own enumerable props; `undefined` vs missing key **equal by default**
  (`strictUndefined: true` opt-in); errors by class + message (`ignoreErrorMessages`); optional numeric
  tolerance (`epsilon`, default exact).
- **Async:** each call is awaited with the timeout. Resolved vs rejected is a difference. Unhandled
  rejections and uncaught exceptions _during_ the call are attributed to that call.
- **Determinism environment (refinement):** the spec says "run twice, then freeze time if it disagrees".
  I propose freezing **by default**, because it is cheaper and catches more. Before every call the
  runner pins `Date.now()`/`new Date()` to a fixed instant (configurable), resets a seeded
  `Math.random`, and seeds `crypto.randomUUID/getRandomValues`. Real timers keep working, so async code
  doesn't hang. Then a **self-consistency check** runs the first 50 inputs twice per version. If a version
  still disagrees with itself, the function is marked **nondeterministic (skipped)** with the
  offending input. Every reported counterexample is also **re-confirmed** (both versions re-run twice)
  before it is reported. This gives the same guarantee as the spec with less work.

### 3.5 Exploration, shrinking, clustering (`core/explore`)

I validated this design with a spike against fast-check 4.10's public `Arbitrary.generate/shrink`
API. It found a `0` vs `-0` difference and shrank it to `[-0, 0]` in 66 evaluations.

- **Why not `fc.assert`:** it stops at the first failure and evaluates inputs one at a time. We need
  _all distinct_ differences and high throughput across process boundaries.
- **Exploration:** generate inputs in batches of 256 with the seeded `fc.Random`. Each batch goes to
  both pools in parallel, and outcomes are compared. Each difference gets a **cluster key**:
  `(outcome transition, input feature vector)`.
  - Outcome transition examples: `returned:number → returned:NaN`, `threw:RangeError → returned:number`,
    `returned:value-changed(number)`, `mutation(arg0)`, `returned → timeout`.
  - The feature vector holds coarse per-argument buckets: number sign/zero/non-finite/magnitude band
    around mined thresholds; string empty/non-empty; array empty/non-empty; `undefined`/`null`.
  - Example: "value changed for prices > 1000" and "value changed for prices < 0" become separate
    clusters, which matters for claim matching.
- **Shrinking:** shrink one witness per cluster with `arb.shrink(value, context)`. A shrink candidate is
  accepted **only if it stays in the same cluster**. Without that constraint, every cluster collapses to
  the same trivial input, which is the classic multi-bug shrinking problem. Cap: 500 evaluations per
  cluster. Keep the 1–3 smallest distinct witnesses, using serialized size as the ordering.
- **Budget:** `--runs` (default 1000 per function; the report says the exact count), early exit is not
  used (we want all clusters), and at most 10 clusters per function.

### 3.6 Claim matching (`core/claims`, optional)

- Inputs: PR title and body (or `--claim`), a trimmed diff, and clusters with **IDs** and their witnesses.
- Providers: Anthropic and OpenAI via env keys (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`), temperature 0,
  JSON-schema-constrained output, response cached by content hash.
- Output per cluster: `claimed | unclaimed | suspicious` plus a one-sentence explanation and
  `evidence: [witnessId…]`.
- **Validation against the evidence:**
  - unknown or missing cluster IDs → rejected;
  - every cluster must be labeled exactly once;
  - explanations may only quote numbers or strings that appear in that cluster's witnesses, the claim or
    the diff;
  - the LLM cannot add findings, because the schema doesn't allow it.
  - On validation failure: one retry, then fall back to neutral.
- **Deterministic claim modes (no LLM):**
  - `verify_refactor` / `--claim "no behavior change"` (exact keyword) → every cluster is _unclaimed_;
  - otherwise clusters are reported neutrally as "behavior change".
- Prompt-injection posture: PR text is untrusted. It can only influence _labels and wording_ of
  findings that the deterministic engine already produced, never their existence. The report states
  which labels come from an LLM.

> **Implementation note (Phase 4):** Anthropic calls use `claude-opus-5-5` by default with
> `output_config.format` (JSON schema), `effort: "low"` (a small classification task; thinking stays
> adaptive), no sampling parameters, and server-side `fallbacks: "default"` so a safety-classifier decline is
> retried on Anthropic's recommended model (disable with `DOPPELDIFF_LLM_FALLBACKS=0`). OpenAI calls use the
> Responses API with a strict JSON schema (`gpt-5.5` by default). `--llm-model` overrides either. Validated
> responses are cached by content hash so re-runs on the same PR are stable. Input suggestions are parsed
> with a literal-only parser (never `eval`) and must conform to the parameter types. In the fork-safe Action,
> the untrusted job has no key, so suggestions only run in same-repo mode; claim matching runs in the trusted job.

### 3.7 Outputs (`report/`)

- **`Report` model** (zod schema, versioned `schemaVersion: 1`, JSON Schema exported into `schema/`).
  Every renderer consumes only this model, and snapshot tests pin it.
- **Terminal:** per-function progress lines, then grouped results. Uses picocolors with no heavy TUI
  dependency, and honors `NO_COLOR`/non-TTY.
- **Markdown:** the PR comment exactly as in the brief, with collapsible `<details>` for long clusters,
  values escaped, and output bounded below GitHub's 65 k comment limit.
- **Regression tests:** Vitest or Jest is auto-detected from devDependencies or config files. The file
  imports the function from the real source path and asserts **new** behavior for every example.
  Unclaimed changes are emitted with a `// ⚠️ unclaimed: old behavior was …` comment so the human
  decides. Values are code-generated from the `Observed` IR (`NaN`, `-0`, `new Date(…)`, `new Map(…)`).
  Cases that cannot be expressed in code (class instances, functions) are skipped with a comment.
- **Exit codes:** `0` OK, `1` findings matching `--fail-on` (`unclaimed` default in CI, `any`,
  `never`), `2` tool error.

### 3.8 Interfaces

- **CLI** (`cac`): flags as specified, plus `--json <file|->`, `--markdown <file>`, `--only <fn>`,
  `--keep-worktrees`, `--verbose`.
- **GitHub Action**: a JS action that bundles the core (`action/dist`, committed).
  **Fork safety design (refinement):** split into two jobs:
  1. `pull_request` job (untrusted code, **no secrets**, read-only token): runs the deterministic engine
     and uploads `report.json` as an artifact.
  2. `workflow_run` job (trusted, has a write token and an optional LLM key, **never checks out or executes
     PR code**): downloads the artifact, validates it against the schema (treated as untrusted data), runs
     claim matching, and posts or updates **one sticky comment** (hidden marker `<!-- doppeldiff:sticky -->`).

  This keeps secrets out of reach of untrusted code _and_ lets fork PRs get comments and LLM labels.
  For same-repo-only setups, a simpler single-job mode is documented. `pull_request_target` with a
  checkout of the head is documented as **unsafe, don't**.

- **MCP server** (`<name> mcp`, stdio, `@modelcontextprotocol/sdk`). Tools:
  - `verify_change({cwd, base?, claim?, functions?, runs?})` → summary text + JSON report;
  - `verify_refactor(...)` → same, but asserts no behavior change and returns a crisp pass/fail with
    counterexamples.

  Tool descriptions coach agents to call it before claiming they are done.

- **Config** `doppeldiff.config.ts` (loaded via esbuild):
  ```ts
  export default defineConfig({
    functions: {
      'src/pricing.ts#applyDiscount': {
        args: (fc) => [fc.double({ min: 0, max: 1e6 }), fc.double({ min: 0, max: 1 })],
      },
    },
    ignore: ['src/legacy/**'],
    compare: { epsilon: 1e-9, ignoreErrorMessages: false },
  });
  ```

### 3.9 Security model (to be documented in `SECURITY.md`)

- The tool **executes the code under review**. This is the same trust level as running the PR's test
  suite, and the docs say so plainly.
- Defense in depth, not a security boundary:
  - Node permission model: no fs writes, child processes, workers or addons; fs reads limited to the
    worktree and `node_modules`.
  - Network: `--allow-net`-style restriction exists only in newer Node lines (verified: on Node 22,
    `--permission` blocks child_process and fs writes but **not network**). On those lines, a preload
    guard stubs `net`, `tls`, `dns`, `http(s)`, `fetch` and `WebSocket` to throw. The guard catches
    accidents, not adversaries.
  - Memory caps and kill-on-timeout.
  - `--ignore-scripts` for installs.
  - No secrets in the engine's environment: the runner gets a scrubbed `env`.
- The Node docs say explicitly that the permission model does not protect against malicious code. We
  repeat that.

---

## 4. Module layout

**Recommendation: one npm package, one repo, no pnpm monorepo (yet).**
All three interfaces share one core, and users install one thing (`npx <name>`, `<name> mcp`). A
monorepo adds release tooling and cross-package versioning for no user benefit in v1. If Python support
lands, the split is natural (`@name/core`, `@name/python`).

```
src/
  core/
    detect/        git diff → hunks → targets (ts-morph); call graph; skipped reasons
    materialize/   worktrees, dependency reuse/install cache, esbuild bundling
    types/         TS type → ArbSpec IR
    arbitraries/   ArbSpec → fast-check; value mining (code + tests)
    runner/        pool, IPC protocol, child entry (sandbox, determinism env, encode)
    compare/       Observed IR + structural equality
    explore/       batched exploration, cluster keys, constrained shrinking, confirmation
    claims/        LLM providers, prompt, output validation
    report/        Report model (zod) + terminal / markdown / json / testgen renderers
    run.ts         public `verify(options): Promise<Report>`
  cli/             cac entry
  mcp/             MCP server
action/            action.yml + bundled dist (built from src)
schema/            report.schema.json (generated)
examples/demo-shop/          standalone TS library + scenarios/*.patch + run-scenario script
test/              unit (per module) + e2e (scenarios, snapshot reports) + fixtures/
docs/              DESIGN.md, EVALUATION.md, SECURITY.md, ACTION.md, MCP.md
```

Stack: TypeScript strict, Node (see open question), ESM output via tsup/esbuild, Vitest, ESLint (flat
config) + Prettier, fast-check 4, ts-morph 28 (**it bundles a TS 6.0 JS compiler API**, which insulates
us from TypeScript 7's Go port, whose JS API is still `unstable/*`), esbuild, zod, cac, picocolors,
`@modelcontextprotocol/sdk`, `@anthropic-ai/sdk`, `openai` (the last two as optional peer dependencies,
loaded lazily).

**Demo scenarios as patches:** a nested git repo cannot be committed, so `examples/demo-shop` holds the
base source plus `scenarios/{1-honest-fix,2-ai-refactor,3-pure-refactor}.patch`. A script creates a temp
git repo, commits the base, applies a patch, and runs the tool. E2E tests and the VHS tape use the same
script.

---

## 5. Key risks and mitigations

| #   | Risk                                                                                                            | Mitigation                                                                                                                                                                                                                                                                                                                      |
| --- | --------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | **Input generation misses the interesting region** (e.g. a bug only at `price > 1000`). This is the core value. | Literal mining with comparison operands weighted highest; existing-test seeds; boundary sets; optional LLM edge cases; report _coverage honesty_ ("10,000 inputs" never means "proved"). Measured in EVALUATION.md, including misses. v2: branch-coverage-guided generation (DiffTestGen-style union coverage via V8 coverage). |
| 2   | **Real-world functions aren't pure / don't load** (top-level side effects, env, DB clients).                    | Clear "skipped (reason)" categories with counts in the report; module-load failures carry the denied permission; config hooks. The evaluation reports the skip rate honestly.                                                                                                                                                   |
| 3   | **Noise:** too many differences on intended changes → people ignore the tool.                                   | Clustering by transition + input features; 1–3 examples per cluster; claim matching; `verify_refactor` mode where every difference matters.                                                                                                                                                                                     |
| 4   | **Nondeterminism** → false positives.                                                                           | Frozen clock/random/UUID by default, self-consistency sample, re-confirmation of every reported counterexample.                                                                                                                                                                                                                 |
| 5   | **Complex types** (generics, conditional/mapped types, classes, huge unions) produce nothing useful.            | ArbSpec `unsupported(reason)` surfaces it. Fallback to `anything` only for `any`/`unknown`. Per-function config arbitraries. Track an "unsupported types" metric in the evaluation.                                                                                                                                             |
| 6   | **Dependency install is slow** when the lockfile changed.                                                       | Symlink when the hash is unchanged (the common case); content-addressed install cache; `--ignore-scripts`; report install time separately.                                                                                                                                                                                      |
| 7   | **Sandbox overpromises.**                                                                                       | Wording: "guardrail, not a security boundary". Fork-safe Action design keeps secrets away from untrusted code regardless.                                                                                                                                                                                                       |
| 8   | **IPC throughput** for 10 k inputs × 2 versions.                                                                | Batches of 256, a parallel pool per version, structured-clone serialization. Target ≥ 20 k calls/s for trivial pure functions; measured in Phase 1.                                                                                                                                                                             |
| 9   | **Windows** (symlinks, paths in permission flags, process kill semantics).                                      | Junctions, `path.win32` handling in flags, `taskkill`-free kill via `child.kill()`; CI matrix from Phase 1.                                                                                                                                                                                                                     |
| 10  | **LLM hallucination** in claim matching.                                                                        | Schema-constrained output, ID validation, quoting rule, fallback to neutral; LLM labels visibly marked.                                                                                                                                                                                                                         |
| 11  | **TypeScript 7 transition** (user code written for TS 7, our parser is TS 6.0).                                 | The syntax is identical in 7.0; we parse/type-check with our bundled compiler, independent of the user's version. Track TS 7's stable API for a later migration.                                                                                                                                                                |

---

## 6. Phase plan and estimates

Estimates are focused agent-work sessions. Each phase ends with lint + typecheck + tests green, a commit,
and a status report to you.

| Phase                      | Deliverable                                                                                                                                                                                                                                                                                                                                                                      | Est.       |
| -------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------- |
| **1. Core engine**         | ArbSpec from types (fixture-driven), compiler + mining, runner pool with sandbox/timeouts/crash isolation, Observed encoding + comparison, batched exploration + constrained shrinking, determinism env. Driver that takes two hardcoded file versions. Demo-shop library + 3 scenario patches; prove findings on them. Throughput benchmark. CI skeleton (Linux/macOS/Windows). | 1.5–2 days |
| **2. Git integration**     | Diff → targets (all export forms, re-exports), formatting-only fast path, transitive impact, added/removed/skipped, worktrees, dependency reuse/install cache, esbuild bundling with tsconfig paths.                                                                                                                                                                             | 1–1.5 days |
| **3. Reports**             | Report zod model + JSON Schema, clustering polish, terminal/markdown/json renderers, Vitest/Jest test generation, exit codes, CLI flags complete, e2e snapshot tests on scenarios.                                                                                                                                                                                               | 1 day      |
| **4. LLM layer**           | Anthropic/OpenAI providers, claim prompt, validation, edge-case suggestions validated against ArbSpec, response cache, tests with recorded fixtures (no network in CI).                                                                                                                                                                                                          | 0.5–1 day  |
| **5. Action + MCP**        | Two-job fork-safe Action, sticky comment, MCP server with verify_change/verify_refactor, docs for both.                                                                                                                                                                                                                                                                          | 1 day      |
| **6. Evaluation + polish** | 5–10 real commits (candidates: `date-fns`, `semver`, `validator.js`, `change-case`, `ufo`, `defu`, `ms`, `dayjs`, `slugify`) run and recorded honestly in EVALUATION.md, performance numbers, VHS tape, README, SECURITY.md, CONTRIBUTING, LICENSE.                                                                                                                              | 1–1.5 days |

Performance budget check (Phase 3 onward, in CI): ≤ 10 changed functions in < 60 s on a GitHub-hosted
runner, broken down by phase (worktree, deps, bundle, explore, shrink).

---

## 7. Decisions (approved 2026-11-01)

1. **Name:** `doppeldiff`. Tagline: "See what your PR actually changed." No "receipts" wording anywhere
   (an npm package of that name has a similar description). PR comment header: 🔬 doppeldiff.
2. **Node:** `engines: >=22.13`, CI matrix Node 22/24/26 on Linux, macOS and Windows. The sandbox is
   documented as a guardrail, not a security boundary.
3. **Budgets:** 1,000 inputs per function locally. The Action runs up to 10,000 per function, bounded by a
   total time budget (default 60 s), split across functions. The report always states the number of
   inputs actually run per function.
4. **Determinism:** clock frozen and randomness seeded by default; `--no-freeze` disables it.
5. **Action:** two-job fork-safe design, installable from one copy-paste workflow file in the README.
   Same-repo PRs work with minimal configuration.
6. Before writing the README comparison, study the `receipts` and `receipts-cli` npm packages so our
   positioning against them is accurate and fair.
