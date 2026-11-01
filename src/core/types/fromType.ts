import {
  Node,
  ts,
  type ArrowFunction,
  type FunctionDeclaration,
  type FunctionExpression,
  type ParameterDeclaration,
  type Type,
  type VariableDeclaration,
} from 'ts-morph';
import {
  BINARY_CTORS,
  type ArbSpec,
  type BinaryCtor,
  type ParamSpec,
  type PropSpec,
  type SignatureSpec,
} from './spec.js';

/** Function-like nodes we can test. */
export type FunctionLikeNode = FunctionDeclaration | ArrowFunction | FunctionExpression;

const MAX_UNION_OPTIONS = 64;
const MAX_PROPS = 40;

/** Built-in (lib.d.ts) types we know how to generate; everything else from the default lib is unsupported. */
const HANDLED_BUILTINS = new Set([
  'Date',
  'Map',
  'ReadonlyMap',
  'Set',
  'ReadonlySet',
  'Array',
  'ReadonlyArray',
]);

interface Ctx {
  /** Node used as location for resolving property types. */
  location: Node;
  /** Object type ids currently being expanded, mapped to the recursion id assigned (if referenced). */
  stack: Map<number, { id: string; referenced: boolean }>;
  nextId: { n: number };
}

function typeId(type: Type): number {
  return (type.compilerType as unknown as { id: number }).id;
}

function isFromDefaultLib(type: Type): boolean {
  const symbol = type.getSymbol() ?? type.getAliasSymbol();
  const decls = symbol?.getDeclarations() ?? [];
  if (decls.length === 0) return false;
  return decls.every((d) => {
    const sf = d.getSourceFile();
    return (
      sf.getProject().getProgram().compilerObject.isSourceFileDefaultLibrary(sf.compilerNode) ||
      /[\\/]typescript[\\/]lib[\\/]lib\./.test(sf.getFilePath())
    );
  });
}

function symbolName(type: Type): string | undefined {
  return type.getSymbol()?.getName();
}

/** Derive the ArbSpec for a TypeScript type. */
export function specFromType(type: Type, location: Node): ArbSpec {
  return fromType(type, { location, stack: new Map(), nextId: { n: 0 } });
}

function fromType(type: Type, ctx: Ctx): ArbSpec {
  const flags = type.getFlags();

  if (flags & ts.TypeFlags.Any || flags & ts.TypeFlags.Unknown) return { kind: 'anything' };
  if (flags & ts.TypeFlags.Never) return { kind: 'unsupported', reason: 'never' };
  if (flags & ts.TypeFlags.Void || flags & ts.TypeFlags.Undefined) return { kind: 'undefined' };
  if (flags & ts.TypeFlags.Null) return { kind: 'null' };
  if (type.isBoolean()) return { kind: 'boolean' };
  if (type.isBooleanLiteral()) return { kind: 'literal', value: type.getText() === 'true' };
  if (type.isStringLiteral() || type.isNumberLiteral()) {
    const v = type.getLiteralValue();
    if (typeof v === 'string' || typeof v === 'number') return { kind: 'literal', value: v };
  }
  if (flags & ts.TypeFlags.BigIntLiteral) {
    const v = (type.compilerType as ts.BigIntLiteralType).value;
    return { kind: 'bigintLiteral', value: `${v.negative ? '-' : ''}${v.base10Value}` };
  }
  if (type.isEnumLiteral()) {
    const v = type.getLiteralValue();
    if (typeof v === 'string' || typeof v === 'number') return { kind: 'literal', value: v };
  }
  if (flags & ts.TypeFlags.Number) return { kind: 'number' };
  if (flags & ts.TypeFlags.String) return { kind: 'string' };
  if (flags & ts.TypeFlags.TemplateLiteral) return { kind: 'string' };
  if (flags & ts.TypeFlags.BigInt) return { kind: 'bigint' };
  if (flags & ts.TypeFlags.ESSymbol || flags & ts.TypeFlags.UniqueESSymbol)
    return { kind: 'unsupported', reason: 'symbol' };

  if (type.isTypeParameter()) {
    const c = type.getConstraint();
    return c ? fromType(c, ctx) : { kind: 'anything' };
  }

  if (type.isUnion()) {
    const parts = type.getUnionTypes();
    if (parts.length > MAX_UNION_OPTIONS) {
      return { kind: 'union', options: parts.slice(0, MAX_UNION_OPTIONS).map((t) => fromType(t, ctx)) };
    }
    return simplifyUnion(parts.map((t) => fromType(t, ctx)));
  }

  if (type.isIntersection()) {
    // Branded primitives: `number & { __brand: 'Cents' }` -> number.
    const prim = type.getIntersectionTypes().find((t) => {
      const f = t.getFlags();
      return (
        f &
        (ts.TypeFlags.NumberLike |
          ts.TypeFlags.StringLike |
          ts.TypeFlags.BigIntLike |
          ts.TypeFlags.BooleanLike)
      );
    });
    if (prim) return fromType(prim, ctx);
    return objectSpec(type, ctx);
  }

  if (type.isObject()) return objectLike(type, ctx);

  if (flags & ts.TypeFlags.NonPrimitive) return { kind: 'anything' }; // `object`
  return { kind: 'unsupported', reason: `type \`${type.getText()}\`` };
}

