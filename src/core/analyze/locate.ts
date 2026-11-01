import { Node, SyntaxKind, type SourceFile, type VariableDeclaration } from 'ts-morph';
import type { FunctionLikeNode } from '../types/fromType.js';

export type LocateResult =
  | { ok: true; node: FunctionLikeNode | VariableDeclaration; declaration: Node; callable?: boolean }
  | { ok: false; reason: string; missing?: boolean };

function unwrapExpression(node: Node | undefined): Node | undefined {
  let cur = node;
  while (
    cur &&
    (Node.isParenthesizedExpression(cur) ||
      Node.isAsExpression(cur) ||
      Node.isSatisfiesExpression(cur) ||
      Node.isTypeAssertion(cur) ||
      Node.isNonNullExpression(cur))
  ) {
    cur = cur.getExpression();
  }
  return cur;
}

/** Resolve a declaration node to the function-like node that implements it, or a skip reason. */
export function asFunctionLike(decl: Node): LocateResult {
  if (Node.isFunctionDeclaration(decl)) {
    if (decl.isGenerator()) return { ok: false, reason: 'generator function' };
    if (decl.getOverloads().length > 0) return { ok: false, reason: 'overloaded function' };
    if (!decl.hasBody()) return { ok: false, reason: 'declaration without body' };
    return { ok: true, node: decl, declaration: decl };
  }
  if (Node.isVariableDeclaration(decl)) {
    const init = unwrapExpression(decl.getInitializer());
    if (init && (Node.isArrowFunction(init) || Node.isFunctionExpression(init))) {
      if (Node.isFunctionExpression(init) && init.isGenerator())
        return { ok: false, reason: 'generator function' };
      return { ok: true, node: init, declaration: decl };
    }
    // A value whose type is callable, e.g. `export const defu = createDefu()` or `export const f = memoize(g)`.
    try {
      const sigs = decl.getType().getCallSignatures();
      if (sigs.length === 1 && decl.getType().getConstructSignatures().length === 0) {
        return { ok: true, node: decl, declaration: decl, callable: true };
      }
      if (sigs.length > 1) return { ok: false, reason: 'callable value with overloaded signatures' };
    } catch {
      /* fall through */
    }
    return { ok: false, reason: 'not a function (exported value)' };
  }
  if (Node.isClassDeclaration(decl))
    return { ok: false, reason: 'class (class methods are out of scope in v1)' };
  if (
    Node.isInterfaceDeclaration(decl) ||
    Node.isTypeAliasDeclaration(decl) ||
    Node.isEnumDeclaration(decl)
  ) {
    return { ok: false, reason: 'type-only export' };
  }
  if (Node.isExportAssignment(decl)) {
    const expr = unwrapExpression(decl.getExpression());
    if (expr && (Node.isArrowFunction(expr) || Node.isFunctionExpression(expr))) {
      return { ok: true, node: expr, declaration: decl };
    }
    return { ok: false, reason: 'default export is not a function' };
  }
  if (Node.isArrowFunction(decl) || Node.isFunctionExpression(decl)) {
    return { ok: true, node: decl, declaration: decl };
  }
  return { ok: false, reason: `unsupported declaration kind (${decl.getKindName()})` };
}

/** Find an exported function by export name (follows re-exports). */
export function findExportedFunction(sf: SourceFile, exportName: string): LocateResult {
  const decls = sf.getExportedDeclarations().get(exportName);
  if (!decls || decls.length === 0)
    return { ok: false, reason: `no export named \`${exportName}\``, missing: true };
  const funcs = decls.filter((d) => !Node.isInterfaceDeclaration(d) && !Node.isTypeAliasDeclaration(d));
  if (funcs.length === 0) return { ok: false, reason: 'type-only export' };
  return asFunctionLike(funcs[0]!);
}

/** Uses of `this` or `arguments` inside a function body (not nested functions). */
export function usesThis(fn: FunctionLikeNode | VariableDeclaration): boolean {
  if (Node.isArrowFunction(fn) || Node.isVariableDeclaration(fn)) return false;
  return fn
    .getDescendantsOfKind(SyntaxKind.ThisKeyword)
    .some((t) => t.getFirstAncestor((a) => Node.isFunctionLikeDeclaration(a)) === fn);
}

/**
 * Top-level functions in the same file reachable from `fn` through identifier references,
 * up to `depth` hops. Used for literal mining (and for transitive impact in change detection).
 */
export function reachableLocalFunctions(fn: Node, depth: number): Node[] {
  const sf = fn.getSourceFile();
  const result = new Set<Node>();
  let frontier: Node[] = [fn];
  for (let d = 0; d < depth && frontier.length > 0; d++) {
    const next: Node[] = [];
    for (const node of frontier) {
      for (const id of node.getDescendantsOfKind(SyntaxKind.Identifier)) {
        const sym = id.getSymbol();
        for (const decl of sym?.getDeclarations() ?? []) {
          if (decl.getSourceFile() !== sf) continue;
          const loc = asFunctionLike(decl);
          if (!loc.ok || loc.node === fn || result.has(loc.node)) continue;
          // Only module-level declarations.
          if (loc.declaration.getFirstAncestor((a) => Node.isFunctionLikeDeclaration(a))) continue;
          result.add(loc.node);
          next.push(loc.node);
        }
      }
    }
    frontier = next;
  }
  return [...result];
}

/**
 * Declarations of module-level constants (in the same file) that `nodes` reference and that are not functions:
 * `const iso8601 = /^.../`, `const UNITS = { ms: 1, s: 1000 }`. Their literals describe the inputs the code expects.
 */
export function referencedModuleValues(nodes: Node[]): Node[] {
  const result = new Set<Node>();
  for (const node of nodes) {
    const sf = node.getSourceFile();
    for (const id of node.getDescendantsOfKind(SyntaxKind.Identifier)) {
      for (const decl of id.getSymbol()?.getDeclarations() ?? []) {
        if (decl.getSourceFile() !== sf || !Node.isVariableDeclaration(decl)) continue;
        if (decl.getFirstAncestor((a) => Node.isFunctionLikeDeclaration(a))) continue;
        const init = decl.getInitializer();
        if (!init || Node.isArrowFunction(init) || Node.isFunctionExpression(init) || result.has(decl))
          continue;
        if (init.getText().length > 20_000) continue;
        // The declaration, not the initializer: miners visit descendants, and a bare literal has none.
        result.add(decl);
      }
    }
  }
  return [...result];
}
