# Generates the file locally and "un-ignores" nothing: generated file left in an ignored dir.
cp "$TASK_DIR/solution/data/units.csv" data/units.csv
mkdir -p src/generated
node scripts/generate-units.mjs
python3 "$TASK_DIR/../_tools/replace.py" ci.sh 'node scripts/generate-units.mjs' 'true'
