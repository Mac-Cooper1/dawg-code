# Alternative: tests run the CLI as a subprocess; changelog in "## [1.4.0] - date" style with * bullets.
cp "$TASK_DIR/solution/wordtally/counter.py" wordtally/counter.py
cp "$TASK_DIR/solution/wordtally/cli.py" wordtally/cli.py
python3 "$TASK_DIR/../_tools/replace.py" wordtally/__init__.py '"1.3.0"' '"1.4.0"'
python3 "$TASK_DIR/../_tools/replace.py" CHANGELOG.md '# Changelog
' '# Changelog

## [1.4.0] - 2026-11-20

* Count contractions such as "don'"'"'t" as a single word.
* Add `--min-length` to skip short words.
* Add `--json` output.
'
cat > tests/test_cli.py <<'PY'
import json
import os
import subprocess
import sys
import tempfile
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def run(*args, text="aa bbb bbb cccc cccc cccc"):
    with tempfile.NamedTemporaryFile("w", suffix=".txt", delete=False) as f:
        f.write(text)
    try:
        return subprocess.run([sys.executable, "-m", "wordtally", *args, f.name], cwd=ROOT,
                              capture_output=True, text=True, check=True).stdout
    finally:
        os.unlink(f.name)


class CliTest(unittest.TestCase):
    def test_min_length(self):
        self.assertEqual(run("--min-length", "3"), "cccc\t3\nbbb\t2\n")

    def test_json(self):
        self.assertEqual(json.loads(run("--json")), [["cccc", 3], ["bbb", 2], ["aa", 1]])
PY
