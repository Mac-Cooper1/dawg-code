# Lazy: add canonicalSku as an alias and keep the old function.
cat >> src/sku.js <<'JS'

export const canonicalSku = normalizeSku;
JS
python3 "$TASK_DIR/../_tools/replace.py" src/index.js 'export { isValidSku, normalizeSku } from "./sku.js";' 'export { canonicalSku, isValidSku, normalizeSku } from "./sku.js";'