function simplifyUnion(options: ArbSpec[]): ArbSpec {
  const seen = new Set<string>();
  const out: ArbSpec[] = [];
  for (const o of options.flatMap((o) => (o.kind === 'union' ? o.options : [o]))) {
    const key = JSON.stringify(o);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(o);
  }
  // `true | false` from e.g. `boolean | undefined` arrives as two literals.
  const hasTrue = out.some((o) => o.kind === 'literal' && o.value === true);
  const hasFalse = out.some((o) => o.kind === 'literal' && o.value === false);
  const merged =
    hasTrue && hasFalse
      ? [
          ...out.filter((o) => !(o.kind === 'literal' && typeof o.value === 'boolean')),
          { kind: 'boolean' } as ArbSpec,
        ]
      : out;
  return merged.length === 1 ? merged[0]! : { kind: 'union', options: merged };
}

function objectLike(type: Type, ctx: Ctx): ArbSpec {
  if (type.isArray() || type.isReadonlyArray?.()) {
    const el = type.getArrayElementType() ?? type.getTypeArguments()[0];
    return { kind: 'array', items: el ? fromType(el, ctx) : { kind: 'anything' } };
  }
  if (type.isTuple()) return tupleSpec(type, ctx);

  const callSigs = type.getCallSignatures();
  if (callSigs.length > 0 && type.getProperties().length === 0) {
    const ret = callSigs[0]!.getReturnType();
    const promised = unwrapPromise(ret);
    return {
      kind: 'function',
      returns: fromType(promised ?? ret, ctx),
      async: promised !== undefined,
    };
  }

  const name = symbolName(type);
  if (name && isFromDefaultLib(type)) {
    if (name === 'Date') return { kind: 'date' };
    if ((BINARY_CTORS as readonly string[]).includes(name))
      return { kind: 'binary', ctor: name as BinaryCtor };
    if (name === 'Map' || name === 'ReadonlyMap') {
      const [k, v] = type.getTypeArguments();
      return {
        kind: 'map',
        key: k ? fromType(k, ctx) : { kind: 'anything' },
        value: v ? fromType(v, ctx) : { kind: 'anything' },
      };
    }
    if (name === 'Set' || name === 'ReadonlySet') {
      const [t] = type.getTypeArguments();
      return { kind: 'set', items: t ? fromType(t, ctx) : { kind: 'anything' } };
    }
    // JSDoc `{Object}` (the global Object interface): any object.
    if (name === 'Object') return { kind: 'anything' };
    if (!HANDLED_BUILTINS.has(name) && name !== '__type' && name !== '__object') {
      return { kind: 'unsupported', reason: `built-in type \`${name}\`` };
    }
  }
  if (type.isClass() || isClassInstance(type)) {
    return { kind: 'unsupported', reason: `class instance \`${name ?? type.getText()}\`` };
  }
  return objectSpec(type, ctx);
}

function isClassInstance(type: Type): boolean {
  const decls = type.getSymbol()?.getDeclarations() ?? [];
  return decls.some((d) => Node.isClassDeclaration(d) || Node.isClassExpression(d));
}

function unwrapPromise(type: Type): Type | undefined {
  const name = symbolName(type);
  if ((name === 'Promise' || name === 'PromiseLike') && isFromDefaultLib(type)) {
    return type.getTypeArguments()[0];
  }
  return undefined;
}

function tupleSpec(type: Type, ctx: Ctx): ArbSpec {
  const target = (type.compilerType as ts.TypeReference).target as ts.TupleType | undefined;
  const elementFlags = target?.elementFlags ?? [];
  const elems = type.getTupleElements();
  const items: ArbSpec[] = [];
  let optionalFrom: number | undefined;
  let rest: ArbSpec | undefined;
  elems.forEach((el, i) => {
    const f = elementFlags[i] ?? ts.ElementFlags.Required;
    if (f & ts.ElementFlags.Rest || f & ts.ElementFlags.Variadic) {
      rest = fromType(el, ctx);
      return;
    }
    if (f & ts.ElementFlags.Optional && optionalFrom === undefined) optionalFrom = items.length;
    items.push(fromType(el, ctx));
  });
  const spec: ArbSpec = { kind: 'tuple', items };
  if (optionalFrom !== undefined) spec.optionalFrom = optionalFrom;
  if (rest) spec.rest = rest;
  return spec;
}

