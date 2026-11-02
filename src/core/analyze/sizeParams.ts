import { Node, SyntaxKind } from 'ts-morph';

/**
 * Size-like parameters: counts, lengths, indexes and loop bounds. Code that loops `n` times or allocates `n`
 * elements is slow (or hangs) for n = 1e15, which says nothing about its behavior; such parameters are generated
 * mostly in realistic ranges (see `sizeArb` in compile.ts), with huge values only as rare edge cases.
 *
 * A parameter is size-like when the code uses it as one, in either version:
 *   - loop bound: `i < n` / `n > i` in a `for` or `while` condition
 *   - length or count: `new Array(n)`, `Array(n)`, `{ length: n }`, `s.repeat(n)`, `padStart(n)`, `padEnd(n)`
 *   - index: `xs[n]`, `xs.at(n)`, `slice(…n…)`, `substring(…)`, `splice(n, …)`
 * or when its name says so (`count`, `size`, `length`, `index`, `limit`, `times`, `pageSize`, …).
 */
const SIZE_NAME =
  /^(n|k|count|size|length|len|times|limit|index|idx|width|height|depth|pages?|parts|chunks?|rows|cols|columns|steps|retries|attempts|digits|places|precision|decimals|people|items|level|levels)$|(Count|Size|Length|Index|Limit|Width|Height|Depth|Times)$/;

const LENGTH_CALLS = new Set([
  'repeat',
  'padStart',
  'padEnd',
  'at',
  'slice',
  'substring',
  'substr',
  'splice',
]);

function isLoopCondition(node: Node): boolean {
  for (let p: Node | undefined = node.getParent(); p; p = p.getParent()) {
    if (Node.isForStatement(p)) return p.getCondition() !== undefined && isWithin(node, p.getCondition()!);
    if (Node.isWhileStatement(p) || Node.isDoStatement(p)) return isWithin(node, p.getExpression());
    if (Node.isBlock(p) || Node.isFunctionLikeDeclaration(p)) return false;
  }
  return false;
}

function isWithin(node: Node, container: Node): boolean {
  return node.getPos() >= container.getPos() && node.getEnd() <= container.getEnd();
}

function usedAsSize(id: Node): boolean {
  const parent = id.getParent();
  if (!parent) return false;
  if (Node.isBinaryExpression(parent)) {
    const op = parent.getOperatorToken().getKind();
    const comparison =
      op === SyntaxKind.LessThanToken ||
      op === SyntaxKind.LessThanEqualsToken ||
      op === SyntaxKind.GreaterThanToken ||
      op === SyntaxKind.GreaterThanEqualsToken;
    if (comparison && isLoopCondition(parent)) return true;
  }
  if (Node.isElementAccessExpression(parent) && parent.getArgumentExpression() === id) return true;
  if (Node.isPropertyAssignment(parent) && parent.getName() === 'length' && parent.getInitializer() === id)
    return true;
  if (Node.isShorthandPropertyAssignment(parent) && parent.getName() === 'length') return true;
  if ((Node.isCallExpression(parent) || Node.isNewExpression(parent)) && parent.getArguments().includes(id)) {
    const callee = parent.getExpression();
    const name = Node.isPropertyAccessExpression(callee) ? callee.getName() : callee.getText();
    if (name === 'Array' || LENGTH_CALLS.has(name)) return true;
  }
  return false;
}

/** Names of size-like parameters of `fns` (both versions of a function). Only plain identifier parameters. */
export function sizeLikeParams(fns: Node[]): Set<string> {
  const out = new Set<string>();
  for (const fn of fns) {
    if (!(Node.isFunctionDeclaration(fn) || Node.isFunctionExpression(fn) || Node.isArrowFunction(fn)))
      continue;
    const params = fn
      .getParameters()
      .map((p) => p.getNameNode())
      .filter((n) => Node.isIdentifier(n))
      .map((n) => n.getText());
    for (const name of params) {
      if (SIZE_NAME.test(name)) {
        out.add(name);
        continue;
      }
      const body = fn.getBody();
      if (!body) continue;
      const refs = body
        .getDescendantsOfKind(SyntaxKind.Identifier)
        .filter((id) => id.getText() === name)
        .filter((id) => {
          const p = id.getParent();
          return !(Node.isPropertyAccessExpression(p) && p.getNameNode() === id);
        });
      if (refs.some(usedAsSize)) out.add(name);
    }
  }
  return out;
}
