/**
 * ArbSpec: a plain, JSON-serializable description of the values a parameter can take.
 *
 * It is derived from TypeScript types (see `fromType.ts`) and compiled to fast-check arbitraries
 * (see `../arbitraries/compile.ts`). Keeping this intermediate representation separate makes type
 * analysis testable without fast-check and lets us hash, compare and print specs.
 */
export type ArbSpec =
  /** `size`: a count, length, index or loop bound (see analyze/sizeParams.ts), generated in realistic ranges. */
  | { kind: 'number'; size?: boolean }
  | { kind: 'bigint' }
  | { kind: 'string' }
  | { kind: 'boolean' }
  | { kind: 'undefined' }
  | { kind: 'null' }
  | { kind: 'literal'; value: string | number | boolean }
  | { kind: 'bigintLiteral'; value: string }
  | { kind: 'union'; options: ArbSpec[] }
  | { kind: 'array'; items: ArbSpec }
  | { kind: 'tuple'; items: ArbSpec[]; optionalFrom?: number; rest?: ArbSpec }
  | { kind: 'object'; props: PropSpec[] }
  | { kind: 'record'; key: 'string' | 'number'; values: ArbSpec }
  | { kind: 'date' }
  | { kind: 'binary'; ctor: BinaryCtor }
  | { kind: 'map'; key: ArbSpec; value: ArbSpec }
  | { kind: 'set'; items: ArbSpec }
  | { kind: 'function'; returns: ArbSpec; async: boolean }
  | { kind: 'recursive'; id: string; spec: ArbSpec }
  | { kind: 'ref'; id: string }
  | { kind: 'anything' }
  | { kind: 'unsupported'; reason: string };

/** Binary built-ins: typed arrays, ArrayBuffer and DataView. */
export const BINARY_CTORS = [
  'Uint8Array',
  'Uint8ClampedArray',
  'Int8Array',
  'Uint16Array',
  'Int16Array',
  'Uint32Array',
  'Int32Array',
  'Float32Array',
  'Float64Array',
  'BigInt64Array',
  'BigUint64Array',
  'ArrayBuffer',
  'DataView',
] as const;
export type BinaryCtor = (typeof BINARY_CTORS)[number];

export interface PropSpec {
  name: string;
  spec: ArbSpec;
  optional: boolean;
}

export interface ParamSpec {
  name: string;
  spec: ArbSpec;
  /** Optional or defaulted parameter: `undefined` is a valid argument. */
  optional: boolean;
  /** Rest parameter: `spec` describes one element; zero or more are spread at the end. */
  rest: boolean;
}

export interface SignatureSpec {
  params: ParamSpec[];
  /** The function's declared return type is a Promise / it is declared `async`. */
  async: boolean;
}

/** Returns the first `unsupported` reason found in a spec, or undefined if the spec is fully supported. */
export function findUnsupported(spec: ArbSpec): string | undefined {
  switch (spec.kind) {
    case 'unsupported':
      return spec.reason;
    case 'union':
      // A union is usable if at least one option is supported; unsupported options are dropped at compile time.
      return spec.options.every((o) => findUnsupported(o) !== undefined)
        ? findUnsupported(spec.options[0] ?? { kind: 'unsupported', reason: 'empty union' })
        : undefined;
    case 'array':
    case 'set':
      return findUnsupported(spec.items);
    case 'tuple':
      for (const item of spec.items) {
        const r = findUnsupported(item);
        if (r) return r;
      }
      return spec.rest ? findUnsupported(spec.rest) : undefined;
    case 'object':
      for (const p of spec.props) {
        const r = p.optional ? undefined : findUnsupported(p.spec);
        if (r) return `${p.name}: ${r}`;
      }
      return undefined;
    case 'record':
      return findUnsupported(spec.values);
    case 'map':
      return findUnsupported(spec.key) ?? findUnsupported(spec.value);
    case 'function':
      return findUnsupported(spec.returns);
    case 'recursive':
      return findUnsupported(spec.spec);
    default:
      return undefined;
  }
}

export function signatureUnsupported(sig: SignatureSpec): string | undefined {
  for (const p of sig.params) {
    const r = p.optional ? undefined : findUnsupported(p.spec);
    if (r) return `parameter \`${p.name}\`: ${r}`;
  }
  return undefined;
}

/** Compact human-readable rendering of a spec, TypeScript-like. Used in reports and tests. */
export function printSpec(spec: ArbSpec): string {
  switch (spec.kind) {
    case 'literal':
      return typeof spec.value === 'string' ? JSON.stringify(spec.value) : String(spec.value);
    case 'bigintLiteral':
      return `${spec.value}n`;
    case 'union':
      return spec.options.map(printSpec).join(' | ');
    case 'array': {
      const inner = printSpec(spec.items);
      return spec.items.kind === 'union' || spec.items.kind === 'function' ? `(${inner})[]` : `${inner}[]`;
    }
    case 'tuple': {
      const items = spec.items.map((s, i) =>
        spec.optionalFrom !== undefined && i >= spec.optionalFrom ? `${printSpec(s)}?` : printSpec(s),
      );
      if (spec.rest) items.push(`...${printSpec(spec.rest)}[]`);
      return `[${items.join(', ')}]`;
    }
    case 'object':
      return `{ ${spec.props.map((p) => `${p.name}${p.optional ? '?' : ''}: ${printSpec(p.spec)}`).join('; ')} }`;
    case 'record':
      return `Record<${spec.key}, ${printSpec(spec.values)}>`;
    case 'date':
      return 'Date';
    case 'binary':
      return spec.ctor;
    case 'map':
      return `Map<${printSpec(spec.key)}, ${printSpec(spec.value)}>`;
    case 'set':
      return `Set<${printSpec(spec.items)}>`;
    case 'function':
      return `() => ${spec.async ? `Promise<${printSpec(spec.returns)}>` : printSpec(spec.returns)}`;
    case 'recursive':
      return `${spec.id}=${printSpec(spec.spec)}`;
    case 'ref':
      return spec.id;
    case 'anything':
      return 'unknown';
    case 'unsupported':
      return `<unsupported: ${spec.reason}>`;
    default:
      return spec.kind;
  }
}

/** Mark number-typed parts of a parameter spec (including inside unions) as size-like. */
export function markSize(spec: ArbSpec): ArbSpec {
  if (spec.kind === 'number') return { kind: 'number', size: true };
  if (spec.kind === 'union') return { ...spec, options: spec.options.map(markSize) };
  return spec;
}
