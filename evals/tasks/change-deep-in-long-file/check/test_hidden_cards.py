"""Hidden tests for Ember Tithe (run with PYTHONPATH = workspace)."""
import unittest

from cardgame import GameState, Player, get_card


def table(*opponents, me=None):
    me = me or Player("me", health=10, gold=10)
    return GameState([me, *opponents]), me


class EmberTitheTest(unittest.TestCase):
    def test_heals_total_from_three_opponents(self):
        a, b, c = Player("a"), Player("b"), Player("c")
        state, me = table(a, b, c)
        get_card("Ember Tithe").play(state, me)
        self.assertEqual([p.health for p in (a, b, c)], [18, 18, 18])
        self.assertEqual(me.health, 16)
        self.assertEqual(me.gold, 7)

    def test_heals_only_what_was_actually_drained(self):
        a, b, c = Player("a", shield=3), Player("b", health=1), Player("c", health=7)
        state, me = table(a, b, c, me=Player("me", health=15, gold=10))
        get_card("Ember Tithe").play(state, me)
        self.assertEqual((a.shield, a.health, b.health, c.health), (1, 20, 0, 5))
        self.assertEqual(me.health, 18)

    def test_single_opponent(self):
        a = Player("a")
        state, me = table(a)
        get_card("Ember Tithe").play(state, me)
        self.assertEqual((a.health, me.health), (18, 12))

    def test_no_opponents_left(self):
        dead = Player("dead", health=0)
        state, me = table(dead)
        get_card("Ember Tithe").play(state, me)
        self.assertEqual((me.health, me.gold, dead.health), (10, 7, 0))

    def test_skips_players_already_out(self):
        a, dead, c = Player("a"), Player("dead", health=0), Player("c")
        state, me = table(a, dead, c)
        get_card("Ember Tithe").play(state, me)
        self.assertEqual((a.health, dead.health, c.health, me.health), (18, 0, 18, 14))

    def test_heal_is_capped(self):
        others = [Player(n) for n in "abcd"]
        state, me = table(*others, me=Player("me", health=19, gold=3))
        get_card("Ember Tithe").play(state, me)
        self.assertEqual(me.health, 20)
        self.assertEqual([p.health for p in others], [18, 18, 18, 18])

    def test_card_data_unchanged(self):
        card = get_card("Ember Tithe")
        self.assertEqual(card.cost, 3)
        self.assertEqual(card.set_number, 116)
        self.assertEqual(card.text, "Drain 2 health from each opponent. Heal for the total drained.")


if __name__ == "__main__":
    unittest.main()
