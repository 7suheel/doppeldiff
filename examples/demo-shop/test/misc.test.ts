import { describe, expect, it } from 'vitest';
import { addBusinessDays, formatDate } from '../src/dates';
import { formatPrice } from '../src/money';
import { parseSku } from '../src/sku';
import { slugify } from '../src/slug';

describe('formatPrice', () => {
  it('formats with grouping and currency', () => {
    expect(formatPrice(1234.5)).toBe('$1,234.50');
    expect(formatPrice(-3, 'EUR')).toBe('-€3.00');
    expect(formatPrice(1500, 'JPY')).toBe('¥1,500');
  });
});

describe('parseSku', () => {
  it('parses valid SKUs', () => {
    expect(parseSku('SHOE-0042')).toEqual({ category: 'SHOE', id: 42 });
    expect(parseSku('tee-0007-xl')).toEqual({ category: 'TEE', id: 7, size: 'XL' });
  });
  it('rejects invalid SKUs', () => {
    expect(parseSku('nope')).toBeNull();
    expect(parseSku('TEE-7')).toBeNull();
  });
});

describe('slugify', () => {
  it('creates URL slugs', () => {
    expect(slugify('Hello World')).toBe('hello-world');
    expect(slugify('Summer Sale 2025')).toBe('summer-sale-2025');
  });
});

describe('dates', () => {
  it('adds business days', () => {
    // 2025-01-17 is a Friday.
    expect(formatDate(addBusinessDays(new Date('2025-01-17T00:00:00Z'), 1))).toBe('2025-01-20');
    expect(formatDate(addBusinessDays(new Date('2025-01-20T00:00:00Z'), -1))).toBe('2025-01-17');
  });
});
