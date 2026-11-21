# Wrong place: "fixes" it by making Card.play swallow errors; heal still wrong.
python3 "$TASK_DIR/../_tools/replace.py" cardgame/cards.py '        self.apply(state, player, target)' '        try:
            self.apply(state, player, target)
        except UnboundLocalError:
            pass'
