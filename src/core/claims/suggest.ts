import type { ArbSpec, SignatureSpec } from '../types/spec.js';
import type { LlmProvider } from './providers.js';

/**
 * Optional LLM step: suggest targeted edge-case inputs for a changed function. Suggestions are plain
 * literals parsed with a small safe parser (never eval'd) and must conform to the parameter types.
 */
export const SUGGEST_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['inputs'],
  properties: {
    inputs: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['args'],
        properties: {
          args: {
            type: 'string',
            description:
              'The argument list as a JavaScript array literal, e.g. [1000.01, 0.15]. Use only literals.',
          },
        },
      },
    },
  },
} as const;

const SYSTEM = `You help a differential-testing tool find inputs where the old and new version of a function behave differently.
Given both versions and the parameter types, propose up to 20 argument lists that are most likely to expose a difference: boundary values around constants in the code, empty/negative/zero/NaN values, special characters, edge cases the change touches.
Write each argument list as a JavaScript array literal using only: numbers (including NaN, Infinity, -Infinity, -0), strings in double quotes, true, false, null, undefined, arrays and plain objects with quoted or identifier keys. No expressions, no function calls.`;

export function buildSuggestPrompt(
  name: string,
  signature: string,
  baseSource: string,
  headSource: string,
): string {
  const clip = (s: string) => (s.length > 8000 ? `${s.slice(0, 8000)}\n// … truncated` : s);
  return `Function: ${signature}\n\n<old_version>\n${clip(baseSource)}\n</old_version>\n\n<new_version>\n${clip(headSource)}\n</new_version>\n\nPropose argument lists for ${name}.`;
}

/** Safe parser for JavaScript literal values (no evaluation). Throws on anything else. */
export function parseLiteral(src: string): unknown {
  let i = 0;
  const ws = () => {
    while (i < src.length && /\s/.test(src[i]!)) i++;
  };
  const fail = (msg: string): never => {
    throw new Error(`${msg} at ${i}`);
  };
  const value = (depth: number): unknown => {
    if (depth > 20) fail('too deep');
    ws();
    const c = src[i];
    if (c === '[') {
      i++;
      const arr: unknown[] = [];
      ws();
      if (src[i] === ']') {
        i++;
        return arr;
      }
      for (;;) {
        arr.push(value(depth + 1));
        ws();
        if (src[i] === ',') {
          i++;
          ws();
          if (src[i] === ']') {
            i++;
            return arr;
          }
          continue;
        }
        if (src[i] === ']') {
          i++;
          return arr;
        }
        fail('expected , or ]');
      }
    }
    if (c === '{') {
      i++;
      const obj: Record<string, unknown> = {};
      ws();
      if (src[i] === '}') {
        i++;
        return obj;
      }
      for (;;) {
        ws();
        let key: string;
        if (src[i] === '"' || src[i] === "'") key = str();
        else {
          const m = /^[A-Za-z_$][\w$]*/.exec(src.slice(i));
          if (!m) fail('expected key');
          key = m![0];
          i += key.length;
        }
        if (key === '__proto__' || key === 'constructor' || key === 'prototype') fail('forbidden key');
        ws();
        if (src[i] !== ':') fail('expected :');
        i++;
        obj[key] = value(depth + 1);
        ws();
        if (src[i] === ',') {
          i++;
          ws();
          if (src[i] === '}') {
            i++;
            return obj;
          }
          continue;
        }
        if (src[i] === '}') {
          i++;
          return obj;
        }
        fail('expected , or }');
      }
    }
    if (c === '"' || c === "'") return str();
    const rest = src.slice(i);
    for (const [word, v] of [
      ['true', true],
      ['false', false],
      ['null', null],
      ['undefined', undefined],
      ['NaN', NaN],
      ['Infinity', Infinity],
      ['-Infinity', -Infinity],
    ] as const) {
      if (rest.startsWith(word) && !/[\w$]/.test(rest[word.length] ?? '')) {
        i += word.length;
        return v;
      }
    }
    const m = /^-?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?/i.exec(rest);
    if (m) {
      i += m[0].length;
      return Number(m[0]);
    }
    return fail('unexpected token');
  };
  const str = (): string => {
    const q = src[i];
    i++;
    let out = '';
    while (i < src.length && src[i] !== q) {
      if (src[i] === '\\') {
        const n = src[i + 1];
        const map: Record<string, string> = {
          n: '\n',
          t: '\t',
          r: '\r',
          '\\': '\\',
          '"': '"',
          "'": "'",
          '0': '\0',
        };
        if (n === 'u') {
          out += String.fromCharCode(parseInt(src.slice(i + 2, i + 6), 16));
          i += 6;
          continue;
        }
        out += map[n ?? ''] ?? n ?? '';
        i += 2;
        continue;
      }
      out += src[i++];
    }
    if (src[i] !== q) fail('unterminated string');
    i++;
    return out;
  };
  const v = value(0);
  ws();
  if (i !== src.length) fail('trailing characters');
  return v;
}

