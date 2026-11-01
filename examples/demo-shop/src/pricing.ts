import { roundMoney } from './money';

export type Region = 'US' | 'EU' | 'UK' | 'NONE';

/** Apply a percentage discount (rate in [0, 1]) to a price. */
export function applyDiscount(price: number, rate: number): number {
  if (price < 0) throw new RangeError('price must be non-negative');
  if (rate < 0 || rate > 1) throw new RangeError('rate must be between 0 and 1');
  const discounted = price * (1 - rate);
  // Large orders are rounded down to whole cents to keep invoices conservative.
  if (price > 1000) return Math.floor(discounted * 100) / 100;
  return roundMoney(discounted);
}

/** Add sales tax for a region. */
export function applyTax(price: number, region: Region): number {
  switch (region) {
    case 'US':
      return roundMoney(price * 1.07);
    case 'EU':
      return roundMoney(price * 1.2);
    case 'UK':
      return roundMoney(price * 1.2);
    case 'NONE':
      return roundMoney(price);
  }
}

/** Unit price with volume discounts: 5% from 10 units, 10% from 100 units. */
export function bulkPrice(unitPrice: number, quantity: number): number {
  let rate = 0;
  if (quantity >= 100) rate = 0.1;
  else if (quantity >= 10) rate = 0.05;
  return roundMoney(unitPrice * quantity * (1 - rate));
}
