import { roundMoney } from './money';

export interface CartItem {
  sku: string;
  unitPrice: number;
  quantity: number;
}

export interface Coupon {
  code: string;
  amountOff: number;
  minimumSpend: number;
}

/** Total of a cart in currency units, after an optional fixed-amount coupon. */
export function cartTotal(items: CartItem[], coupon?: Coupon): number {
  let subtotal = 0;
  for (const item of items) {
    if (item.quantity <= 0) continue;
    subtotal += item.unitPrice * item.quantity;
  }
  if (coupon && subtotal >= coupon.minimumSpend) {
    subtotal = subtotal - Math.min(coupon.amountOff, subtotal);
  }
  return roundMoney(subtotal);
}

/** Number of units in the cart. */
export function itemCount(items: CartItem[]): number {
  let count = 0;
  for (const item of items) {
    count += item.quantity;
  }
  return count;
}
