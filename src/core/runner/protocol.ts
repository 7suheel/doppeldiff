import type { Outcome } from '../compare/observed.js';

export interface InitMessage {
  t: 'init';
  freeze: boolean;
  /** Frozen clock value (ms since epoch). */
  now: number;
  /** Seed for Math.random / crypto shims. */
  seed: number;
  /** Install the in-process network guard (Node lines without native --allow-net). */
  netGuard: boolean;
  /** Keep console output of code under test (default: silenced). */
  showConsole: boolean;
}

export interface LoadMessage {
  t: 'load';
  moduleId: string;
  path: string;
}

export interface RunMessage {
  t: 'run';
  reqId: number;
  moduleId: string;
  exportName: string;
  inputs: unknown[][];
  timeoutMs: number;
  /** Run synchronous calls inside a vm script with a timeout (slower, but no respawn on sync hangs). */
  guard: boolean;
}

export type ParentMessage = InitMessage | LoadMessage | RunMessage;

export interface LoadedMessage {
  t: 'loaded';
  moduleId: string;
  ok: boolean;
  error?: { name: string; message: string; code?: string };
  exports: string[];
}

export type ChildMessage =
  | { t: 'ready'; node: string }
  | LoadedMessage
  | { t: 'result'; reqId: number; index: number; outcome: Outcome }
  | { t: 'done'; reqId: number };
