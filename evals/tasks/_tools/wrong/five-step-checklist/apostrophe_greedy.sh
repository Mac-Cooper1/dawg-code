# Apostrophe fix that also keeps leading/trailing apostrophes ('quoted').
cp -R "$TASK_DIR/solution/." .
python3 "$TASK_DIR/../_tools/replace.py" wordtally/counter.py "_WORD = re.compile(r\"[a-z0-9]+(?:'[a-z0-9]+)*\")" "_WORD = re.compile(r\"[a-z0-9']+\")"
