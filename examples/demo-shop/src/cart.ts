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
export const cartTotal = (items: CartItem[], coupon?: Coupon): number => {
  const subtotal = items.reduce((sum, { unitPrice, quantity }) => sum + unitPrice * Math.max(quantity, 0), 0);
  const discount = coupon && subtotal >= coupon.minimumSpend ? coupon.amountOff : 0;
  return roundMoney(Math.max(subtotal - discount, 0));
};

/** Number of units in the cart. */
export const itemCount = (items: CartItem[]): number => items.reduce((count, { quantity }) => count + quantity, 0);
