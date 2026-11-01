# Claim matching

doppeldiff compares every behavior change it observes with what the pull request says it does. By default it does
this with **deterministic rules: no LLM, no API key, no network.** The rules only _label_ changes that the engine
actually observed by running the code. They never add or hide one.

## The rules

The claim is the PR title and description (CLI: `--claim` / `--claim-file`).

**1. Intent.** The first matching item decides:

| Signal                                                                                                                                     | Intent    |
| ------------------------------------------------------------------------------------------------------------------------------------------ | --------- |
| An explicit phrase: "no behavior change", "no functional change", "pure refactor", "behavior-preserving", "without changing behavior", …   | no change |
| Conventional-commit type `refactor`, `perf`, `chore`, `style`, `build`, `ci`, `test`, `docs`                                               | no change |
| Conventional-commit type `fix`, `feat`, `revert`, `security` whose title is _only_ about performance ("fix: faster paths for compare")     | no change |
| Conventional-commit type `fix`, `feat`, `revert`, `security`                                                                               | change    |
| Change words: fix, bug, crash, error, wrong, regression, add, support, handle, allow, reject, correct, prevent, "now returns", breaking, … | change    |
| Refactor words without change words: refactor, cleanup, rename, simplify, modernize, extract, optimize, faster, lint, formatting, …        | no change |
| Nothing of the above                                                                                                                       | unknown   |

**2. Labels.** For each changed function:

| Situation                                                                                                                                                                                            | Label                                               |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------- |
| Intent is _no change_ (or `--refactor`, or the MCP tool `verify_refactor`)                                                                                                                           | ⚠️ **unclaimed**: the PR says nothing should change |
| The claim names the function: its export name (`withBase`), a distinctive word of a camelCase name ("discount" for `applyDiscount`), the file name for default exports, or a changed helper it calls | ✅ **claimed**, with the matched word quoted        |
| The claim names other changed functions, but not this one                                                                                                                                            | ⚠️ **unclaimed**                                    |
| Otherwise                                                                                                                                                                                            | 🔍 neutral **behavior change**                      |

Generic name words (`get`, `parse`, `format`, `value`, `apply`, …) and words shorter than 5 letters do not count
as a mention.

The rules are in [`src/core/claims/rules.ts`](../src/core/claims/rules.ts) and tested in
[`test/unit/rules.test.ts`](../test/unit/rules.test.ts).

### How they do on real data

| Case                                                                                            | Intent                       | Labels                                                                             |
| ----------------------------------------------------------------------------------------------- | ---------------------------- | ---------------------------------------------------------------------------------- |
| PR #1 "Refactor cart and slug utilities … Pure refactor, no behavior change."                   | no change                    | all 4 changes **unclaimed** ✅                                                     |
| `fix(withBase, withoutBase): prevent false prefix matches` (ufo)                                | change                       | both **claimed** ✅                                                                |
| `fix(isByteLength): handle unpaired UTF-16 surrogates` (validator.js)                           | change                       | `isByteLength` **claimed**, `isEmail` **claimed** via its helper `isByteLength` ✅ |
| `Fix discount rounding for prices over $1000` (demo)                                            | change                       | `applyDiscount` **claimed** ("discount") ✅                                        |
| `fix: faster paths for compare` (semver)                                                        | no change (performance only) | both **unclaimed** ✅ (this rule was added after seeing this commit)               |
| `Fix capitalizing words that start with numbers` (change-case), `Fixed negative decimals…` (ms) | change                       | neutral: the title does not name the function ➖                                   |

Across the 21 evaluation commits, every label that the rules assign is correct by our reading. When the PR text does
not name the function, the rules stay neutral instead of guessing. They also cannot notice that a fix changes _more_
than its title says (validator's `isSlug` now also accepts 1–2 character slugs; that change is labeled claimed
together with the rest of `isSlug`).

## Optional: an LLM (free with a local model)

An LLM can label changes from the _meaning_ of the description, and suggest targeted edge-case inputs. It is
**never used unless you turn it on**, and having an API key in your environment does not turn it on.

| Option                                                               | Cost                | How                                                                                                                           |
| -------------------------------------------------------------------- | ------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| **Ollama** (local)                                                   | free                | `ollama pull qwen2.5:7b`, then `doppeldiff --llm ollama --llm-model qwen2.5:7b`                                               |
| Any OpenAI-compatible server (llama.cpp, LM Studio, vLLM, a gateway) | free if self-hosted | `--llm openai-compatible --llm-base-url http://host:port/v1 --llm-model <model>` (`DOPPELDIFF_LLM_API_KEY` if it needs a key) |
| Anthropic / OpenAI                                                   | paid, your key      | `--llm anthropic` / `--llm openai` with `ANTHROPIC_API_KEY` / `OPENAI_API_KEY`                                                |

LLM labels go through the same validation: unknown IDs, missing labels and explanations that quote values not in the
evidence are rejected, and rejected behaviors keep their rule-based label.

**GitHub Models** used to offer free inference with the built-in `GITHUB_TOKEN`, but GitHub
[retired it on July 30, 2026](https://github.blog/changelog/2026-07-30-github-models-is-now-retired/). There is
currently no free hosted LLM available to GitHub Actions through `GITHUB_TOKEN`, so the Action uses the
rule-based matcher. You can still point the Action's `llm: openai-compatible` and `llm-base-url` inputs at a server
you run.
