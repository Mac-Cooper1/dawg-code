# --json prints an object {word: count} instead of an array of pairs.
cp -R "$TASK_DIR/solution/." .
python3 "$TASK_DIR/../_tools/replace.py" wordtally/cli.py 'print(json.dumps([[word, n] for word, n in result]))' 'print(json.dumps(dict(result)))'
python3 "$TASK_DIR/../_tools/replace.py" tests/test_cli.py 'self.assertEqual(json.loads(out), [["don'"'"'t", 2], ["music", 2], ["stop", 2]])' 'self.assertEqual(json.loads(out), {"don'"'"'t": 2, "music": 2, "stop": 2})'
python3 "$TASK_DIR/../_tools/replace.py" tests/test_cli.py 'self.assertEqual(json.loads(out), [["don'"'"'t", 2], ["music", 2]])' 'self.assertEqual(json.loads(out), {"don'"'"'t": 2, "music": 2})'
