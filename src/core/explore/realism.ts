import { isFnDescriptor, isProtoDescriptor, PROTO_TAG } from '../runner/tags.js';

/**
 * How realistic is an input? Findings on inputs that real callers pass matter more than findings on NaN, -0 or
 * lone surrogates. Tiers (higher is more realistic):
 *   3 seen      every number/string in the input appears in the project's tests or call sites
 *   2 ordinary  no exotic values, and within the domain observed in tests/call sites
 *   1 unusual   outside the observed domain (e.g. negative while every observed number is >= 0), or objects with
 *               inherited enumerable properties
 *   0 edge      exotic values: NaN, ±Infinity, -0, huge/tiny magnitudes, lone surrogates, control or zero-width
 *               characters, invalid dates
 */
export type RealismTier = 0 | 1 | 2 | 3;
export const REALISM_NAMES = ['edge', 'unusual', 'ordinary', 'seen'] as const;
export type RealismName = (typeof REALISM_NAMES)[number];

export interface RealismContext {
  numbers: ReadonlySet<number>;
  strings: ReadonlySet<string>;
  /** Every observed number is >= 0 (with enough observations). */
  nonNegative: boolean;
  /** Every observed number is an integer (with enough observations). */
  integerOnly: boolean;
}

export interface Realism {
  tier: RealismTier;
  /** Why the input is not more realistic, e.g. "NaN", "negative number (tests only use >= 0)". */
  reason?: string;
}

const MIN_OBSERVATIONS = 3;

export function realismContext(
  usage: { numbers: number[]; strings: string[]; numberObservations?: number } | undefined,
): RealismContext {
  const numbers = usage?.numbers ?? [];
  const enough = (usage?.numberObservations ?? numbers.length) >= MIN_OBSERVATIONS && numbers.length > 0;
  return {
    numbers: new Set(numbers),
    strings: new Set(usage?.strings ?? []),
    nonNegative: enough && numbers.every((n) => n >= 0),
    integerOnly: enough && numbers.every((n) => Number.isInteger(n)),
  };
}

// Lone surrogates, C0/C1 control characters (except tab/newline/CR), zero-width characters and BOM.
const EXOTIC_CHARS = new RegExp(
  '[\\uD800-\\uDBFF](?![\\uDC00-\\uDFFF])|(?<![\\uD800-\\uDBFF])[\\uDC00-\\uDFFF]|' +
    '[\\u0000-\\u0008\\u000B\\u000C\\u000E-\\u001F\\u007F-\\u009F\\u200B-\\u200F\\u2028\\u2029\\uFEFF]',
);
// A string that starts with a combining mark has nothing to combine with.
const LEADING_COMBINING = /^\p{M}/u;

function numberRealism(n: number, ctx: RealismContext): Realism {
  if (Number.isNaN(n)) return { tier: 0, reason: 'NaN' };
  if (!Number.isFinite(n)) return { tier: 0, reason: n > 0 ? 'Infinity' : '-Infinity' };
  if (Object.is(n, -0)) return { tier: 0, reason: '-0' };
  if (Math.abs(n) >= 1e9) return { tier: 0, reason: 'huge number' };
  if (n !== 0 && Math.abs(n) < 1e-6) return { tier: 0, reason: 'tiny number' };
  if (ctx.numbers.has(n)) return { tier: 3 };
  if (ctx.nonNegative && n < 0)
    return { tier: 1, reason: 'negative number (tests and call sites only use values >= 0)' };
  if (ctx.integerOnly && !Number.isInteger(n))
    return { tier: 1, reason: 'non-integer (tests and call sites only use integers)' };
  return { tier: 2 };
}

function stringRealism(s: string, ctx: RealismContext): Realism {
  if (EXOTIC_CHARS.test(s))
    return { tier: 0, reason: 'control, zero-width or unpaired surrogate characters' };
  if (LEADING_COMBINING.test(s)) return { tier: 0, reason: 'leading combining mark' };
  if (ctx.strings.has(s)) return { tier: 3 };
  return { tier: 2 };
}

/** Realism of one input: its least realistic value decides. */
export function inputRealism(input: unknown[], ctx: RealismContext): Realism {
  let worst: Realism = { tier: 3 };
  let leaves = 0;
  const consider = (r: Realism) => {
    leaves++;
    if (r.tier < worst.tier) worst = r;
  };
  const seen = new Set<unknown>();
  const walk = (v: unknown, depth: number) => {
    if (depth > 8) return;
    if (typeof v === 'number') return consider(numberRealism(v, ctx));
    if (typeof v === 'string') return consider(stringRealism(v, ctx));
    if (typeof v !== 'object' || v === null || seen.has(v)) return;
    seen.add(v);
    if (isFnDescriptor(v)) return;
    if (isProtoDescriptor(v)) {
      consider({ tier: 1, reason: 'object with inherited enumerable properties' });
      walk(v[PROTO_TAG].proto, depth + 1);
      walk(v[PROTO_TAG].own, depth + 1);
      return;
    }
    if (v instanceof ArrayBuffer || ArrayBuffer.isView(v)) {
      consider({ tier: 2 });
      return;
    }
    if (v instanceof Date) {
      const t = v.getTime();
      if (Number.isNaN(t)) consider({ tier: 0, reason: 'Invalid Date' });
      else if (v.getUTCFullYear() < 1900 || v.getUTCFullYear() > 2200)
        consider({ tier: 0, reason: 'date far from the present' });
      else consider({ tier: 2 });
      return;
    }
    if (v instanceof Map) {
      for (const [k, x] of v) {
        walk(k, depth + 1);
        walk(x, depth + 1);
      }
      return;
    }
    if (v instanceof Set) {
      for (const x of v) walk(x, depth + 1);
      return;
    }
    for (const x of Object.values(v as Record<string, unknown>)) walk(x, depth + 1);
  };
  input.forEach((v) => walk(v, 0));
  // Inputs without any number or string (booleans, empty arrays, undefined) are ordinary, not "seen".
  if (leaves === 0) return { tier: 2 };
  return worst;
}
