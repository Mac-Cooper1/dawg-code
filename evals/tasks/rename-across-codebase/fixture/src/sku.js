// SKU helpers. A canonical SKU is three letters, a dash, four digits and an
// optional dash-separated variant of one to three letters or digits.

const CANONICAL = /^[A-Z]{3}-\d{4}(?:-[A-Z0-9]{1,3})?$/;

/**
 * Turn user input such as " abc_1234 xl " into the canonical "ABC-1234-XL".
 * @param {string} raw
 * @returns {string}
 * @throws {RangeError} when the input cannot be made into a valid SKU
 */
export function normalizeSku(raw) {
  if (typeof raw !== "string") {
    throw new RangeError(`SKU must be a string, got ${typeof raw}`);
  }
  const sku = raw
    .trim()
    .toUpperCase()
    .replace(/[\s_]+/g, "-")
    .replace(/-{2,}/g, "-");
  if (!CANONICAL.test(sku)) {
    throw new RangeError(`invalid SKU: "${raw}"`);
  }
  return sku;
}

/** @param {string} raw */
export function isValidSku(raw) {
  try {
    normalizeSku(raw);
    return true;
  } catch {
    return false;
  }
}
