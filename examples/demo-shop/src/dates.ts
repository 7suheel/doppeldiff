/** Add business days (Mon–Fri) to a date, in UTC. Negative values go backwards. */
export function addBusinessDays(date: Date, days: number): Date {
  if (!Number.isInteger(days)) throw new TypeError('days must be an integer');
  const result = new Date(date.getTime());
  const step = days < 0 ? -1 : 1;
  let remaining = Math.abs(days);
  while (remaining > 0) {
    result.setUTCDate(result.getUTCDate() + step);
    const day = result.getUTCDay();
    if (day !== 0 && day !== 6) remaining--;
  }
  return result;
}

/** ISO calendar date (YYYY-MM-DD) in UTC. */
export function formatDate(date: Date): string {
  const y = date.getUTCFullYear();
  const m = String(date.getUTCMonth() + 1).padStart(2, '0');
  const d = String(date.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}
