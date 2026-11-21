import unittest

from cardgame import CARDS, GameState, NotEnoughGold, Player, get_card


def table(*opponents, me=None):
    me = me or Player("me", health=10, gold=10, deck=["x", "y", "z"])
    return GameState([me, *opponents]), me


class RegistryTest(unittest.TestCase):
    def test_every_card_is_registered_once(self):
        self.assertEqual(len(CARDS), 141)
        numbers = sorted(card.set_number for card in CARDS.values())
        self.assertEqual(numbers, list(range(1, 142)))

    def test_unknown_card(self):
        with self.assertRaises(KeyError):
            get_card("Nope")


class PlayTest(unittest.TestCase):
    def test_cost_is_charged(self):
        state, me = table(Player("a"))
        get_card("Amber Fable").play(state, me)  # cost 4
        self.assertEqual(me.gold, 6)

    def test_not_enough_gold(self):
        state, me = table(Player("a"), me=Player("me", gold=1))
        with self.assertRaises(NotEnoughGold):
            get_card("Amber Fable").play(state, me)

    def test_single_target_damage_defaults_to_first_opponent(self):
        a, b = Player("a"), Player("b")
        state, me = table(a, b)
        get_card("Amber Mantle").play(state, me)  # 4 damage
        self.assertEqual((a.health, b.health), (16, 20))
        get_card("Amber Mantle").play(state, me, target=b)
        self.assertEqual((a.health, b.health), (16, 16))

    def test_shield_absorbs_first(self):
        a = Player("a", shield=3)
        state, me = table(a)
        get_card("Amber Mantle").play(state, me)
        self.assertEqual((a.shield, a.health), (0, 19))

    def test_drain_each_opponent_heals_total(self):
        a, b, c = Player("a"), Player("b"), Player("c", health=1)
        state, me = table(a, b, c)
        get_card("Ashen Banner").play(state, me)  # drain 2 from each
        self.assertEqual((a.health, b.health, c.health), (18, 18, 0))
        self.assertEqual(me.health, 15)

    def test_gold_and_draw(self):
        state, me = table(Player("a"))
        get_card("Feral Ledger").play(state, me)  # gain 1 gold, draw 2
        self.assertEqual(me.gold, 11)
        self.assertEqual(me.hand, ["x", "y"])


if __name__ == "__main__":
    unittest.main()
