import fc, { type Arbitrary } from 'fast-check';
import type { ArbSpec, BinaryCtor, SignatureSpec } from '../types/spec.js';
import { FN_TAG, PROTO_TAG, type FnDescriptor, type ProtoDescriptor } from '../runner/tags.js';
import { emptyMined, type MinedValues } from './mine.js';
import { regexArbitraries } from './regex.js';

export interface CompileOptions {
  mined?: MinedValues;
  /** Max nesting of recursive types (default 3). */
  maxRecursionDepth?: number;
  /** Max array / collection length (default 8). */
  maxLength?: number;
  /** Relative weight of mined values vs type-driven values, 0..1 (default 0.3). */
  minedWeight?: number;
}

interface Ctx {
  mined: MinedValues;
  defs: Map<string, ArbSpec>;
  depth: Map<string, number>;
  maxDepth: number;
  maxLength: number;
  minedWeight: number;
  /** When true, references are not followed (used to build terminating base cases). */
  terminal: boolean;
}

/** UTF-16 edge cases that random code points almost never hit. */
const UTF16_EDGES = [
  '\uD800',
  '\uDBFF',
  '\uDC00',
  '\uDFFF',
  '\uD83D\uDE00',
  '\u0301',
  '\u200B',
  '\uFEFF',
  'a',
  'é',
];

/** Structural fragments common in paths, URLs, queries and formats. */
const STRUCTURAL_FRAGMENTS = [
  '/',
  '//',
  '?',
  '#',
  '&',
  '=',
  ':',
  '.',
  '..',
  '-',
  '_',
  ' ',
  'a',
  'b',
  '1',
  '%20',
  '@',
  ',',
];

const INTERESTING_CHARS = [
  ' ',
  '-',
  '_',
  '.',
  '/',
  'a',
  'Z',
  '0',
  '9',
  'é',
  'ß',
  'İ',
  '😀',
  '\t',
  ' ',
  '&',
  "'",
];

const SPECIAL_DATES = [
  new Date(0),
  new Date('2024-02-29T00:00:00.000Z'),
  new Date('2024-12-31T23:59:59.999Z'),
  new Date('2025-03-30T01:30:00.000Z'),
  new Date('2025-10-26T00:59:59.000Z'),
  new Date('1999-12-31T23:59:59.000Z'),
  new Date(NaN),
];

function weighted(typeDriven: Arbitrary<unknown>, mined: readonly unknown[], ctx: Ctx): Arbitrary<unknown> {
  if (mined.length === 0 || ctx.minedWeight <= 0) return typeDriven;
  const w = Math.round(ctx.minedWeight * 100);
  return fc.oneof(
    { arbitrary: typeDriven, weight: 100 - w },
    { arbitrary: fc.constantFrom(...mined), weight: w },
  );
}

function numberArb(ctx: Ctx): Arbitrary<unknown> {
  // Mostly realistic magnitudes; the full double range (NaN, ±Infinity, 1e308, 5e-324) stays in the mix.
  const typeDriven = fc.oneof(
    { arbitrary: fc.integer({ min: -1000, max: 1000 }), weight: 4 },
    { arbitrary: fc.integer({ min: -100_000_000, max: 100_000_000 }).map((n) => n / 100), weight: 4 },
    { arbitrary: fc.double(), weight: 2 },
  );
  return weighted(typeDriven, ctx.mined.numbers, ctx);
}

const regexCache = new WeakMap<object, Arbitrary<string>[]>();

const sampleCache = new WeakMap<object, string[]>();

/** A few short strings per code regex, as fragments: composed strings then contain format-shaped words. */
function regexSamples(arbs: Arbitrary<string>[]): string[] {
  let out = sampleCache.get(arbs);
  if (!out) {
    out = [];
    arbs.forEach((arb, i) => {
      try {
        out!.push(
          ...fc
            .sample(arb, { numRuns: 6, seed: 7 + i })
            .filter((x) => x.length > 0 && x.length <= 12)
            .slice(0, 3),
        );
      } catch {
        /* skip */
      }
    });
    sampleCache.set(arbs, out);
  }
  return out;
}

