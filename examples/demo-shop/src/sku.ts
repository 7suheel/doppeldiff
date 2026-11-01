export interface Sku {
  category: string;
  id: number;
  size?: 'S' | 'M' | 'L' | 'XL';
}

const SIZES = ['S', 'M', 'L', 'XL'] as const;

/** Parse SKUs like "SHOE-0042" or "TEE-0007-XL". Returns null for invalid input. */
export function parseSku(sku: string): Sku | null {
  const parts = sku.trim().toUpperCase().split('-');
  if (parts.length < 2 || parts.length > 3) return null;
  const [category, rawId, size] = parts as [string, string, string | undefined];
  if (!/^[A-Z]{2,8}$/.test(category)) return null;
  if (!/^\d{4}$/.test(rawId)) return null;
  const result: Sku = { category, id: Number(rawId) };
  if (size !== undefined) {
    if (!(SIZES as readonly string[]).includes(size)) return null;
    result.size = size as Sku['size'];
  }
  return result;
}
