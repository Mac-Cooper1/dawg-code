# Alternative fix: heal once per opponent inside the loop.
python3 "$TASK_DIR/../_tools/replace.py" cardgame/cards.py '        for opponent in state.opponents(player):
            taken = state.damage(opponent, self.drain)
        state.heal(player, taken)' '        for opponent in state.opponents(player):
            taken = state.damage(opponent, self.drain)
            state.heal(player, taken)'
