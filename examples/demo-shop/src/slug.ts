/** URL slug for a product title: "Summer Sale 2025" -> "summer-sale-2025". */
export const slugify = (title: string): string =>
  title
    .toLowerCase()
    .trim()
    .replace(/\s+/g, '-')
    .replace(/[^a-z0-9-]/g, '');
