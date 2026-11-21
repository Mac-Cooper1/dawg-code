# Alternative fix: create the directory in ci.sh, fix the data, run it once.
python3 "$TASK_DIR/../_tools/replace.py" ci.sh 'echo "==> generate"' 'echo "==> generate"
mkdir -p src/generated'
python3 "$TASK_DIR/../_tools/replace.py" data/units.csv "ft,foot,length,0.3408" "ft,foot,length,0.3048"
bash ci.sh
