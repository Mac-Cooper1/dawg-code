# Half fix: stops the crash with no opponents, still heals only the last amount.
python3 "$TASK_DIR/../_tools/replace.py" cardgame/cards.py '    def apply(self, state, player, target=None):
        for opponent in state.opponents(player):
            taken = state.damage(opponent, self.drain)
        state.heal(player, taken)' '    def apply(self, state, player, target=None):
        taken = 0
        for opponent in state.opponents(player):
            taken = state.damage(opponent, self.drain)
        state.heal(player, taken)'
