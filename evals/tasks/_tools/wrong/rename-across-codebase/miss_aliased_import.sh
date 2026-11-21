# Partial: everything renamed except the aliased import in importer.js.
for f in $(grep -rl normalizeSku --exclude-dir=.git .); do
	[ "$f" = ./src/importer.js ] && continue
	python3 "$TASK_DIR/../_tools/replace.py" "$f" normalizeSku canonicalSku
done
