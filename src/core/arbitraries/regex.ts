import fc, { type Arbitrary } from 'fast-check';

/** A regular expression found in the code under test (serializable). */
export interface MinedRegex {
  source: string;
  flags: string;
}

/**
 * Remove lookaround groups `(?=…)`, `(?!…)`, `(?<=…)`, `(?<!…)` (unsupported by fast-check's stringMatching).
 * The result describes a superset-ish shape of the original, which is what we want: inputs in the right format,
 * including near misses.
 */
export function stripLookarounds(source: string): string {
  let out = '';
  for (let i = 0; i < source.length; i++) {
    const c = source[i]!;
    if (c === '\\') {
      out += c + (source[i + 1] ?? '');
      i++;
      continue;
    }
    if (c === '(' && /^\(\?<?[=!]/.test(source.slice(i, i + 4))) {
      let depth = 0;
      let inClass = false;
      for (; i < source.length; i++) {
        const d = source[i]!;
        if (d === '\\') {
          i++;
          continue;
        }
        if (inClass) {
          if (d === ']') inClass = false;
          continue;
        }
        if (d === '[') inClass = true;
        else if (d === '(') depth++;
        else if (d === ')' && --depth === 0) break;
      }
      continue;
    }
    out += c;
  }
  return out;
}

/**
 * Replace backreferences (`\\3`) with a copy of the group they refer to (`(?:-?)`): fast-check cannot generate
 * backreferences. The copy matches a superset of what the backreference matches; that is fine for generating
 * inputs in the right format (the real regex still decides).
 */
export function inlineBackreferences(source: string): string {
  const groups: string[] = [];
  // Open groups: index into `groups` (-1 for non-capturing) and start position.
  const open: { idx: number; start: number }[] = [];
  let inClass = false;
  for (let i = 0; i < source.length; i++) {
    const c = source[i]!;
    if (c === '\\') {
      i++;
      continue;
    }
    if (inClass) {
      if (c === ']') inClass = false;
      continue;
    }
    if (c === '[') inClass = true;
    else if (c === '(') {
      const capturing = source[i + 1] !== '?' || /^\(\?<[A-Za-z_$]/.test(source.slice(i, i + 4));
      open.push({ idx: capturing ? groups.push('') - 1 : -1, start: i });
    } else if (c === ')') {
      const g = open.pop();
      if (g && g.idx >= 0) groups[g.idx] = source.slice(g.start, i + 1);
    }
  }
  if (groups.length === 0 || !/\\[1-9]/.test(source)) return source;
  let out = '';
  inClass = false;
  for (let i = 0; i < source.length; i++) {
    const c = source[i]!;
    if (c === '\\') {
      const m = /^[1-9]\d*/.exec(source.slice(i + 1));
      const n = m ? Number(m[0]) : 0;
      if (!inClass && m && n <= groups.length) {
        // Drop capturing/named-ness: `(?<x>a)` / `(a)` become `(?:a)`.
        const g = groups[n - 1]!.replace(/^\((?:\?<[A-Za-z_$][\w$]*>)?/, '(?:');
        out += g.includes('\\') && /\\[1-9]/.test(g) ? '(?:)' : g;
        i += m[0].length;
        continue;
      }
      out += c + (source[i + 1] ?? '');
      i++;
      continue;
    }
    if (inClass) {
      if (c === ']') inClass = false;
    } else if (c === '[') inClass = true;
    out += c;
  }
  return out;
}

/** Readable stand-ins for common Unicode property classes (generation only; the real regex still decides). */
const PROPERTY_CLASSES: [RegExp, string][] = [
  [/^(?:L|Letter|Alphabetic|Alpha|ID_Start|ID_Continue)$/, 'a-zA-Z\\u00e9\\u00df\\u0130'],
  [/^(?:Lu|Uppercase_Letter|Uppercase|Upper)$/, 'A-Z\\u00c9\\u0130'],
  [/^(?:Ll|Lowercase_Letter|Lowercase|Lower)$/, 'a-z\\u00e9\\u00df'],
  [/^(?:N|Nd|Number|Decimal_Number|digit)$/, '0-9'],
  [/^(?:P|Punctuation|Po)$/, '.,!?;:\\-'],
  [/^(?:Z|Zs|White_Space|Space_Separator)$/, ' '],
  [/^(?:M|Mark|Mn)$/, '\\u0301'],
];

/**
 * Replace `\p{Alphabetic}`, `\p{Lu}`, … with small readable classes. fast-check generates from the full Unicode
 * class, which yields mostly unassigned astral code points: valid, but nothing like real input.
 */
export function approximateProperties(source: string): string {
  let out = '';
  let inClass = false;
  for (let i = 0; i < source.length; i++) {
    const c = source[i]!;
    if (c === '\\') {
      const m = /^([pP])\{([^}]+)\}/.exec(source.slice(i + 1));
      const name = m?.[2]?.replace(/^(?:General_Category|gc|Script|sc)=/, '');
      const cls = name ? PROPERTY_CLASSES.find(([re]) => re.test(name))?.[1] : undefined;
      if (m && cls && !(inClass && m[1] === 'P')) {
        out += inClass ? cls : m[1] === 'p' ? `[${cls}]` : `[^${cls}]`;
        i += m[0].length;
        continue;
      }
      out += c + (source[i + 1] ?? '');
      i++;
      continue;
    }
    if (inClass) {
      if (c === ']') inClass = false;
    } else if (c === '[') inClass = true;
    out += c;
  }
  return out;
}

/** Arbitraries generating strings that match regexes from the code (skipping ones fast-check cannot handle). */
export function regexArbitraries(regexes: readonly MinedRegex[]): Arbitrary<string>[] {
  const out: Arbitrary<string>[] = [];
  for (const r of regexes) {
    try {
      const flags = r.flags.replace(/[gyi]/g, '');
      const re = new RegExp(approximateProperties(stripLookarounds(inlineBackreferences(r.source))), flags);
      const arb = fc.stringMatching(re, { size: 'small' });
      // Probe once: some patterns construct fine but fail on generation.
      fc.sample(arb, { numRuns: 3, seed: 1 });
      out.push(arb);
    } catch {
      /* unsupported pattern: skip */
    }
  }
  return out;
}

const MUTATION_CHARS = [...'0123456789aZ-_. /:'];

function testable(r: MinedRegex): RegExp | undefined {
  try {
    return new RegExp(r.source, r.flags.replace(/[gy]/g, ''));
  } catch {
    return undefined;
  }
}

/**
 * Strings that the regexes of one version classify differently from the regexes of the other version. When a fix
 * changes a regex (`3([0-5]\d|6[1-6])` to `3([0-5]\d|6[0-6])`), random strings in the format almost never land
 * on the few inputs where the two disagree; sampling both regexes and keeping the strings where they disagree
 * finds them directly. Only regexes that differ between the versions take part.
 */
export function regexDiffStrings(
  base: readonly MinedRegex[],
  head: readonly MinedRegex[],
  options: { samples?: number; seed?: number; max?: number } = {},
): string[] {
  const key = (r: MinedRegex) => `${r.source}/${r.flags}`;
  const headKeys = new Set(head.map(key));
  const baseKeys = new Set(base.map(key));
  const oldOnly = base.filter((r) => !headKeys.has(key(r)));
  const newOnly = head.filter((r) => !baseKeys.has(key(r)));
  if (oldOnly.length === 0 || newOnly.length === 0) return [];
  const oldRes = oldOnly.map(testable).filter((r): r is RegExp => !!r);
  const newRes = newOnly.map(testable).filter((r): r is RegExp => !!r);
  if (oldRes.length === 0 || newRes.length === 0) return [];
  const verdict = (res: RegExp[], s: string) => res.map((r) => r.test(s)).join();
  // Pairwise when the counts match (the usual case: each changed regex has one counterpart), otherwise "any".
  const differs = (s: string) =>
    oldRes.length === newRes.length
      ? verdict(oldRes, s) !== verdict(newRes, s)
      : oldRes.some((r) => r.test(s)) !== newRes.some((r) => r.test(s));
  const max = options.max ?? 30;
  const samples = options.samples ?? 400;
  const out = new Set<string>();
  const arbs = regexArbitraries([...oldOnly, ...newOnly]);
  arbs.forEach((arb, i) => {
    let xs: string[];
    try {
      xs = fc.sample(arb, { numRuns: samples, seed: (options.seed ?? 1) + i });
    } catch {
      return;
    }
    for (const s of xs) if (differs(s)) out.add(s);
    // Local search: the disagreement is usually one character away from a sample ("2009-361" -> "2009-360").
    for (const s of xs.slice(0, 120)) {
      if (s.length > 40 || out.size >= max * 4) break;
      const alphabet = [...new Set([...MUTATION_CHARS, ...s])];
      for (let p = 0; p < s.length; p++) {
        for (const ch of alphabet) {
          if (ch === s[p]) continue;
          const v = s.slice(0, p) + ch + s.slice(p + 1);
          if (differs(v)) out.add(v);
        }
      }
    }
  });
  return [...out].sort((a, b) => a.length - b.length || (a < b ? -1 : 1)).slice(0, max);
}
