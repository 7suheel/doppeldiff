/**
 * doppeldiff: see what your PR actually changed.
 *
 * Public programmatic API. The CLI, GitHub Action and MCP server are built on top of it.
 */
export { VerifySession, DEFAULT_NOW, type SessionOptions, type Side } from './core/verify/session.js';
export {
  verifyFunction,
  printSignature,
  functionSeed,
  type FunctionTarget,
  type FunctionResult,
  type FunctionStatus,
  type VerifyFunctionOptions,
} from './core/verify/verifyFunction.js';
export type { Cluster, Witness, ExploreResult, NondeterminismReport } from './core/explore/explore.js';
export type { Enc, Outcome } from './core/compare/observed.js';
export type { CompareOptions } from './core/compare/compare.js';
export type { ArbSpec, SignatureSpec, ParamSpec } from './core/types/spec.js';
export { formatArgs, formatOutcome, formatValue, formatEnc } from './core/format/format.js';
export { run, type RunOptions, type RunResult, type RunEvent } from './core/run.js';
export { buildReport, isRefactorClaim, type ClaimInput } from './core/report/build.js';
export { renderMarkdown, STICKY_MARKER } from './core/report/markdown.js';
export { renderTerminal } from './core/report/terminal.js';
export { generateTests } from './core/report/testgen.js';
export { Report as ReportSchema, reportJsonSchema, type Report } from './core/report/model.js';
export { defineConfig, type DoppeldiffConfig, type FunctionConfig } from './config.js';
