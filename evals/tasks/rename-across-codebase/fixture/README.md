# shelfstock

A tiny inventory toolkit: a product catalog keyed by SKU, carts, CSV import
and low-stock reports.

## SKUs

A SKU looks like `ABC-1234` with an optional variant suffix: `ABC-1234-XL`.
Input is forgiving: `normalizeSku(" abc_1234 xl ")` returns `"ABC-1234-XL"`.
Anything that cannot be turned into a valid SKU throws a `RangeError`.

Every module that accepts a SKU passes it through `normalizeSku` first, so
callers can use whatever spelling they have.

## API

- `normalizeSku(raw)` / `isValidSku(raw)`
- `Catalog` – `add(product)`, `get(sku)`, `restock(sku, n)`, `all()`
- `Cart` – `add(sku, qty)`, `remove(sku)`, `total()`
- `importCsv(text)` – parse `sku,name,price_cents,stock` lines into products
- `findBySku(catalog, query)` / `searchByName(catalog, words)`
- `lowStockReport(catalog, threshold)`

## CLI

    node bin/stock.js sku " abc_1234 xl "
    node bin/stock.js report products.csv 5

Run the tests with `node --test`.
