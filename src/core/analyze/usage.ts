import { readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { ts } from 'ts-morph';

/**
 * How a function is actually used in the repository: literal arguments at call sites (in sources and tests) and the
 * literal values of test files that exercise it. Used to run real inputs first, to bias generation towards them, and
 * to judge how realistic a counterexample is.
 */
export interface Usage {
  /** Argument lists of call sites whose arguments are all literals. */
  tuples: unknown[][];
  /** Literal numbers seen at call sites and in tests of the function. */
  numbers: number[];
  /** Literal strings seen at call sites and in tests of the function. */
  strings: string[];
  /** Number of files that referenced the function. */
  files: number;
  /** Number of numeric literal occurrences behind `numbers` (repeated values count). */
  numberObservations: number;
}

export function emptyUsage(): Usage {
  return { tuples: [], numbers: [], strings: [], files: 0, numberObservations: 0 };
}

const TEST_FILE = /(^|\/)(test|tests|__tests__|spec)\/|\.(test|spec)\.[cm]?[jt]sx?$/;
const MAX_TUPLES = 60;
const MAX_POOL = 400;
const MAX_FILE_BYTES = 512 * 1024;

const NOT_LITERAL = Symbol('not-literal');

/** Evaluate a literal expression (numbers, strings, booleans, null/undefined, arrays/objects of literals). */
function literalValue(node: ts.Node, depth = 0): unknown {
  if (depth > 6) return NOT_LITERAL;
  if (ts.isNumericLiteral(node)) return Number(node.text);
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
  if (ts.isPrefixUnaryExpression(node) && ts.isNumericLiteral(node.operand)) {
    if (node.operator === ts.SyntaxKind.MinusToken) return -Number(node.operand.text);
    if (node.operator === ts.SyntaxKind.PlusToken) return Number(node.operand.text);
  }
  if (node.kind === ts.SyntaxKind.TrueKeyword) return true;
  if (node.kind === ts.SyntaxKind.FalseKeyword) return false;
  if (node.kind === ts.SyntaxKind.NullKeyword) return null;
  if (ts.isIdentifier(node)) {
    if (node.text === 'undefined') return undefined;
    if (node.text === 'NaN') return NaN;
    if (node.text === 'Infinity') return Infinity;
    return NOT_LITERAL;
  }
  if (ts.isParenthesizedExpression(node) || ts.isAsExpression(node))
    return literalValue(node.expression, depth + 1);
  if (ts.isArrayLiteralExpression(node)) {
    const out: unknown[] = [];
    for (const el of node.elements) {
      const v = literalValue(el, depth + 1);
      if (v === NOT_LITERAL) return NOT_LITERAL;
      out.push(v);
    }
    return out;
  }
  if (ts.isObjectLiteralExpression(node)) {
    const out: Record<string, unknown> = {};
    for (const p of node.properties) {
      if (!ts.isPropertyAssignment(p)) return NOT_LITERAL;
      const key =
        ts.isIdentifier(p.name) || ts.isStringLiteral(p.name) || ts.isNumericLiteral(p.name)
          ? p.name.text
          : undefined;
      if (key === undefined || key === '__proto__') return NOT_LITERAL;
      const v = literalValue(p.initializer, depth + 1);
      if (v === NOT_LITERAL) return NOT_LITERAL;
      out[key] = v;
    }
    return out;
  }
  return NOT_LITERAL;
}

function calleeName(expr: ts.Expression): string | undefined {
  if (ts.isIdentifier(expr)) return expr.text;
  if (ts.isPropertyAccessExpression(expr)) return expr.name.text;
  return undefined;
}

/**
 * Collect usage of `names` (export name, plus the file stem for default exports) across `files`
 * (repo-relative paths under `root`).
 */
export function collectUsage(root: string, files: string[], names: string[]): Usage {
  const usage = emptyUsage();
  const nameSet = new Set(names.filter((n) => n && n !== 'default'));
  if (nameSet.size === 0) return usage;
  const pattern = new RegExp(`\\b(${[...nameSet].map((n) => n.replace(/[$]/g, '\\$')).join('|')})\\b`);
  const numbers = new Set<number>();
  const strings = new Set<string>();
  const tupleKeys = new Set<string>();

  for (const rel of files) {
    let text: string;
    try {
      text = readFileSync(join(root, rel), 'utf8');
    } catch {
      continue;
    }
    if (text.length > MAX_FILE_BYTES || !pattern.test(text)) continue;
    usage.files++;
    const isTest = TEST_FILE.test(rel);
    const sf = ts.createSourceFile(basename(rel), text, ts.ScriptTarget.Latest, true);
    const visit = (node: ts.Node) => {
      if (ts.isCallExpression(node)) {
        const name = calleeName(node.expression);
        if (name && nameSet.has(name)) {
          const args = node.arguments.map((a) => literalValue(a));
          for (const a of args) if (typeof a === 'number') usage.numberObservations++;
          for (const a of args) collectLeaves(a, numbers, strings);
          if (args.length > 0 && args.every((a) => a !== NOT_LITERAL) && usage.tuples.length < MAX_TUPLES) {
            const key = JSON.stringify(args, (_k, v) =>
              typeof v === 'number' && !Number.isFinite(v) ? String(v) : v,
            );
            if (!tupleKeys.has(key)) {
              tupleKeys.add(key);
              usage.tuples.push(args);
            }
          }
        }
      }
      // Tests often keep inputs in tables (`[['1', '2'], [1, 2]].forEach(...)`): their literals are usage too.
      if (isTest && numbers.size + strings.size < MAX_POOL) {
        const v =
          ts.isNumericLiteral(node) || ts.isStringLiteral(node) || ts.isPrefixUnaryExpression(node)
            ? literalValue(node)
            : NOT_LITERAL;
        if (v !== NOT_LITERAL && !isImportSpecifier(node) && !isTestTitle(node) && !isExpectedValue(node)) {
          if (typeof v === 'number') usage.numberObservations++;
          collectLeaves(v, numbers, strings);
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(sf);
  }
  usage.numbers = [...numbers].slice(0, MAX_POOL);
  usage.strings = [...strings].slice(0, MAX_POOL);
  return usage;
}

/** Assertion calls whose arguments after the first (or all, for matchers) are expected outputs, not inputs. */
const ASSERT_SECOND = new Set([
  'equal',
  'equals',
  'strictEqual',
  'deepEqual',
  'deepStrictEqual',
  'notEqual',
  'same',
  'is',
  'eq',
  'assertEquals',
  'match',
]);
const MATCHERS = new Set([
  'toBe',
  'toEqual',
  'toStrictEqual',
  'toMatchObject',
  'toContain',
  'toBeCloseTo',
  'toThrow',
  'toHaveLength',
  'toBeGreaterThan',
  'toBeLessThan',
  'toBeGreaterThanOrEqual',
  'toBeLessThanOrEqual',
  'eql',
  'equal',
]);

/** Is this literal (part of) an expected value in an assertion? */
function isExpectedValue(node: ts.Node): boolean {
  let child: ts.Node = node;
  for (let p = node.parent; p; child = p, p = p.parent) {
    if (ts.isCallExpression(p)) {
      const name = calleeName(p.expression);
      const index = p.arguments.indexOf(child as ts.Expression);
      if (name && index >= 0) {
        if (MATCHERS.has(name) && ts.isPropertyAccessExpression(p.expression)) return true;
        if (ASSERT_SECOND.has(name) && index >= 1) return true;
      }
      return false;
    }
    if (ts.isSourceFile(p) || ts.isBlock(p)) return false;
  }
  return false;
}

const TEST_FUNCTIONS = new Set(['describe', 'it', 'test', 'suite', 'context', 'bench']);

function isTestTitle(node: ts.Node): boolean {
  const p = node.parent;
  if (!p || !ts.isCallExpression(p) || p.arguments[0] !== node) return false;
  const callee = ts.isPropertyAccessExpression(p.expression) ? p.expression.expression : p.expression;
  return ts.isIdentifier(callee) && TEST_FUNCTIONS.has(callee.text);
}

function isImportSpecifier(node: ts.Node): boolean {
  const p = node.parent;
  return (
    !!p &&
    (ts.isImportDeclaration(p) ||
      ts.isExportDeclaration(p) ||
      (ts.isCallExpression(p) && ts.isIdentifier(p.expression) && p.expression.text === 'require'))
  );
}

function collectLeaves(v: unknown, numbers: Set<number>, strings: Set<string>): void {
  if (v === NOT_LITERAL) return;
  if (typeof v === 'number') numbers.add(v);
  else if (typeof v === 'string') {
    if (v.length <= 200) strings.add(v);
  } else if (Array.isArray(v)) v.forEach((x) => collectLeaves(x, numbers, strings));
  else if (v && typeof v === 'object') Object.values(v).forEach((x) => collectLeaves(x, numbers, strings));
}
