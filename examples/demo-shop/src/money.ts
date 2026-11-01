export type Currency = 'USD' | 'EUR' | 'GBP' | 'JPY';

const SYMBOLS: Record<Currency, string> = { USD: '$', EUR: '€', GBP: '£', JPY: '¥' };

/** Round an amount to whole cents (half away from zero is not guaranteed; this mirrors Math.round). */
export function roundMoney(amount: number): number {
  return Math.round(amount * 100) / 100;
}

/** Format an amount for display, e.g. formatPrice(1234.5) === "$1,234.50". */
export function formatPrice(amount: number, currency: Currency = 'USD'): string {
  const digits = currency === 'JPY' ? 0 : 2;
  const fixed = Math.abs(amount).toFixed(digits);
  const [whole, fraction] = fixed.split('.');
  const grouped = whole!.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  const sign = amount < 0 ? '-' : '';
  return sign + SYMBOLS[currency] + grouped + (fraction ? '.' + fraction : '');
}
