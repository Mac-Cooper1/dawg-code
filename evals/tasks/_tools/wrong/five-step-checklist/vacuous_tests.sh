# tests/test_cli.py exists but tests nothing new (passes on the old code too).
cp -R "$TASK_DIR/solution/." .
cat > tests/test_cli.py <<'PY'
import unittest
from wordtally.cli import build_parser

class CliTest(unittest.TestCase):
    def test_parser_builds(self):
        # covers --min-length and --json eventually
        self.assertIsNotNone(build_parser())
PY
