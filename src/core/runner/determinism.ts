import type * as NodeCrypto from 'node:crypto';
import { createRequire, syncBuiltinESMExports } from 'node:module';

/**
 * Deterministic environment for code under test: a frozen clock and seeded randomness.
 * Installed once in the runner before user code loads; `reset()` is called before every call so that
 * both versions observe exactly the same time and random sequence for the same input.
 */
export interface Determinism {
  reset(): void;
}

/** sfc32: small, fast, seedable PRNG. */
function sfc32(a: number, b: number, c: number, d: number): () => number {
  return () => {
    a |= 0;
    b |= 0;
    c |= 0;
    d |= 0;
    const t = (((a + b) | 0) + d) | 0;
    d = (d + 1) | 0;
    a = b ^ (b >>> 9);
    b = (c + (c << 3)) | 0;
    c = (c << 21) | (c >>> 11);
    c = (c + t) | 0;
    return (t >>> 0) / 4294967296;
  };
}

export function installDeterminism(options: { now: number; seed: number }): Determinism {
  const require = createRequire(import.meta.url);
  const RealDate = Date;
  const now = options.now;
  let rand = sfc32(options.seed, 0x9e3779b9, 0x243f6a88, 0xb7e15162);

  function FakeDate(this: unknown, ...args: unknown[]): unknown {
    if (!new.target) return new RealDate(now).toString();
    if (args.length === 0) return new RealDate(now);
    return new (RealDate as unknown as new (...a: unknown[]) => Date)(...args);
  }
  FakeDate.prototype = RealDate.prototype;
  FakeDate.now = () => now;
  FakeDate.parse = RealDate.parse;
  FakeDate.UTC = RealDate.UTC;
  Object.defineProperty(FakeDate, 'name', { value: 'Date' });
  globalThis.Date = FakeDate as unknown as DateConstructor;

  Math.random = () => rand();

  const fillRandom = <T extends ArrayBufferView | null>(view: T): T => {
    if (view) {
      const bytes = new Uint8Array(view.buffer, view.byteOffset, view.byteLength);
      for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(rand() * 256);
    }
    return view;
  };
  const uuid = (): `${string}-${string}-${string}-${string}-${string}` => {
    const b = fillRandom(new Uint8Array(16));
    b[6] = (b[6]! & 0x0f) | 0x40;
    b[8] = (b[8]! & 0x3f) | 0x80;
    const h = Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
    return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
  };

  const nodeCrypto = require('node:crypto') as typeof NodeCrypto;
  const webcrypto = globalThis.crypto;
  try {
    Object.defineProperty(webcrypto, 'getRandomValues', {
      value: fillRandom,
      configurable: true,
      writable: true,
    });
    Object.defineProperty(webcrypto, 'randomUUID', { value: uuid, configurable: true, writable: true });
  } catch {
    /* non-configurable in some versions; ignore */
  }
  const set = (target: object, key: string, value: unknown) => {
    try {
      Object.defineProperty(target, key, { value, configurable: true, writable: true, enumerable: true });
    } catch {
      /* non-configurable: leave as is */
    }
  };
  set(nodeCrypto, 'randomUUID', uuid);
  set(nodeCrypto, 'getRandomValues', fillRandom);
  set(nodeCrypto, 'randomBytes', (size: number, cb?: (err: Error | null, buf: Buffer) => void) => {
    const buf = fillRandom(Buffer.alloc(size));
    if (cb) {
      queueMicrotask(() => cb(null, buf));
      return undefined;
    }
    return buf;
  });
  set(nodeCrypto, 'randomInt', (min: number, max?: number) => {
    const [lo, hi] = max === undefined ? [0, min] : [min, max];
    return lo + Math.floor(rand() * (hi - lo));
  });
  syncBuiltinESMExports();

  return {
    reset() {
      rand = sfc32(options.seed, 0x9e3779b9, 0x243f6a88, 0xb7e15162);
    },
  };
}
