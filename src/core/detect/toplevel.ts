import { Node, SyntaxKind, ts, type SourceFile } from 'ts-morph';

/** A module-level runtime binding: function, variable, class, enum, import or default export. */
export interface TopLevel {
  name: string;
  kind: 'function' | 'variable' | 'class' | 'enum' | 'import' | 'default';
  /** The declaration node (for imports: the import specifier/clause). */
  node: Node;
  /** Normalized source text (comments and formatting removed). */
  normalized: string;
  /** Raw source text. */
  raw: string;
}

export interface ModuleIndex {
  sf: SourceFile;
  decls: Map<string, TopLevel>;
  /** Normalized text of top-level statements that are not declarations (module side effects). */
  sideEffects: string[];
  /** Export name → top-level name declared in this file (re-exports from other files excluded). */
  exports: Map<string, string>;
}

/**
 * Normalized text of a node: its leaf tokens joined by single spaces. Comments, JSDoc and whitespace are
 * dropped and string literals are compared by value, so formatting-only edits normalize to the same text.
 */
export function normalize(node: Node): string {
  const sf = node.getSourceFile().compilerNode;
  const out: string[] = [];
  const walk = (n: ts.Node) => {
    if (ts.isJSDoc(n) || n.kind === ts.SyntaxKind.JSDocComment) return;
    const children = n.getChildren(sf);
    if (children.length === 0) {
      if (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) out.push(JSON.stringify(n.text));
      else if (n.kind !== ts.SyntaxKind.EndOfFileToken) out.push(n.getText(sf));
      return;
    }
    for (const c of children) walk(c);
  };
  walk(node.compilerNode);
  return out.join(' ');
}

function topLevelNameOf(decl: Node): string | undefined {
  if (Node.isFunctionDeclaration(decl) || Node.isClassDeclaration(decl) || Node.isEnumDeclaration(decl)) {
    return decl.getName() ?? 'default';
  }
  if (Node.isVariableDeclaration(decl)) return decl.getName();
  if (Node.isExportAssignment(decl)) return 'default';
  return undefined;
}

/** Index all top-level runtime bindings of a module. */
export function indexModule(sf: SourceFile): ModuleIndex {
  const decls = new Map<string, TopLevel>();
  const sideEffects: string[] = [];
  const cjsExports = new Map<string, string>();
  const cjsStatements: Node[] = [];
  const add = (name: string, kind: TopLevel['kind'], node: Node, printed: Node = node) =>
    decls.set(name, { name, kind, node, normalized: normalize(printed), raw: printed.getText() });

  for (const st of sf.getStatements()) {
    if (Node.isFunctionDeclaration(st)) {
      const name = st.getName() ?? 'default';
      // Overloads: keep the implementation, but include all signatures in the normalized text.
      const prev = decls.get(name);
      add(name, 'function', st);
      if (prev && prev.kind === 'function') {
        const cur = decls.get(name)!;
        cur.normalized = prev.normalized + cur.normalized;
        cur.raw = prev.raw + cur.raw;
      }
    } else if (Node.isVariableStatement(st)) {
      for (const d of st.getDeclarations()) {
        const nameNode = d.getNameNode();
        if (Node.isIdentifier(nameNode)) {
          add(d.getName(), 'variable', d);
        } else {
          for (const id of nameNode.getDescendantsOfKind(SyntaxKind.Identifier))
            add(id.getText(), 'variable', d);
        }
      }
    } else if (Node.isClassDeclaration(st)) {
      add(st.getName() ?? 'default', 'class', st);
    } else if (Node.isEnumDeclaration(st)) {
      add(st.getName(), 'enum', st);
    } else if (Node.isImportDeclaration(st)) {
      if (st.isTypeOnly()) continue;
      const spec = st.getModuleSpecifierValue();
      const def = st.getDefaultImport();
      if (def)
        decls.set(def.getText(), {
          name: def.getText(),
          kind: 'import',
          node: st,
          normalized: `import default from ${spec}`,
          raw: `default from ${spec}`,
        });
      const ns = st.getNamespaceImport();
      if (ns)
        decls.set(ns.getText(), {
          name: ns.getText(),
          kind: 'import',
          node: st,
          normalized: `import * from ${spec}`,
          raw: `* from ${spec}`,
        });
      for (const n of st.getNamedImports()) {
        if (n.isTypeOnly()) continue;
        const local = n.getAliasNode()?.getText() ?? n.getName();
        decls.set(local, {
          name: local,
          kind: 'import',
          node: n,
          normalized: `import ${n.getName()} from ${spec}`,
          raw: `${n.getName()} from ${spec}`,
        });
      }
    } else if (Node.isExportAssignment(st)) {
      add('default', 'default', st);
    } else if (isCjsExport(st)) {
      // Handled after the loop: `module.exports = parse` may precede the (hoisted) `function parse`.
      cjsStatements.push(st);
      continue;
    } else if (
      Node.isInterfaceDeclaration(st) ||
      Node.isTypeAliasDeclaration(st) ||
      Node.isExportDeclaration(st) ||
      Node.isModuleDeclaration(st) ||
      Node.isEmptyStatement(st)
    ) {
      continue;
    } else {
      sideEffects.push(normalize(st));
    }
  }

  for (const st of cjsStatements) cjsExport(st, decls, cjsExports, add);

  const exports = new Map<string, string>(cjsExports);
  for (const [exportName, ds] of sf.getExportedDeclarations()) {
    for (const d of ds) {
      if (d.getSourceFile() !== sf) continue;
      const top = topLevelNameOf(d);
      if (top && decls.has(top)) {
        exports.set(exportName, top);
        break;
      }
    }
  }
  return { sf, decls, sideEffects, exports };
}

