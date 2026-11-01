import type { ArbSpec, SignatureSpec } from './spec.js';

/**
 * Conservative check that every value described by `head` is also a valid value for `base`,
 * so inputs generated from the head signature are legal for the base version.
 */
export function accepts(base: ArbSpec, head: ArbSpec): boolean {
  if (base.kind === 'anything') return true;
  if (head.kind === 'union') return head.options.every((o) => accepts(base, o));
  if (base.kind === 'union') return base.options.some((o) => accepts(o, head));
  if (JSON.stringify(base) === JSON.stringify(head)) return true;
  if (head.kind === 'literal') {
    return (
      (base.kind === 'number' && typeof head.value === 'number') ||
      (base.kind === 'string' && typeof head.value === 'string') ||
      (base.kind === 'boolean' && typeof head.value === 'boolean')
    );
  }
  if (head.kind === 'bigintLiteral') return base.kind === 'bigint';
  if (base.kind !== head.kind) return false;
  switch (base.kind) {
    case 'array':
      return accepts(base.items, (head as typeof base).items);
    case 'set':
      return accepts(base.items, (head as typeof base).items);
    case 'map': {
      const h = head as typeof base;
      return accepts(base.key, h.key) && accepts(base.value, h.value);
    }
    case 'record':
      return accepts(base.values, (head as typeof base).values);
    case 'tuple': {
      const h = head as typeof base;
      if (h.items.length < (base.optionalFrom ?? base.items.length)) return false;
      return h.items.every((it, i) => {
        const b = base.items[i] ?? base.rest;
        return b !== undefined && accepts(b, it);
      });
    }
    case 'object': {
      const h = head as typeof base;
      return base.props.every((bp) => {
        const hp = h.props.find((p) => p.name === bp.name);
        if (!hp) return bp.optional;
        if (hp.optional && !bp.optional) return false;
        return accepts(bp.spec, hp.spec);
      });
    }
    case 'function':
      return accepts(base.returns, (head as typeof base).returns);
    default:
      return true;
  }
}

export function signatureAccepts(base: SignatureSpec, head: SignatureSpec): boolean {
  const baseRest = base.params.find((p) => p.rest);
  const headFixed = head.params.filter((p) => !p.rest);
  for (let i = 0; i < headFixed.length; i++) {
    const hp = headFixed[i]!;
    const bp = base.params[i] && !base.params[i]!.rest ? base.params[i] : baseRest;
    if (!bp) {
      // Extra head parameter: only fine if the base ignores it, i.e. it is optional in head.
      if (!hp.optional) return false;
      continue;
    }
    if (!accepts(bp.spec, hp.spec)) return false;
  }
  // Base parameters that head does not pass must be optional.
  for (let i = headFixed.length; i < base.params.length; i++) {
    const bp = base.params[i]!;
    if (!bp.optional && !bp.rest) return false;
  }
  const headRest = head.params.find((p) => p.rest);
  if (headRest) {
    const target = baseRest ?? undefined;
    if (!target || !accepts(target.spec, headRest.spec)) return false;
  }
  return true;
}
