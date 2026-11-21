# Alternative fix: a new GameState helper, used only by Ember Tithe, plus a test.
python3 "$TASK_DIR/../_tools/replace.py" cardgame/state.py '    def gain_gold(self, player, amount):' '    def drain_each(self, player, amount):
        """Damage every opponent; return the total health they lost."""
        return sum(self.damage(o, amount) for o in self.opponents(player))

    def gain_gold(self, player, amount):'
python3 "$TASK_DIR/../_tools/replace.py" cardgame/cards.py '        for opponent in state.opponents(player):
            taken = state.damage(opponent, self.drain)
        state.heal(player, taken)' '        state.heal(player, state.drain_each(player, self.drain))'
cat >> tests/test_cards.py <<'PY'


class EmberTitheRegressionTest(unittest.TestCase):
    def test_heals_total(self):
        a, b = Player("a"), Player("b")
        state, me = table(a, b)
        get_card("Ember Tithe").play(state, me)
        self.assertEqual(me.health, 14)
PY
