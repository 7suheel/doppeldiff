/**
 * Values that cannot cross the IPC boundary (functions) are sent as tagged descriptors and
 * materialized inside the runner.
 */
export const FN_TAG = '__doppeldiff_fn__';

export interface FnDescriptor {
  [FN_TAG]: { returns: unknown; async: boolean };
}

export function isFnDescriptor(v: unknown): v is FnDescriptor {
  return typeof v === 'object' && v !== null && Object.prototype.hasOwnProperty.call(v, FN_TAG);
}

/**
 * Objects with inherited enumerable properties cannot cross IPC (structured clone drops prototypes): they are sent
 * as `{ [PROTO_TAG]: { proto, own } }` and rebuilt in the runner as `Object.assign(Object.create(proto), own)`.
 */
export const PROTO_TAG = '__doppeldiff_proto__';

export interface ProtoDescriptor {
  [PROTO_TAG]: { proto: Record<string, unknown>; own: Record<string, unknown> };
}

export function isProtoDescriptor(v: unknown): v is ProtoDescriptor {
  return typeof v === 'object' && v !== null && Object.prototype.hasOwnProperty.call(v, PROTO_TAG);
}

/** Bytes of an ArrayBuffer or of the window of an ArrayBufferView. */
export function viewBytes(v: ArrayBuffer | ArrayBufferView): number[] {
  // `ArrayBuffer.isView` works across realms (values from the sandbox context); `instanceof` does not.
  return ArrayBuffer.isView(v)
    ? Array.from(new Uint8Array(v.buffer, v.byteOffset, v.byteLength))
    : Array.from(new Uint8Array(v));
}

/**
 * Typed arrays and DataViews cannot cross IPC faithfully: Node deserializes a view as a window into the whole
 * message buffer, so `view.buffer` would contain unrelated bytes that change from batch to batch. They are sent as
 * `{ [VIEW_TAG]: { ctor, buffer, byteOffset, length } }` (an ArrayBuffer crosses as an exact copy) and rebuilt.
 */
export const VIEW_TAG = '__doppeldiff_view__';

export interface ViewDescriptor {
  [VIEW_TAG]: { ctor: string; buffer: ArrayBuffer; byteOffset: number; length: number };
}

export function isViewDescriptor(v: unknown): v is ViewDescriptor {
  return typeof v === 'object' && v !== null && Object.prototype.hasOwnProperty.call(v, VIEW_TAG);
}

/** Prepare an input for IPC: replace typed arrays and DataViews (at any depth) with view descriptors. */
export function toWire(value: unknown, depth = 0): unknown {
  if (typeof value !== 'object' || value === null || depth > 32) return value;
  if (ArrayBuffer.isView(value)) {
    const v = value as ArrayBufferView & { length?: number };
    return {
      [VIEW_TAG]: {
        ctor: v.constructor.name,
        buffer: (v.buffer as ArrayBuffer).slice(0),
        byteOffset: v.byteOffset,
        length: v instanceof DataView ? v.byteLength : (v.length ?? 0),
      },
    } satisfies ViewDescriptor;
  }
  if (Array.isArray(value)) return value.map((x) => toWire(x, depth + 1));
  if (value instanceof Map)
    return new Map([...value].map(([k, x]) => [toWire(k, depth + 1), toWire(x, depth + 1)]));
  if (value instanceof Set) return new Set([...value].map((x) => toWire(x, depth + 1)));
  if (Object.getPrototypeOf(value) !== Object.prototype) return value;
  const out: Record<string, unknown> = {};
  for (const [k, x] of Object.entries(value)) out[k] = toWire(x, depth + 1);
  return out;
}
