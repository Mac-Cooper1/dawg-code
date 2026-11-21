import unittest

from wordtally.counter import count_words, merge, tokenize, top


class CounterTest(unittest.TestCase):
    def test_tokenize_lowercases(self):
        self.assertEqual(tokenize("Hello, WORLD! 42 times"), ["hello", "world", "42", "times"])

    def test_count_words(self):
        self.assertEqual(count_words("a b a"), {"a": 2, "b": 1})

    def test_merge(self):
        self.assertEqual(merge({"a": 1}, {"a": 2, "b": 1}), {"a": 3, "b": 1})

    def test_top_breaks_ties_alphabetically(self):
        self.assertEqual(top({"b": 2, "a": 2, "c": 5, "d": 1}, 3), [("c", 5), ("a", 2), ("b", 2)])


if __name__ == "__main__":
    unittest.main()
