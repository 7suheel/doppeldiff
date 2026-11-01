# Fix discount rounding for prices over $1000

Prices above $1000 were rounded _down_ to whole cents after applying a discount, which under-charged
by up to one cent. All prices are now rounded to the nearest cent.
