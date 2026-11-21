# --min-length filters after picking the top N (wrong order).
cp -R "$TASK_DIR/solution/." .
python3 "$TASK_DIR/../_tools/replace.py" wordtally/cli.py '    merged = {w: n for w, n in merge(*counts).items() if len(w) >= args.min_length}
    result = top(merged, args.top)' '    result = [(w, n) for w, n in top(merge(*counts), args.top) if len(w) >= args.min_length]'
python3 "$TASK_DIR/../_tools/replace.py" tests/test_cli.py '    def test_min_length_applies_before_top(self):
        out = self.run_cli("--min-length", "4", "--top", "2")
        self.assertEqual(out, "don'"'"'t\t2\nmusic\t2\n")
' ''
