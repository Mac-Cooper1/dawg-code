# Correct fix, but the whole file was rewritten with a different quote style for tags.
cp "$TASK_DIR/solution/cardgame/cards.py" cardgame/cards.py
python3 - <<'PY'
import re
p = "cardgame/cards.py"
s = open(p).read()
s = re.sub(r"tags = \((.*)\)", lambda m: "tags = (" + m.group(1).replace("'", '"') + ")", s)
open(p, "w").write(s)
PY