function stringArb(ctx: Ctx): Arbitrary<unknown> {
  // Strings in the formats the code parses (its own regex literals), when there are any.
  let fromRegexes = regexCache.get(ctx.mined.regexes);
  if (!fromRegexes) {
    fromRegexes = regexArbitraries(ctx.mined.regexes);
    regexCache.set(ctx.mined.regexes, fromRegexes);
  }
  // Strings composed from a small shared pool of fragments (mined literals + structural characters): two
  // independently generated arguments then often share prefixes/suffixes, as paths and URLs do in real calls.
  const fragments = [
    ...new Set([...ctx.mined.fragments, ...STRUCTURAL_FRAGMENTS, ...regexSamples(fromRegexes)]),
  ];
  const composed = fc
    .array(fc.constantFrom(...fragments), { minLength: 1, maxLength: 5 })
    .map((xs) => xs.join(''));
  const typeDriven = fc.oneof(
    { arbitrary: fc.string({ maxLength: 16 }), weight: 3 },
    { arbitrary: fc.string({ unit: fc.constantFrom(...INTERESTING_CHARS), maxLength: 12 }), weight: 2 },
    { arbitrary: composed, weight: 3 },
    { arbitrary: fc.string({ unit: 'grapheme', maxLength: 8 }), weight: 1 },
    // UTF-16 edge cases: lone high/low surrogates, a valid pair, combining marks, zero-width and BOM.
    {
      arbitrary: fc.string({ unit: fc.constantFrom(...UTF16_EDGES), minLength: 1, maxLength: 6 }),
      weight: 1,
    },
    ...(fromRegexes.length > 0 ? [{ arbitrary: fc.oneof(...fromRegexes), weight: 3 }] : []),
    ...(ctx.mined.distinguishing?.length
      ? [{ arbitrary: fc.constantFrom(...ctx.mined.distinguishing), weight: 3 }]
      : []),
  );
  return weighted(typeDriven, ctx.mined.strings, ctx);
}

function dateArb(ctx: Ctx): Arbitrary<unknown> {
  const typeDriven = fc.date({
    min: new Date('1900-01-01T00:00:00.000Z'),
    max: new Date('2200-01-01T00:00:00.000Z'),
    noInvalidDate: true,
  });
  return weighted(typeDriven, SPECIAL_DATES, { ...ctx, minedWeight: 0.2 });
}

const TYPED_ARRAYS = {
  Uint8Array,
  Uint8ClampedArray,
  Int8Array,
  Uint16Array,
  Int16Array,
  Uint32Array,
  Int32Array,
  Float32Array,
  Float64Array,
  BigInt64Array,
  BigUint64Array,
} as const;

/**
 * Typed arrays, ArrayBuffers and DataViews. Views are often windows into a larger buffer (non-zero `byteOffset`,
 * shorter `byteLength`): code that copies `view.buffer` without the window is a classic bug.
 */
function binaryArb(ctor: BinaryCtor, ctx: Ctx): Arbitrary<unknown> {
  const max = Math.max(1, ctx.maxLength);
  const bytes = fc.uint8Array({ maxLength: max * 2 });
  if (ctor === 'ArrayBuffer')
    return bytes.map((b) => b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength));
  if (ctor === 'DataView') {
    return fc
      .tuple(fc.uint8Array({ minLength: 0, maxLength: max * 2 }), fc.noBias(fc.nat(4)), fc.noBias(fc.nat(4)))
      .map(([b, before, after]) => {
        const buf = new Uint8Array(before + b.length + after);
        buf.set(b, before);
        return new DataView(buf.buffer, before, b.length);
      });
  }
  const Ctor = TYPED_ARRAYS[ctor];
  const size = Ctor.BYTES_PER_ELEMENT;
  return fc
    .tuple(
      fc.nat(max),
      fc.noBias(fc.nat(2)),
      fc.noBias(fc.nat(2)),
      fc.uint8Array({ minLength: max * size, maxLength: max * size }),
    )
    .map(([len, before, after, raw]) => {
      // Elements from random bytes (covers NaN/negative values), viewed through a window of a larger buffer.
      const buf = new ArrayBuffer((before + len + after) * size);
      new Uint8Array(buf, before * size, len * size).set(raw.subarray(0, len * size));
      return new Ctor(buf, before * size, len);
    });
}

/**
 * Objects with enumerable properties on their prototype (`Object.create({ inherited: 1 })`): `for...in` sees them,
 * `Object.keys` does not. Sent to the runner as a descriptor (structured clone drops prototypes).
 */
