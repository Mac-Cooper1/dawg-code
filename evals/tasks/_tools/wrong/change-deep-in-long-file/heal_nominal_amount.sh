# Wrong fix: heals drain * number of opponents, ignoring shields and low health.
python3 "$TASK_DIR/../_tools/replace.py" cardgame/cards.py '        for opponent in state.opponents(player):
            taken = state.damage(opponent, self.drain)
        state.heal(player, taken)' '        opponents = state.opponents(player)
        for opponent in opponents:
            state.damage(opponent, self.drain)
        state.heal(player, self.drain * len(opponents))'
