import contextlib
import io
import json
import os
import tempfile
import unittest

from wordtally.cli import main

TEXT = "Don't stop, don't stop the music. It's the best music of all.\n"


class CliTest(unittest.TestCase):
    def setUp(self):
        fd, self.path = tempfile.mkstemp(suffix=".txt")
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            f.write(TEXT)

    def tearDown(self):
        os.remove(self.path)

    def run_cli(self, *args):
        out = io.StringIO()
        with contextlib.redirect_stdout(out):
            self.assertEqual(main([*args, self.path]), 0)
        return out.getvalue()

    def test_min_length_filters_short_words(self):
        out = self.run_cli("--min-length", "5", "--top", "3")
        self.assertEqual(out, "don't\t2\nmusic\t2\n")

    def test_min_length_applies_before_top(self):
        out = self.run_cli("--min-length", "4", "--top", "2")
        self.assertEqual(out, "don't\t2\nmusic\t2\n")

    def test_json_output(self):
        out = self.run_cli("--json", "--top", "3")
        self.assertEqual(json.loads(out), [["don't", 2], ["music", 2], ["stop", 2]])

    def test_json_with_min_length(self):
        out = self.run_cli("--json", "--min-length", "5")
        self.assertEqual(json.loads(out), [["don't", 2], ["music", 2]])


if __name__ == "__main__":
    unittest.main()
