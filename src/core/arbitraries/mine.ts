import { Node, SyntaxKind } from 'ts-morph';
import type { MinedRegex } from './regex.js';

/** Values mined from source code, used to bias generation towards interesting regions. */
export interface MinedValues {
  /** Numeric literals and their neighbours (v, v±1, v±0.01, -v) plus universal boundaries. */
  numbers: number[];
  /** Numeric literals that appear as an operand of a comparison: decision boundaries. */
  thresholds: number[];
  /** String literals and simple variants. */
  strings: string[];
  /** Property names the code reads (`options.min`, `obj["key"]`, destructured names): keys for untyped objects. */
  keys: string[];
  /** Short string literals as-is: fragments for composing structured strings (paths, URLs, formats). */
  fragments: string[];
  /** Regular expressions in the code: inputs in the format the code parses. */
  regexes: MinedRegex[];
}

export const NUMBER_BOUNDARIES: readonly number[] = [
  0,
  -0,
  1,
  -1,
  0.5,
  NaN,
  Infinity,
  -Infinity,
  Number.MAX_SAFE_INTEGER,
  Number.MIN_SAFE_INTEGER,
  Number.MIN_VALUE,
  Number.EPSILON,
];

export const STRING_BOUNDARIES: readonly string[] = ['', ' ', 'a', 'A', '0', '-', '  a  ', 'é', '😀', '\n'];

const COMPARISON_OPERATORS = new Set([
  SyntaxKind.LessThanToken,
  SyntaxKind.LessThanEqualsToken,
  SyntaxKind.GreaterThanToken,
  SyntaxKind.GreaterThanEqualsToken,
  SyntaxKind.EqualsEqualsEqualsToken,
  SyntaxKind.EqualsEqualsToken,
  SyntaxKind.ExclamationEqualsEqualsToken,
  SyntaxKind.ExclamationEqualsToken,
]);

const MAX_STRING_LITERAL = 64;
const MAX_MINED = 200;

function numericValue(node: Node): number | undefined {
  if (Node.isNumericLiteral(node)) {
    const v = node.getLiteralValue();
    const parent = node.getParent();
    if (
      parent &&
      Node.isPrefixUnaryExpression(parent) &&
      parent.getOperatorToken() === SyntaxKind.MinusToken
    ) {
      return -v;
    }
    return v;
  }
  if (Node.isPrefixUnaryExpression(node) && node.getOperatorToken() === SyntaxKind.MinusToken) {
    const operand = node.getOperand();
    if (Node.isNumericLiteral(operand)) return -operand.getLiteralValue();
  }
  return undefined;
}

function round(v: number): number {
  return Math.round(v * 1e9) / 1e9;
}