/** Does a value conform to a spec? Used to validate LLM suggestions before running them. */
export function conforms(spec: ArbSpec, v: unknown, defs = new Map<string, ArbSpec>()): boolean {
  switch (spec.kind) {
    case 'number':
      return typeof v === 'number';
    case 'bigint':
      return typeof v === 'bigint';
    case 'string':
      return typeof v === 'string';
    case 'boolean':
      return typeof v === 'boolean';
    case 'undefined':
      return v === undefined;
    case 'null':
      return v === null;
    case 'literal':
      return Object.is(v, spec.value) || v === spec.value;
    case 'bigintLiteral':
      return typeof v === 'bigint' && v.toString() === spec.value;
    case 'union':
      return spec.options.some((o) => conforms(o, v, defs));
    case 'array':
      return Array.isArray(v) && v.every((x) => conforms(spec.items, x, defs));
    case 'tuple': {
      if (!Array.isArray(v)) return false;
      const min = spec.optionalFrom ?? spec.items.length;
      if (v.length < min || (!spec.rest && v.length > spec.items.length)) return false;
      return v.every((x, idx) => {
        const s = spec.items[idx] ?? spec.rest;
        return s !== undefined && conforms(s, x, defs);
      });
    }
    case 'object': {
      if (typeof v !== 'object' || v === null || Array.isArray(v)) return false;
      const o = v as Record<string, unknown>;
      return spec.props.every((p) =>
        p.name in o
          ? (p.optional && o[p.name] === undefined) || conforms(p.spec, o[p.name], defs)
          : p.optional,
      );
    }
    case 'record':
      return (
        typeof v === 'object' &&
        v !== null &&
        !Array.isArray(v) &&
        Object.values(v).every((x) => conforms(spec.values, x, defs))
      );
    case 'recursive':
      defs.set(spec.id, spec.spec);
      return conforms(spec.spec, v, defs);
    case 'ref': {
      const d = defs.get(spec.id);
      return d !== undefined && conforms(d, v, defs);
    }
    case 'anything':
      return true;
    default:
      // Dates, Maps, Sets and callbacks cannot be written as plain literals; unsupported never conforms.
      return false;
  }
}

export function conformsSignature(sig: SignatureSpec, args: unknown[]): boolean {
  const fixed = sig.params.filter((p) => !p.rest);
  const rest = sig.params.find((p) => p.rest);
  if (args.length < fixed.filter((p) => !p.optional).length) return false;
  if (!rest && args.length > fixed.length) return false;
  return args.every((a, idx) => {
    const p = fixed[idx] ?? rest;
    return p !== undefined && conforms(p.spec, a);
  });
}

export interface SuggestResult {
  accepted: unknown[][];
  rejected: number;
}

export async function suggestInputs(
  provider: LlmProvider,
  ctx: { name: string; signature: string; spec: SignatureSpec; baseSource: string; headSource: string },
): Promise<SuggestResult> {
  const text = await provider.complete({
    system: SYSTEM,
    user: buildSuggestPrompt(ctx.name, ctx.signature, ctx.baseSource, ctx.headSource),
    schema: SUGGEST_SCHEMA,
    schemaName: 'edge_case_inputs',
    maxTokens: 8000,
  });
  let parsed: { inputs?: { args?: unknown }[] };
  try {
    parsed = JSON.parse(text) as typeof parsed;
  } catch {
    return { accepted: [], rejected: 0 };
  }
  const accepted: unknown[][] = [];
  let rejected = 0;
  for (const item of (parsed.inputs ?? []).slice(0, 30)) {
    try {
      const args = parseLiteral(String(item.args ?? ''));
      if (Array.isArray(args) && conformsSignature(ctx.spec, args)) accepted.push(args);
      else rejected++;
    } catch {
      rejected++;
    }
  }
  return { accepted, rejected };
}
