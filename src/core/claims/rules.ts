/**
 * Keyless, deterministic claim matching: compares observed behavior changes with the PR title/description
 * using documented rules. This is the default; no LLM or API key is involved.
 *
 * Rules (first match wins), see docs/CLAIMS.md:
 *  1. Intent "no behavior change": an explicit phrase ("no behavior change", "pure refactor", "behavior-preserving",
 *     ...), a conventional-commit type refactor/perf/chore/style/build/ci/test/docs, a fix/feat title whose text is
 *     only about performance ("fix: faster paths for compare"), or refactor-style words ("refactor", "cleanup",
 *     "rename", "simplify", "faster", ...) without change words. Every behavior change is **unclaimed**.
 *  2. The PR text names the function (its export name, a distinctive word of a camelCase name, or a changed
 *     helper it calls): **claimed**.
 *  3. The PR text names other changed functions but not this one: **unclaimed**.
 *  4. Otherwise: neutral **behavior change**.
 */
export type Intent = 'no-change' | 'change' | 'unknown';

export interface ClaimAnalysis {
  intent: Intent;
  /** The words that decided the intent, for explanations. */
  intentEvidence?: string;
  /** Lower-cased identifier-like words of the claim. */
  words: Set<string>;
  /** Identifiers written as code (`foo`) or in camelCase/snake_case, as written. */
  identifiers: Set<string>;
}

const NO_CHANGE_TYPES = new Set([
  'refactor',
  'perf',
  'chore',
  'style',
  'build',
  'ci',
  'test',
  'tests',
  'docs',
]);
const CHANGE_TYPES = new Set(['fix', 'feat', 'feature', 'bugfix', 'hotfix', 'revert', 'security']);

const EXPLICIT_NO_CHANGE = [
  /\bno (?:functional|behaviou?ral|behaviou?r|logic|user[- ]facing|runtime) changes?\b/i,
  /\bno changes? (?:in|to) (?:behaviou?r|functionality|logic|output)\b/i,
  /\bpure(?:ly)?[- ]refactor/i,
  /\bbehaviou?r[- ]preserving\b/i,
  /\bnon[- ]functional (?:change|refactor)/i,
  /\bwithout (?:changing|any change (?:in|to)) (?:behaviou?r|functionality|output)\b/i,
  /\bsemantics?[- ]preserving\b/i,
];

const NO_CHANGE_WORDS =
  /\b(refactor(?:s|ed|ing)?|clean(?:s|ed|ing)?[- ]?up|cleanups?|tidy|tidies|renam(?:e|es|ed|ing)|simplif(?:y|ies|ied|ication)|moderni[sz](?:e|es|ed|ation)|restructur(?:e|es|ed|ing)|reorgani[sz](?:e|es|ed)|extract(?:s|ed)?|perf(?:ormance)?|optimi[sz](?:e|es|ed|ation)|faster|speed[- ]?up|lint|formatting|typos?|dead code)\b/i;

const CHANGE_WORDS =
  /\b(fix(?:es|ed|ing)?|bugs?|regression|crash(?:es|ed)?|errors?|wrong|incorrect(?:ly)?|broken|issues?|feat(?:ure)?s?|add(?:s|ed|ing)?|support(?:s|ed)?|handle(?:s|d)?|allow(?:s|ed)?|reject(?:s|ed)?|correct(?:s|ed|ly)?|prevent(?:s|ed)?|now (?:returns?|throws?|accepts?)|change(?:s|d)? (?:the )?behaviou?r|breaking)\b/i;

const PERF_WORDS =
  /\b(perf(?:ormance)?|faster|speed[- ]?up|optimi[sz](?:e|es|ed|ation)|fast[- ]path|cach(?:e|ing))\b/i;

/** Generic name parts that say nothing about which function a PR is about. */
const STOP_PARTS = new Set([
  'get',
  'set',
  'is',
  'has',
  'to',
  'from',
  'with',
  'without',
  'for',
  'of',
  'on',
  'in',
  'and',
  'or',
  'by',
  'as',
  'make',
  'create',
  'build',
  'new',
  'apply',
  'use',
  'run',
  'do',
  'can',
  'should',
  'parse',
  'format',
  'value',
  'values',
  'data',
  'item',
  'items',
  'list',
  'util',
  'utils',
  'helper',
  'helpers',
  'default',
  'index',
  'main',
  'all',
  'any',
  'each',
  'some',
  'find',
  'first',
  'last',
  'string',
  'number',
  'array',
  'object',
]);

/** Split `applyDiscount`, `apply_discount`, `HTTPServer` into lower-case words. */
export function nameParts(name: string): string[] {
  return name
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .map((w) => w.toLowerCase());
}