function protoObjectArb(key: Arbitrary<string>, value: Arbitrary<unknown>): Arbitrary<unknown> {
  const dict = (min: number) =>
    fc.dictionary(key, value, { minKeys: min, maxKeys: 3, noNullPrototype: true });
  return fc.tuple(dict(1), dict(0)).map(([proto, own]): ProtoDescriptor => ({ [PROTO_TAG]: { proto, own } }));
}

/** Rarer object kinds that untyped code handles specially: binary data and objects with inherited properties. */
function zooArb(ctx: Ctx, key: Arbitrary<string>, value: Arbitrary<unknown>): Arbitrary<unknown> {
  return fc.oneof(
    binaryArb('Uint8Array', ctx),
    binaryArb('Float64Array', ctx),
    binaryArb('ArrayBuffer', ctx),
    binaryArb('DataView', ctx),
    protoObjectArb(key, value),
  );
}

function anythingArb(ctx: Ctx): Arbitrary<unknown> {
  // Untyped parameters (`any`, plain JS): objects use the property names the code reads as keys, and leaves
  // reuse the number/string generators (with mined values).
  const key =
    ctx.mined.keys.length > 0
      ? fc.oneof(fc.constantFrom(...ctx.mined.keys), fc.string({ maxLength: 6 }))
      : fc.string({ maxLength: 6 });
  const leaves = [numberArb(ctx), stringArb(ctx), fc.boolean(), fc.constant(undefined), fc.constant(null)];
  const shaped = fc.anything({
    maxDepth: 2,
    maxKeys: 4,
    key,
    values: leaves,
    withDate: true,
    withMap: false,
    withSet: false,
  });
  const anything = fc.anything({
    maxDepth: 2,
    maxKeys: 4,
    withBigInt: true,
    withDate: true,
    withMap: true,
    withSet: true,
    withTypedArray: false,
    withSparseArray: false,
    withNullPrototype: false,
    withBoxedValues: false,
    withObjectString: false,
  });
  const leaf = fc.oneof(numberArb(ctx), stringArb(ctx), fc.boolean());
  const mixed = fc.oneof(
    { arbitrary: anything, weight: 4 },
    { arbitrary: shaped, weight: 6 },
    { arbitrary: numberArb(ctx), weight: 4 },
    { arbitrary: stringArb(ctx), weight: 4 },
    { arbitrary: zooArb(ctx, key, leaf), weight: 2 },
  );
  return weighted(mixed, [...ctx.mined.numbers.slice(0, 20), ...ctx.mined.strings.slice(0, 20)], ctx);
}

