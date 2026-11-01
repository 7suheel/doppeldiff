/**
 * Encoded values ("Enc"): a canonical, serializable description of a JavaScript value as observed
 * inside a runner. Comparison and rendering operate only on this representation.
 */
export type Enc =
  | { t: 'undefined' }
  | { t: 'null' }
  | { t: 'boolean'; v: boolean }
  | { t: 'number'; v: number }
  | { t: 'bigint'; v: string }
  | { t: 'string'; v: string }
  | { t: 'symbol'; d: string }
  | { t: 'array'; items: Enc[] }
  /** `ctor` is null for plain objects, "null-prototype" for Object.create(null), else the constructor name. */
  | { t: 'object'; ctor: string | null; entries: [string, Enc][] }
  | { t: 'date'; v: number }
  | { t: 'map'; entries: [Enc, Enc][] }
  | { t: 'set'; items: Enc[] }
  | { t: 'regexp'; source: string; flags: string }
  | { t: 'function'; name: string; length: number }
  | { t: 'error'; ctor: string; message: string; props: [string, Enc][] }
  | { t: 'typed'; ctor: string; items: number[] }
  | { t: 'promise' }
  /** Cycle: reference to the ancestor `up` levels above. */
  | { t: 'cycle'; up: number }
  | { t: 'truncated'; reason: string };

export type Outcome =
  | { kind: 'return'; value: Enc; async: boolean; args: Enc[] }
  | { kind: 'throw'; error: Enc; async: boolean; args: Enc[]; uncaught?: boolean }
  | { kind: 'timeout'; ms: number }
  | { kind: 'crash'; reason: string };