export function analyzeClaim(text: string | null | undefined): ClaimAnalysis {
  const t = (text ?? '').trim();
  const words = new Set((t.toLowerCase().match(/[a-z0-9_$]+/g) ?? []).flatMap((w) => [w, ...nameParts(w)]));
  const identifiers = new Set<string>();
  for (const m of t.matchAll(/`([^`]+)`/g))
    for (const id of m[1]!.match(/[A-Za-z_$][\w$]*/g) ?? []) identifiers.add(id);
  for (const m of t.matchAll(/\b[a-z]+[A-Z][A-Za-z0-9]*\b|\b[a-z0-9]+_[a-z0-9_]+\b/g)) identifiers.add(m[0]);

  const base = { words, identifiers };
  if (!t) return { intent: 'unknown', ...base };
  const explicit = EXPLICIT_NO_CHANGE.map((re) => re.exec(t)).find(Boolean);
  if (explicit) return { intent: 'no-change', intentEvidence: explicit[0], ...base };

  const title = t.split(/\r?\n/)[0]!.replace(/^#+\s*/, '');
  const conventional =
    /^\s*([a-z]+)(?:\([^)]*\))?!?:/i.exec(title) ?? /^\s*([a-z]+)\[[^\]]*\]:?/i.exec(title);
  const type = conventional?.[1]?.toLowerCase();
  if (type && NO_CHANGE_TYPES.has(type)) return { intent: 'no-change', intentEvidence: `${type}:`, ...base };
  if (type && CHANGE_TYPES.has(type)) {
    // "fix: faster paths for compare" is a performance change: perf wording and no change words after the prefix.
    const rest = title.slice(conventional![0].length);
    const perf = PERF_WORDS.exec(rest);
    if (perf && !CHANGE_WORDS.exec(rest)) return { intent: 'no-change', intentEvidence: perf[0], ...base };
    return { intent: 'change', intentEvidence: `${type}:`, ...base };
  }

  const change = CHANGE_WORDS.exec(t);
  const noChange = NO_CHANGE_WORDS.exec(t);
  if (noChange && !change) return { intent: 'no-change', intentEvidence: noChange[0], ...base };
  if (change) return { intent: 'change', intentEvidence: change[0], ...base };
  return { intent: 'unknown', ...base };
}

export interface RuleTarget {
  exportName: string;
  file: string;
  /** Changed helpers this function uses (from detection, e.g. "uses changed `toCents`"). */
  helpers: string[];
}

export interface RuleLabel {
  label: 'claimed' | 'unclaimed' | 'behavior-change';
  explanation?: string;
}

function stem(file: string): string {
  return (file.split('/').pop() ?? file).replace(/\.[^.]+$/, '');
}

/** Which names of this function (export name, file stem for default exports, helpers) does the claim mention? */
export function mentionedNames(target: RuleTarget, a: ClaimAnalysis): string[] {
  const names = [target.exportName === 'default' ? stem(target.file) : target.exportName, ...target.helpers];
  const hits: string[] = [];
  for (const name of names) {
    if (a.identifiers.has(name) || a.words.has(name.toLowerCase())) {
      hits.push(name);
      continue;
    }
    const parts = nameParts(name).filter((p) => p.length >= 5 && !STOP_PARTS.has(p));
    const part = parts.find((p) => a.words.has(p));
    if (part) hits.push(`${name} ("${part}")`);
  }
  return hits;
}

/** Label one function's behavior changes. `others` are all changed functions in the report. */
export function ruleLabel(target: RuleTarget, a: ClaimAnalysis, others: RuleTarget[]): RuleLabel {
  if (a.intent === 'no-change') return { label: 'unclaimed' };
  const hits = mentionedNames(target, a);
  if (hits.length > 0) {
    const described = hits.map((h) => {
      const part = / \("(.+)"\)$/.exec(h);
      const name = h.replace(/ \(.*$/, '');
      return part ? `"${part[1]}" (\`${name}\`)` : `\`${name}\``;
    });
    return { label: 'claimed', explanation: `The PR mentions ${described.join(', ')}.` };
  }
  const othersMentioned = others.filter((o) => o !== target && mentionedNames(o, a).length > 0);
  if (othersMentioned.length > 0) {
    return {
      label: 'unclaimed',
      explanation: `The PR mentions ${othersMentioned
        .map((o) => `\`${o.exportName}\``)
        .slice(0, 3)
        .join(', ')} but not \`${target.exportName}\`.`,
    };
  }
  return { label: 'behavior-change' };
}

/** Helper names from a detection reason like "uses changed `toCents` (via wrap)". */
export function helpersFromReason(reason: string | undefined): string[] {
  return [...(reason ?? '').matchAll(/`([^`]+)`/g)].map((m) => m[1]!);
}
