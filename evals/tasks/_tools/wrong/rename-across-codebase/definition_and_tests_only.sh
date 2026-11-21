# Partial: rename the definition, index re-export and tests, miss the other call sites.
for f in src/sku.js src/index.js test/sku.test.js README.md; do
	python3 "$TASK_DIR/../_tools/replace.py" "$f" normalizeSku canonicalSku
done
