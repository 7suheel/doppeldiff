# GitHub Action

doppeldiff posts **one sticky comment** per pull request and updates it on every push. Setup is two files: copy
[`examples/workflows/doppeldiff.yml`](../examples/workflows/doppeldiff.yml) and
[`examples/workflows/doppeldiff-comment.yml`](../examples/workflows/doppeldiff-comment.yml) to `.github/workflows/`
on your default branch. No secrets are required.

They have to be two files: the comment job is triggered by the completion of the analyze workflow
(`workflow_run`), and GitHub rejects a workflow file whose `workflow_run` trigger names the workflow itself. We
verified this on GitHub: such a file is treated as invalid and fails on every push.

## How it stays safe for pull requests from forks

doppeldiff **executes the code under review**. The workflow therefore has two jobs with different trust levels:

| Job                                  | Trigger                                    | Runs PR code?  | Secrets                                             | Token                  |
| ------------------------------------ | ------------------------------------------ | -------------- | --------------------------------------------------- | ---------------------- |
| `analyze`                            | `pull_request`                             | yes, sandboxed | none (GitHub never passes secrets to fork PRs here) | read-only              |
| `comment` (`doppeldiff-comment.yml`) | `workflow_run` (after `analyze` completes) | **never**      | optional LLM key                                    | `pull-requests: write` |

The `analyze` job uploads the JSON report as an artifact. The `comment` job treats that artifact as **untrusted
data**:

- it validates the report against the [JSON schema](../schema/report.schema.json) and size limits;
- it checks that the report belongs to the PR whose head commit triggered the run (PR number and head SHA,
  verified against the GitHub API) and that the PR is open;
- it **discards** any claim text and labels in the artifact, re-reads the PR title and description from the
  API, and re-derives labels (deterministically, or with the optional LLM step);
- every string from the report is escaped when rendered (no HTML, no `@mentions`);
- it only edits a comment authored by `github-actions[bot]` that carries the doppeldiff marker.

**Do not use `pull_request_target`** to run doppeldiff: that event has secrets and a write token, and checking out
and running the PR head there is the classic way repositories get compromised. The action refuses to analyze
under `pull_request_target`.

## Same-repository pull requests

Nothing extra is needed: the same files work. Claimed/unclaimed labels come from the PR title and description
via [deterministic rules](CLAIMS.md), with no API key and no cost.

An LLM is optional and off by default. GitHub's free hosted models were
[retired in July 2026](https://github.blog/changelog/2026-07-30-github-models-is-now-retired/), so in Actions
an LLM means either a server you host (`llm: openai-compatible`, `llm-base-url`, `llm-model`, optional
`llm-api-key`) or a paid key (`anthropic-api-key` / `openai-api-key`). If you pass one to the `analyze` step
(input suggestions), only do that in repositories where PRs come from collaborators. Fork PRs never receive
secrets under `pull_request`, and the code under test runs with a scrubbed environment and no network.

## Notes and limitations

- `workflow_run` only fires for workflow files that exist on the **default branch**. The PR that adds the workflow
  gets no comment; the next ones do. The report is always in the `analyze` job's summary.
- If you rename the first workflow, update `workflows: [doppeldiff]` in the second one to match its `name:`.
- Comparison is between the PR's base commit and GitHub's merge commit for the PR, i.e. exactly what merging
  would change.
- Budget: up to 10,000 inputs per function, bounded by a 60 s total exploration budget (`time-budget`). The
  comment states how many inputs each function actually ran.

## Inputs

| Input                                        | Default | Description                                                                  |
| -------------------------------------------- | ------- | ---------------------------------------------------------------------------- |
| `mode`                                       | `auto`  | `analyze` on `pull_request`, `comment` on `workflow_run`                     |
| `runs`                                       | `10000` | Max inputs per function                                                      |
| `time-budget`                                | `60`    | Total exploration budget (seconds)                                           |
| `timeout`                                    | `250`   | Per-call timeout (ms)                                                        |
| `fail-on`                                    | `never` | Fail the analyze job on `unclaimed` or `any` behavior change                 |
| `include` / `exclude`                        |         | File globs                                                                   |
| `install`                                    | `true`  | Install dependencies (scripts disabled) if `node_modules` is missing         |
| `llm`                                        | `off`   | Optional LLM: `openai-compatible` (self-hosted, free), `anthropic`, `openai` |
| `llm-base-url` / `llm-api-key` / `llm-model` |         | OpenAI-compatible endpoint settings / model override                         |
| `anthropic-api-key` / `openai-api-key`       |         | Paid keys; passing one enables that provider                                 |

Outputs: `verdict` (`no-change` / `changes` / `unclaimed`), `behaviors`, `unclaimed`, `report-path`.
