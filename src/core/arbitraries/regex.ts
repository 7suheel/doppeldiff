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

/** Arbitraries generating strings that match regexes from the code (skipping ones fast-check cannot handle). */
export function regexArbitraries(regexes: readonly MinedRegex[]): Arbitrary<string>[] {
  const out: Arbitrary<string>[] = [];
  for (const r of regexes) {
    try {
      const flags = r.flags.replace(/[gyi]/g, '');
      const re = new RegExp(stripLookarounds(r.source), flags);
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
