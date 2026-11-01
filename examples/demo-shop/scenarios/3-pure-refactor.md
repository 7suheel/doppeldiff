# Refactor pricing and date helpers

Extracts `volumeDiscountRate` and `isWeekend`, replaces the tax `switch` with a lookup table and
simplifies `formatDate`. No behavior change intended.
