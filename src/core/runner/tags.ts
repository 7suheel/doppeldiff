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
