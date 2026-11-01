import { Node, SyntaxKind, type ParameterDeclaration } from 'ts-morph';

/**
 * Input domain inferred from the OLD version's guard clauses: the leading `if (cond) throw ...` /
 * `if (cond) return ...` statements of the function body. The conditions are evaluated by a tiny interpreter that
 * understands comparisons with literals, typeof, Number.isInteger/isNaN/isFinite/isSafeInteger, isNaN,
 * Array.isArray, `.length`, `!`, `&&`, `||`. Anything else evaluates to "unknown" and is ignored (never guessed).
 */
export interface Guards {
  /** Human-readable guard conditions that could be evaluated. */
  conditions: string[];
  /** True if the input passes every guard (or the guard cannot be evaluated for it). */
  accepts(input: unknown[]): boolean;
}

type Env = Map<string, unknown>;
const UNKNOWN = Symbol('unknown');
type Value = unknown;
type Expr = (env: Env) => Value;

function compile(node: Node, params: Set<string>): Expr | undefined {
  if (Node.isParenthesizedExpression(node)) return compile(node.getExpression(), params);
  if (Node.isNumericLiteral(node)) {
    const v = node.getLiteralValue();
    return () => v;
  }
  if (Node.isStringLiteral(node) || Node.isNoSubstitutionTemplateLiteral(node)) {
    const v = node.getLiteralValue();
    return () => v;
  }
  if (node.getKind() === SyntaxKind.TrueKeyword) return () => true;
  if (node.getKind() === SyntaxKind.FalseKeyword) return () => false;
  if (node.getKind() === SyntaxKind.NullKeyword) return () => null;
  if (Node.isIdentifier(node)) {
    const name = node.getText();
    if (name === 'undefined') return () => undefined;
    if (name === 'NaN') return () => NaN;
    if (name === 'Infinity') return () => Infinity;
    if (params.has(name)) return (env) => env.get(name);
    return undefined;
  }
  if (Node.isPropertyAccessExpression(node) && node.getName() === 'length') {
    const obj = compile(node.getExpression(), params);
    if (!obj) return undefined;
    return (env) => {
      const v = obj(env);
      return typeof v === 'string' || Array.isArray(v) ? v.length : UNKNOWN;
    };
  }
  if (Node.isTypeOfExpression(node)) {
    const e = compile(node.getExpression(), params);
    if (!e) return undefined;
    return (env) => {
      const v = e(env);
      return v === UNKNOWN ? UNKNOWN : v === null ? 'object' : typeof v;
    };
  }
  if (Node.isPrefixUnaryExpression(node)) {
    const e = compile(node.getOperand(), params);
    if (!e) return undefined;
    const op = node.getOperatorToken();
    if (op === SyntaxKind.ExclamationToken) return (env) => (e(env) === UNKNOWN ? UNKNOWN : !e(env));
    if (op === SyntaxKind.MinusToken)
      return (env) => (typeof e(env) === 'number' ? -(e(env) as number) : UNKNOWN);
    return undefined;
  }
  if (Node.isCallExpression(node)) {
    const callee = node.getExpression().getText().replace(/\s+/g, '');
    const fns: Record<string, (v: unknown) => boolean> = {
      'Number.isInteger': Number.isInteger,
      'Number.isSafeInteger': Number.isSafeInteger,
      'Number.isFinite': Number.isFinite,
      'Number.isNaN': Number.isNaN,
      isNaN: (v) => isNaN(v as number),
      isFinite: (v) => isFinite(v as number),
      'Array.isArray': Array.isArray,
    };
    const fn = fns[callee];
    const [arg] = node.getArguments();
    if (!fn || !arg || node.getArguments().length !== 1) return undefined;
    const e = compile(arg, params);
    if (!e) return undefined;
    return (env) => {
      const v = e(env);
      return v === UNKNOWN ? UNKNOWN : fn(v);
    };
  }
  if (Node.isBinaryExpression(node)) {
    const l = compile(node.getLeft(), params);
    const r = compile(node.getRight(), params);
    if (!l || !r) return undefined;
    const op = node.getOperatorToken().getKind();
    const cmp =
      (f: (a: never, b: never) => boolean): Expr =>
      (env) => {
        const a = l(env);
        const b = r(env);
        return a === UNKNOWN || b === UNKNOWN ? UNKNOWN : f(a as never, b as never);
      };
    switch (op) {
      case SyntaxKind.LessThanToken:
        return cmp((a, b) => a < b);
      case SyntaxKind.LessThanEqualsToken:
        return cmp((a, b) => a <= b);
      case SyntaxKind.GreaterThanToken:
        return cmp((a, b) => a > b);
      case SyntaxKind.GreaterThanEqualsToken:
        return cmp((a, b) => a >= b);
      case SyntaxKind.EqualsEqualsEqualsToken:
        return cmp((a, b) => a === b);
      case SyntaxKind.ExclamationEqualsEqualsToken:
        return cmp((a, b) => a !== b);
      case SyntaxKind.EqualsEqualsToken:
        return cmp((a, b) => a == b);
      case SyntaxKind.ExclamationEqualsToken:
        return cmp((a, b) => a != b);
      case SyntaxKind.AmpersandAmpersandToken:
        return (env) => {
          const a = l(env);
          if (a === UNKNOWN) return UNKNOWN;
          return a ? r(env) : a;
        };
      case SyntaxKind.BarBarToken:
        return (env) => {
          const a = l(env);
          if (a === UNKNOWN) return UNKNOWN;
          return a ? a : r(env);
        };
      default:
        return undefined;
    }
  }
  return undefined;
}

function isExit(stmt: Node): boolean {
  if (Node.isThrowStatement(stmt) || Node.isReturnStatement(stmt)) return true;
  if (Node.isBlock(stmt)) {
    const s = stmt.getStatements();
    return s.length >= 1 && isExit(s[s.length - 1]!);
  }
  return false;
}

/** Infer guards from a function-like node (the old version). Returns undefined when there are none. */
export function inferGuards(fn: Node): Guards | undefined {
  if (!(Node.isFunctionDeclaration(fn) || Node.isFunctionExpression(fn) || Node.isArrowFunction(fn)))
    return undefined;
  const body = fn.getBody();
  if (!body || !Node.isBlock(body)) return undefined;
  const paramDecls: ParameterDeclaration[] = fn.getParameters();
  const names = paramDecls.map((p) => (Node.isIdentifier(p.getNameNode()) ? p.getName() : undefined));
  const params = new Set(names.filter((n): n is string => !!n));
  const checks: { text: string; expr: Expr }[] = [];
  for (const stmt of body.getStatements()) {
    if (Node.isIfStatement(stmt) && !stmt.getElseStatement() && isExit(stmt.getThenStatement())) {
      const expr = compile(stmt.getExpression(), params);
      if (expr) checks.push({ text: stmt.getExpression().getText(), expr });
      continue;
    }
    // Assertion calls (`assertString(str)`) and variable declarations may precede guards; anything else ends them.
    if (Node.isExpressionStatement(stmt) && Node.isCallExpression(stmt.getExpression())) continue;
    if (Node.isVariableStatement(stmt) && checks.length === 0) continue;
    break;
  }
  if (checks.length === 0) return undefined;
  return {
    conditions: checks.map((c) => c.text),
    accepts(input) {
      const env: Env = new Map();
      names.forEach((n, i) => n && env.set(n, input[i]));
      return checks.every((c) => {
        try {
          const v = c.expr(env);
          return v === UNKNOWN || !v;
        } catch {
          return true;
        }
      });
    },
  };
}
