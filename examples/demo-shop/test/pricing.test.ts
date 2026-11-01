import { describe, expect, it } from 'vitest';
import { applyDiscount, applyTax, bulkPrice } from '../src/pricing';

describe('applyDiscount', () => {
  it('applies a percentage discount', () => {
    expect(applyDiscount(100, 0.15)).toBe(85);
    expect(applyDiscount(19.99, 0.1)).toBe(17.99);
  });
  it('rejects invalid input', () => {
    expect(() => applyDiscount(-1, 0.1)).toThrow(RangeError);
    expect(() => applyDiscount(10, 1.5)).toThrow(RangeError);
  });
});

describe('applyTax', () => {
  it('adds regional tax', () => {
    expect(applyTax(100, 'US')).toBe(107);
    expect(applyTax(100, 'EU')).toBe(120);
    expect(applyTax(100, 'NONE')).toBe(100);
  });
});

describe('bulkPrice', () => {
  it('applies volume discounts', () => {
    expect(bulkPrice(2, 5)).toBe(10);
    expect(bulkPrice(2, 10)).toBe(19);
    expect(bulkPrice(2, 100)).toBe(180);
  });
});