function isCjsExport(st: Node): boolean {
  if (!Node.isExpressionStatement(st)) return false;
  const expr = st.getExpression();
  return (
    Node.isBinaryExpression(expr) &&
    expr.getOperatorToken().getKind() === SyntaxKind.EqualsToken &&
    cjsTarget(expr.getLeft()) !== undefined
  );
}

/** `module.exports` / `exports` target of an assignment's left side: undefined, '' (whole object) or a name. */
function cjsTarget(left: Node): string | undefined {
  const text = left.getText().replace(/\s+/g, '');
  if (text === 'module.exports') return '';
  const m =
    /^(?:module\.)?exports\.([A-Za-z_$][\w$]*)$/.exec(text) ??
    /^(?:module\.)?exports\[['"]([^'"]+)['"]\]$/.exec(text);
  return m ? m[1] : undefined;
}

/**
 * Recognize CommonJS export statements. Functions defined inline become synthetic top-level bindings
 * named `exports.<name>` so they can be compared and tested like ESM exports.
 */
function cjsExport(
  st: Node,
  decls: Map<string, TopLevel>,
  exportsMap: Map<string, string>,
  add: (name: string, kind: TopLevel['kind'], node: Node, printed?: Node) => void,
): boolean {
  if (!Node.isExpressionStatement(st)) return false;
  const expr = st.getExpression();
  if (!Node.isBinaryExpression(expr) || expr.getOperatorToken().getKind() !== SyntaxKind.EqualsToken)
    return false;
  const target = cjsTarget(expr.getLeft());
  if (target === undefined) return false;
  const bind = (exportName: string, value: Node) => {
    if (Node.isIdentifier(value) && decls.has(value.getText())) {
      exportsMap.set(exportName, value.getText());
      return;
    }
    const synthetic = `exports.${exportName}`;
    const isFn = Node.isArrowFunction(value) || Node.isFunctionExpression(value);
    add(synthetic, isFn ? 'function' : 'variable', value);
    exportsMap.set(exportName, synthetic);
  };
  const rhs = expr.getRight();
  if (target !== '') {
    bind(target, rhs);
    return true;
  }
  if (Node.isObjectLiteralExpression(rhs)) {
    for (const prop of rhs.getProperties()) {
      if (Node.isShorthandPropertyAssignment(prop)) bind(prop.getName(), prop.getNameNode());
      else if (Node.isPropertyAssignment(prop))
        bind(prop.getName().replace(/^['"]|['"]$/g, ''), prop.getInitializerOrThrow());
      else if (Node.isMethodDeclaration(prop)) {
        add(`exports.${prop.getName()}`, 'variable', prop);
        exportsMap.set(prop.getName(), `exports.${prop.getName()}`);
      }
    }
    return true;
  }
  bind('default', rhs);
  return true;
}

/** Names whose normalized declaration differs between two module versions (including added/removed). */
export function changedTopLevel(base: ModuleIndex | undefined, head: ModuleIndex | undefined): Set<string> {
  const changed = new Set<string>();
  const names = new Set([...(base?.decls.keys() ?? []), ...(head?.decls.keys() ?? [])]);
  for (const n of names) {
    const a = base?.decls.get(n);
    const b = head?.decls.get(n);
    if (!a || !b || a.normalized !== b.normalized) changed.add(n);
  }
  return changed;
}

export interface Reach {
  /** Top-level names of this module reachable from the start node, with the path that reached them. */
  local: Map<string, string[]>;
  /** Imported bindings reachable: local name → resolved declaration (file + top-level name). */
  imported: Map<string, { file: string; name: string; via: string[] }>;
}

/** References from a node to module-level bindings, followed transitively up to `depth` hops. */
export function reach(index: ModuleIndex, start: Node, depth: number): Reach {
  const local = new Map<string, string[]>();
  const imported = new Map<string, { file: string; name: string; via: string[] }>();
  let frontier: { node: Node; path: string[] }[] = [{ node: start, path: [] }];
  for (let d = 0; d < depth && frontier.length > 0; d++) {
    const next: { node: Node; path: string[] }[] = [];
    for (const { node, path } of frontier) {
      for (const id of node.getDescendantsOfKind(SyntaxKind.Identifier)) {
        const name = id.getText();
        const top = index.decls.get(name);
        if (!top || local.has(name) || top.node === start) continue;
        // Make sure the identifier really refers to the module-level binding (not a shadowing local).
        const sym = id.getSymbol();
        const decls = sym?.getDeclarations() ?? [];
        if (sym && !decls.some((dn) => isWithin(dn, top.node))) continue;
        if (top.kind === 'import') {
          const aliased = sym?.isAlias() ? sym.getAliasedSymbol() : undefined;
          for (const ad of aliased?.getDeclarations() ?? []) {
            const target = topLevelNameOf(ad);
            if (target)
              imported.set(name, {
                file: ad.getSourceFile().getFilePath(),
                name: target,
                via: [...path, name],
              });
          }
          local.set(name, [...path, name]);
          continue;
        }
        local.set(name, [...path, name]);
        next.push({ node: top.node, path: [...path, name] });
      }
    }
    frontier = next;
  }
  return { local, imported };
}

function isWithin(node: Node, ancestor: Node): boolean {
  for (let cur: Node | undefined = node; cur; cur = cur.getParent()) if (cur === ancestor) return true;
  return false;
}