function compile(spec: ArbSpec, ctx: Ctx): Arbitrary<unknown> | null {
  switch (spec.kind) {
    case 'number':
      return numberArb(ctx);
    case 'bigint':
      return fc.oneof(fc.bigInt({ min: -1000n, max: 1000n }), fc.bigInt());
    case 'string':
      return stringArb(ctx);
    case 'boolean':
      return fc.boolean();
    case 'undefined':
      return fc.constant(undefined);
    case 'null':
      return fc.constant(null);
    case 'literal':
      return fc.constant(spec.value);
    case 'bigintLiteral':
      return fc.constant(BigInt(spec.value));
    case 'union': {
      const options = spec.options
        .map((o) => compile(o, ctx))
        .filter((a): a is Arbitrary<unknown> => a !== null);
      if (options.length === 0) return null;
      return options.length === 1 ? options[0]! : fc.oneof(...options);
    }
    case 'array': {
      const items = compile(spec.items, ctx);
      if (!items) return fc.constant([]);
      return ctx.terminal ? fc.constant([]) : fc.array(items, { maxLength: ctx.maxLength });
    }
    case 'tuple': {
      const items = spec.items.map((i) => compile(i, ctx));
      if (items.some((i) => i === null)) return null;
      const fixed = fc.tuple(...(items as Arbitrary<unknown>[]));
      const restArb = spec.rest ? compile(spec.rest, ctx) : null;
      const withRest: Arbitrary<unknown[]> = restArb
        ? fc
            .tuple(fixed, fc.array(restArb, { maxLength: Math.min(4, ctx.maxLength) }))
            .map(([f, r]) => [...f, ...r])
        : fixed;
      if (spec.optionalFrom === undefined) return withRest;
      const min = spec.optionalFrom;
      return fc
        .tuple(withRest, fc.integer({ min, max: spec.items.length }))
        .map(([vals, len]) => (len < spec.items.length ? vals.slice(0, len) : vals));
    }
    case 'object': {
      const model: Record<string, Arbitrary<unknown>> = {};
      const required: string[] = [];
      for (const p of spec.props) {
        const a = compile(p.spec, ctx);
        if (!a) {
          if (p.optional) continue;
          return null;
        }
        model[p.name] = a;
        if (!p.optional) required.push(p.name);
      }
      return fc.record(model, { requiredKeys: required, noNullPrototype: true });
    }
    case 'record': {
      const values = compile(spec.values, ctx);
      if (!values || ctx.terminal) return fc.constant({});
      const key =
        spec.key === 'number'
          ? fc.integer({ min: 0, max: 99 }).map(String)
          : fc.string({ maxLength: 8 }).filter((k) => k !== '__proto__');
      return fc.dictionary(key, values, { maxKeys: Math.min(5, ctx.maxLength), noNullPrototype: true });
    }
    case 'date':
      return dateArb(ctx);
    case 'binary':
      return binaryArb(spec.ctor, ctx);
    case 'map': {
      const k = compile(spec.key, ctx);
      const v = compile(spec.value, ctx);
      if (!k || !v || ctx.terminal) return fc.constant(new Map());
      return fc.array(fc.tuple(k, v), { maxLength: Math.min(5, ctx.maxLength) }).map((es) => new Map(es));
    }
    case 'set': {
      const i = compile(spec.items, ctx);
      if (!i || ctx.terminal) return fc.constant(new Set());
      return fc.array(i, { maxLength: Math.min(5, ctx.maxLength) }).map((xs) => new Set(xs));
    }
    case 'function': {
      const ret = compile(spec.returns, ctx) ?? fc.constant(undefined);
      return ret.map((v): FnDescriptor => ({ [FN_TAG]: { returns: v, async: spec.async } }));
    }
    case 'recursive': {
      ctx.defs.set(spec.id, spec.spec);
      return compileRef(spec.id, ctx);
    }
    case 'ref':
      return compileRef(spec.id, ctx);
    case 'anything':
      return anythingArb(ctx);
    case 'unsupported':
      return null;
  }
}

function compileRef(id: string, ctx: Ctx): Arbitrary<unknown> | null {
  const def = ctx.defs.get(id);
  if (!def) return null;
  const d = ctx.depth.get(id) ?? 0;
  if (ctx.terminal) return null;
  if (d >= ctx.maxDepth) return compile(def, { ...ctx, terminal: true });
  ctx.depth.set(id, d + 1);
  try {
    return compile(def, ctx);
  } finally {
    ctx.depth.set(id, d);
  }
}

function makeCtx(options: CompileOptions): Ctx {
  return {
    mined: options.mined ?? emptyMined(),
    defs: new Map(),
    depth: new Map(),
    maxDepth: options.maxRecursionDepth ?? 3,
    maxLength: options.maxLength ?? 8,
    minedWeight: options.minedWeight ?? 0.3,
    terminal: false,
  };
}

/** Compile a single spec. Returns null if the spec cannot produce any value. */
export function compileSpec(spec: ArbSpec, options: CompileOptions = {}): Arbitrary<unknown> | null {
  return compile(spec, makeCtx(options));
}

/** Compile a signature into an arbitrary of argument lists. */
export function compileSignature(
  sig: SignatureSpec,
  options: CompileOptions = {},
): Arbitrary<unknown[]> | null {
  const ctx = makeCtx(options);
  const fixed: Arbitrary<unknown>[] = [];
  let rest: Arbitrary<unknown> | null = null;
  for (const p of sig.params) {
    const a = compile(p.spec, ctx);
    if (p.rest) {
      rest = a;
      continue;
    }
    if (!a) {
      if (p.optional) {
        fixed.push(fc.constant(undefined));
        continue;
      }
      return null;
    }
    fixed.push(a);
  }
  const base: Arbitrary<unknown[]> = fc.tuple(...fixed);
  if (!rest) return base;
  return fc.tuple(base, fc.array(rest, { maxLength: 4 })).map(([f, r]) => [...f, ...r]);
}
