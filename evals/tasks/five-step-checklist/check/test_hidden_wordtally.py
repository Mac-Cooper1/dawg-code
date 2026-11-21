"""Hidden checks for the five-step-checklist task (items 1, 2, 3 and 5).

Run with cwd = a temp dir, PYTHONPATH = the workspace, WORKSPACE set.
Each test name starts with the item it covers.
"""
import json
import os
import re
import subprocess
import sys
import tempfile
import unittest

WS = os.environ["WORKSPACE"]
SAMPLE = (
    "Don't stop. Don't stop the music; it's three o'clock.\n"
    "'Quoted' words and rock'n'roll: the band's \"best\" song isn't over.\n"
    "The the THE music\n"
)


def run_cli(*args):
    fd, path = tempfile.mkstemp(suffix=".txt")
    with os.fdopen(fd, "w", encoding="utf-8") as f:
        f.write(SAMPLE)
    try:
        env = dict(os.environ, PYTHONPATH=WS, PYTHONDONTWRITEBYTECODE="1")
        proc = subprocess.run(
            [sys.executable, "-m", "wordtally", *args, path],
            cwd=WS, env=env, capture_output=True, text=True, timeout=20,
        )
    finally:
        os.remove(path)
    if proc.returncode != 0:
        raise AssertionError(f"wordtally {args} exited {proc.returncode}: {proc.stderr[-500:]}")
    return proc.stdout


class Item1Apostrophes(unittest.TestCase):
    def test_item1_inner_apostrophes_keep_words_whole(self):
        from wordtally.counter import count_words

        self.assertEqual(
            count_words("Don't stop; 'quoted' rock'n'roll it's O'Clock 42"),
            {"don't": 1, "stop": 1, "quoted": 1, "rock'n'roll": 1, "it's": 1, "o'clock": 1, "42": 1},
        )

    def test_item1_edge_apostrophes_are_not_part_of_words(self):
        from wordtally.counter import count_words

        self.assertEqual(count_words("'hello' 'tis dogs' bark"), {"hello": 1, "tis": 1, "dogs": 1, "bark": 1})

    def test_item1_existing_behaviour(self):
        from wordtally.counter import count_words

        self.assertEqual(count_words("Hello, WORLD! hello 42"), {"hello": 2, "world": 1, "42": 1})

    def test_item1_cli_default_output(self):
        self.assertEqual(
            run_cli(),
            "the\t5\ndon't\t2\nmusic\t2\nstop\t2\nand\t1\nband's\t1\nbest\t1\nisn't\t1\nit's\t1\no'clock\t1\n",
        )


class Item2MinLength(unittest.TestCase):
    def test_item2_min_length(self):
        self.assertEqual(
            run_cli("--min-length", "5"),
            "don't\t2\nmusic\t2\nband's\t1\nisn't\t1\no'clock\t1\nquoted\t1\nrock'n'roll\t1\nthree\t1\nwords\t1\n",
        )

    def test_item2_min_length_before_top(self):
        self.assertEqual(run_cli("--min-length", "6", "--top", "2"), "band's\t1\no'clock\t1\n")

    def test_item2_default_is_no_filtering(self):
        self.assertEqual(run_cli("--min-length", "1", "--top", "3"), "the\t5\ndon't\t2\nmusic\t2\n")


class Item3Json(unittest.TestCase):
    def test_item3_json(self):
        self.assertEqual(json.loads(run_cli("--json", "--top", "4")), [["the", 5], ["don't", 2], ["music", 2], ["stop", 2]])

    def test_item3_json_with_min_length(self):
        self.assertEqual(
            json.loads(run_cli("--json", "--top", "3", "--min-length", "5")),
            [["don't", 2], ["music", 2], ["band's", 1]],
        )

    def test_item3_text_output_unchanged_without_flag(self):
        self.assertEqual(run_cli("--top", "1"), "the\t5\n")


class Item5Release(unittest.TestCase):
    def test_item5_version(self):
        import wordtally

        self.assertEqual(wordtally.__version__, "1.4.0")

    def test_item5_changelog(self):
        with open(os.path.join(WS, "CHANGELOG.md"), encoding="utf-8") as f:
            text = f.read()
        heads = [m for m in re.finditer(r"^##\s+(.*)$", text, re.M)]
        self.assertTrue(heads, "no ## sections")
        self.assertRegex(heads[0].group(1), r"^\[?v?1\.4\.0\]?(\s|$)", "first section must be 1.4.0")
        self.assertTrue(any(re.match(r"\[?v?1\.3\.0\]?(\s|$)", h.group(1)) for h in heads[1:]), "1.3.0 section lost")
        end = heads[1].start() if len(heads) > 1 else len(text)
        section = text[heads[0].end():end]
        bullets = [l for l in section.splitlines() if re.match(r"^\s*[-*+]\s+\S", l)]
        self.assertGreaterEqual(len(bullets), 3, "need a bullet for each change")
        low = section.lower()
        self.assertIn("json", low)
        self.assertRegex(low, r"min[-_ ]?length|minimum length")
        self.assertRegex(low, r"apostroph|contraction|'")


if __name__ == "__main__":
    unittest.main()
