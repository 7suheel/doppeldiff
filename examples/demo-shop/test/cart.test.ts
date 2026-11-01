import { describe, expect, it } from 'vitest';
import { cartTotal, itemCount } from '../src/cart';

const items = [
  { sku: 'TEE-0001-M', unitPrice: 19.99, quantity: 2 },
  { sku: 'SHOE-0042', unitPrice: 89.5, quantity: 1 },
];

describe('cartTotal', () => {
  it('sums line items', () => {
    expect(cartTotal(items)).toBe(129.48);
  });
  it('applies a coupon above the minimum spend', () => {
    expect(cartTotal(items, { code: 'TEN', amountOff: 10, minimumSpend: 50 })).toBe(119.48);
    expect(cartTotal(items, { code: 'BIG', amountOff: 10, minimumSpend: 500 })).toBe(129.48);
  });
  it('handles an empty cart', () => {
    expect(cartTotal([])).toBe(0);
  });
});

describe('itemCount', () => {
  it('counts units', () => {
    expect(itemCount(items)).toBe(3);
  });
});
