# Security model

doppeldiff **runs the code it analyzes**: the old and the new version of every changed function. Treat it like
running that code's test suite: run it on code you would run tests for.

## What the sandbox does

Each version runs in separate child processes, never in the doppeldiff process itself, with:

- the **Node.js permission model** (`--permission`): no file writes, no child processes, no worker threads,
  no native addons; file reads limited to the checkout, its `node_modules` and doppeldiff's own files;
- **no network**: denied by the permission model on Node versions that support `--allow-net` (25+), and by an
  in-process guard that stubs `net`, `tls`, `dns`, `http(s)`, `http2`, `dgram`, `fetch` and `WebSocket` on
  Node 22/24;
- a **scrubbed environment** (no tokens or API keys from your shell or CI);
- a **memory limit**, per-call **timeouts**, and kill-and-respawn on hangs and crashes;
- dependency installs for the base version run with **lifecycle scripts disabled**.

## What it does not do

**The sandbox is a guardrail against accidents, not a security boundary.** It stops a function from
accidentally writing files, calling the network or spawning processes. It is not designed to contain code
written to escape it, and the Node.js documentation states the same about the permission model. Do not run
doppeldiff on code you would not run at all.

In GitHub Actions, the [two-job workflow](docs/ACTION.md) is what keeps untrusted pull requests away from
secrets: the job that runs PR code has no secrets and a read-only token, and the job that has a write token
never runs PR code.

## The optional LLM layer

API keys are read only from environment variables (or the Action's inputs), are never written to reports or
logs, and are not passed to the code under test. Pull request text is untrusted. It can influence only the
_labels and wording_ of behavior changes that the deterministic engine found, never which changes exist.
LLM output is validated against the evidence before use.

## Reporting a vulnerability

Please report vulnerabilities privately via GitHub security advisories on this repository rather than in a
public issue.