/** Mine literals from a set of nodes (both versions of a function and helpers it reaches). */
export function mineValues(nodes: Node[]): MinedValues {
  const literals = new Set<number>();
  const thresholds = new Set<number>();
  const strings = new Set<string>();
  const keys = new Set<string>();
  const regexes = new Map<string, MinedRegex>();

  for (const root of nodes) {
    root.forEachDescendant((node) => {
      if (Node.isNumericLiteral(node)) {
        const v = numericValue(node);
        if (v !== undefined && Number.isFinite(v)) literals.add(v);
      } else if (Node.isStringLiteral(node) || Node.isNoSubstitutionTemplateLiteral(node)) {
        // Skip import specifiers and property keys in object literals that are pure syntax.
        const parent = node.getParent();
        if (parent && (Node.isImportDeclaration(parent) || Node.isExportDeclaration(parent))) return;
        const v = node.getLiteralValue();
        if (v.length <= MAX_STRING_LITERAL) strings.add(v);
      } else if (Node.isRegularExpressionLiteral(node)) {
        const text = node.getText();
        const end = text.lastIndexOf('/');
        const r = { source: text.slice(1, end), flags: text.slice(end + 1) };
        if (r.source.length <= 400) regexes.set(text, r);
      } else if (Node.isNewExpression(node) && node.getExpression().getText() === 'RegExp') {
        const [src, fl] = node.getArguments();
        if (src && Node.isStringLiteral(src)) {
          const r = {
            source: src.getLiteralValue(),
            flags: fl && Node.isStringLiteral(fl) ? fl.getLiteralValue() : '',
          };
          if (r.source.length <= 400) regexes.set(`${r.source}/${r.flags}`, r);
        }
      } else if (Node.isPropertyAccessExpression(node)) {
        // Property names the code reads (`options.min`): keys for untyped objects.
        const name = node.getName();
        if (name.length <= 32 && !BUILTIN_MEMBERS.has(name)) keys.add(name);
      } else if (Node.isBindingElement(node)) {
        const prop = node.getPropertyNameNode()?.getText() ?? node.getName();
        if (/^[A-Za-z_$][\w$]*$/.test(prop) && prop.length <= 32) keys.add(prop);
      } else if (
        Node.isBinaryExpression(node) &&
        COMPARISON_OPERATORS.has(node.getOperatorToken().getKind())
      ) {
        for (const side of [node.getLeft(), node.getRight()]) {
          const v = numericValue(side);
          if (v !== undefined && Number.isFinite(v)) thresholds.add(v);
        }
      }
    });
  }

  const numbers = new Set<number>(NUMBER_BOUNDARIES);
  for (const v of [...literals, ...thresholds]) {
    for (const n of [v, -v, v + 1, v - 1, round(v + 0.01), round(v - 0.01), v * 10, v / 10]) {
      if (Number.isFinite(n)) numbers.add(n);
    }
  }
  for (const t of thresholds) {
    // The nearest representable doubles around a decision boundary.
    numbers.add(nextAfter(t, Infinity));
    numbers.add(nextAfter(t, -Infinity));
  }

  const strs = new Set<string>(STRING_BOUNDARIES);
  for (const s of strings) {
    for (const v of [s, ` ${s} `, s.toUpperCase(), s.toLowerCase(), s + s, s.slice(0, 1)]) strs.add(v);
  }

  return {
    numbers: [...numbers].slice(0, MAX_MINED),
    thresholds: [...thresholds].sort((a, b) => a - b),
    strings: [...strs].slice(0, MAX_MINED),
    keys: [...keys].slice(0, 40),
    fragments: [...strings].filter((x) => x.length > 0 && x.length <= 12).slice(0, 60),
    regexes: [...regexes.values()].slice(0, 20),
  };
}

/** Members of built-ins that say nothing about the shape of inputs. */
const BUILTIN_MEMBERS = new Set([
  'length',
  'push',
  'pop',
  'shift',
  'unshift',
  'slice',
  'splice',
  'map',
  'filter',
  'reduce',
  'forEach',
  'some',
  'every',
  'find',
  'findIndex',
  'includes',
  'indexOf',
  'join',
  'split',
  'replace',
  'replaceAll',
  'trim',
  'trimStart',
  'trimEnd',
  'toLowerCase',
  'toUpperCase',
  'startsWith',
  'endsWith',
  'charAt',
  'charCodeAt',
  'codePointAt',
  'substring',
  'substr',
  'concat',
  'match',
  'test',
  'exec',
  'keys',
  'values',
  'entries',
  'assign',
  'freeze',
  'isArray',
  'isInteger',
  'isNaN',
  'isFinite',
  'floor',
  'ceil',
  'round',
  'abs',
  'min',
  'max',
  'pow',
  'sqrt',
  'toString',
  'toFixed',
  'valueOf',
  'call',
  'apply',
  'bind',
  'prototype',
  'hasOwnProperty',
  'get',
  'set',
  'has',
  'add',
  'delete',
  'size',
  'then',
  'catch',
  'log',
  'normalize',
  'padStart',
  'padEnd',
  'repeat',
  'sort',
  'reverse',
  'flat',
  'flatMap',
  'fill',
  'from',
  'of',
  'parse',
  'stringify',
  'getTime',
  'now',
  'create',
  'defineProperty',
]);

/** Smallest double strictly after `x` in the direction of `toward`. */
export function nextAfter(x: number, toward: number): number {
  if (Number.isNaN(x) || Number.isNaN(toward)) return NaN;
  if (x === toward) return toward;
  if (x === 0) return toward > 0 ? Number.MIN_VALUE : -Number.MIN_VALUE;
  const buf = new DataView(new ArrayBuffer(8));
  buf.setFloat64(0, x);
  let bits = buf.getBigUint64(0);
  bits += toward > x === x > 0 ? 1n : -1n;
  buf.setBigUint64(0, bits);
  return buf.getFloat64(0);
}

export function emptyMined(): MinedValues {
  return {
    numbers: [...NUMBER_BOUNDARIES],
    thresholds: [],
    strings: [...STRING_BOUNDARIES],
    keys: [],
    fragments: [],
    regexes: [],
  };
}