function objectSpec(type: Type, ctx: Ctx): ArbSpec {
  const id = typeId(type);
  const active = ctx.stack.get(id);
  if (active) {
    active.referenced = true;
    return { kind: 'ref', id: active.id };
  }
  const entry = { id: `T${ctx.nextId.n++}`, referenced: false };
  ctx.stack.set(id, entry);
  try {
    const checker = ctx.location.getProject().getTypeChecker();
    const props: PropSpec[] = [];
    for (const sym of type.getProperties().slice(0, MAX_PROPS)) {
      const propType = checker.getTypeOfSymbolAtLocation(sym, ctx.location);
      const optional = (sym.getFlags() & ts.SymbolFlags.Optional) !== 0;
      let spec = fromType(propType, ctx);
      // With strictNullChecks the optional prop type already includes undefined; drop it, `optional` covers it.
      if (optional && spec.kind === 'union') {
        const rest = spec.options.filter((o) => o.kind !== 'undefined');
        spec = rest.length === 1 ? rest[0]! : { kind: 'union', options: rest };
      }
      props.push({ name: sym.getName(), spec, optional });
    }
    const stringIndex = type.getStringIndexType();
    const numberIndex = type.getNumberIndexType();
    let result: ArbSpec;
    if (props.length === 0 && stringIndex) {
      result = { kind: 'record', key: 'string', values: fromType(stringIndex, ctx) };
    } else if (props.length === 0 && numberIndex) {
      result = { kind: 'record', key: 'number', values: fromType(numberIndex, ctx) };
    } else {
      result = { kind: 'object', props };
    }
    return entry.referenced ? { kind: 'recursive', id: entry.id, spec: result } : result;
  } finally {
    ctx.stack.delete(id);
  }
}

function paramSpec(p: ParameterDeclaration, location: Node, index: number): ParamSpec {
  const rest = p.isRestParameter();
  const optional = !rest && (p.isOptional() || p.hasInitializer() || p.hasQuestionToken());
  let type = p.getType();
  if (rest) {
    const el = type.getArrayElementType();
    type = el ?? type;
  }
  let spec = specFromType(type, location);
  if (optional && !rest) {
    // Make `undefined` an explicit option so omitted arguments are exercised.
    spec =
      spec.kind === 'union'
        ? spec.options.some((o) => o.kind === 'undefined')
          ? spec
          : { kind: 'union', options: [...spec.options, { kind: 'undefined' }] }
        : spec.kind === 'undefined'
          ? spec
          : { kind: 'union', options: [spec, { kind: 'undefined' }] };
  }
  const name = Node.isIdentifier(p.getNameNode()) ? p.getName() : `arg${index}`;
  return { name, spec, optional, rest };
}

/** Signature spec for a function-like node. Destructured parameters are named `argN`. */
export function signatureFromNode(fn: FunctionLikeNode): SignatureSpec {
  const params = fn
    .getParameters()
    .filter((p) => p.getName() !== 'this')
    .map((p, i) => paramSpec(p, fn, i));
  const ret = fn.getReturnType();
  const async = fn.isAsync() || unwrapPromise(ret) !== undefined;
  return { params, async };
}

/** Signature spec for a callable value (no function node), from its type's single call signature. */
export function signatureFromCallable(decl: VariableDeclaration): SignatureSpec {
  const sig = decl.getType().getCallSignatures()[0]!;
  const checker = decl.getProject().getTypeChecker();
  const params: ParamSpec[] = sig.getParameters().map((sym, i) => {
    const pdecl = sym.getValueDeclaration();
    const isParam = pdecl !== undefined && Node.isParameterDeclaration(pdecl);
    const rest = isParam && pdecl.isRestParameter();
    const optional =
      !rest &&
      ((sym.getFlags() & ts.SymbolFlags.Optional) !== 0 ||
        (isParam && (pdecl.isOptional() || pdecl.hasInitializer())));
    let type = checker.getTypeOfSymbolAtLocation(sym, decl);
    if (rest) type = type.getArrayElementType() ?? type;
    let spec = specFromType(type, decl);
    if (optional && spec.kind !== 'union') spec = { kind: 'union', options: [spec, { kind: 'undefined' }] };
    else if (optional && spec.kind === 'union' && !spec.options.some((o) => o.kind === 'undefined')) {
      spec = { kind: 'union', options: [...spec.options, { kind: 'undefined' }] };
    }
    return { name: sym.getName() || `arg${i}`, spec, optional, rest };
  });
  return { params, async: unwrapPromise(sig.getReturnType()) !== undefined };
}

/** Signature for whatever `locate` found: a function node or a callable value. */
export function signatureOf(node: FunctionLikeNode | VariableDeclaration): SignatureSpec {
  return Node.isVariableDeclaration(node) ? signatureFromCallable(node) : signatureFromNode(node);
}
