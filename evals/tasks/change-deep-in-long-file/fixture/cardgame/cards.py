"""Every card in the game.

Each card is a small class registered in CARDS by its display name. Cards are
played through Card.play(), which charges the cost and then calls apply().

Conventions for apply(state, player, target=None):
  - `player` is the Player who played the card;
  - `target` is an optional Player chosen by the UI; single-target cards fall
    back to the first living opponent when it is None;
  - all changes go through GameState methods (damage, heal, gain_gold, ...)
    so they are logged and clamped consistently.

This file is long on purpose: designers edit one card at a time and want each
card's numbers next to its behaviour. Keep cards in set order.
"""

from .state import GameState, NotEnoughGold, Player

CARDS = {}


def register(cls):
    """Class decorator: add one instance of the card to CARDS."""
    card = cls()
    if card.name in CARDS:
        raise ValueError(f"duplicate card name {card.name!r}")
    CARDS[card.name] = card
    return cls


def get_card(name):
    try:
        return CARDS[name]
    except KeyError:
        raise KeyError(f"no card named {name!r}") from None


class Card:
    """Base class. Subclasses set the class attributes and implement apply()."""

    name = ""
    set_number = 0
    cost = 0
    rarity = "common"
    text = ""
    flavour = ""
    tags = ()

    def play(self, state, player, target=None):
        if player.gold < self.cost:
            raise NotEnoughGold(f"{self.name} costs {self.cost}, {player.name} has {player.gold}")
        player.gold -= self.cost
        state.log.append(f"{player.name} plays {self.name}")
        self.apply(state, player, target)

    def apply(self, state, player, target=None):
        raise NotImplementedError

    @staticmethod
    def first_opponent(state, player):
        opponents = state.opponents(player)
        return opponents[0] if opponents else None

    def describe(self):
        return f"{self.name} ({self.cost}): {self.text}"

    def __repr__(self):
        return f"<Card #{self.set_number} {self.name}>"


@register
class AmberMantle(Card):
    """Deal 4 damage to an opponent.

    What the river takes, the river keeps.
    """

    name = "Amber Mantle"
    set_number = 1
    cost = 1
    rarity = "uncommon"
    text = "Deal 4 damage to an opponent."
    flavour = "What the river takes, the river keeps."
    tags = ('attack',)
    damage = 4

    def apply(self, state, player, target=None):
        target = target or self.first_opponent(state, player)
        if target is None:
            return
        state.damage(target, self.damage)


@register
class HazelOracle(Card):
    """Gain 3 shield.

    It hums when the moon is low.
    """

    name = "Hazel Oracle"
    set_number = 2
    cost = 4
    rarity = "uncommon"
    text = "Gain 3 shield."
    flavour = "It hums when the moon is low."
    tags = ('defence',)
    shield = 3

    def apply(self, state, player, target=None):
        state.add_shield(player, self.shield)


@register
class IronMirror(Card):
    """Gain 2 shield and heal 2 health.

    Every harvest has its tithe.
    """

    name = "Iron Mirror"
    set_number = 3
    cost = 0
    rarity = "common"
    text = "Gain 2 shield and heal 2 health."
    flavour = "Every harvest has its tithe."
    tags = ('defence', 'support')
    shield = 2
    healing = 2

    def apply(self, state, player, target=None):
        state.add_shield(player, self.shield)
        state.heal(player, self.healing)


@register
class JadeOmen(Card):
    """Deal 2 damage to each opponent.

    Some debts are paid in coin, some in ash.
    """

    name = "Jade Omen"
    set_number = 4
    cost = 2
    rarity = "common"
    text = "Deal 2 damage to each opponent."
    flavour = "Some debts are paid in coin, some in ash."
    tags = ('attack', 'area')
    damage = 2

    def apply(self, state, player, target=None):
        for opponent in state.opponents(player):
            state.damage(opponent, self.damage)


@register
class AmberOmen(Card):
    """Deal 4 damage to each opponent.

    Some debts are paid in coin, some in ash.
    """

    name = "Amber Omen"
    set_number = 5
    cost = 1
    rarity = "uncommon"
    text = "Deal 4 damage to each opponent."
    flavour = "Some debts are paid in coin, some in ash."
    tags = ('attack', 'area')
    damage = 4

    def apply(self, state, player, target=None):
        for opponent in state.opponents(player):
            state.damage(opponent, self.damage)


@register
class BrassSermon(Card):
    """Gain 2 gold.

    The ledger always balances, eventually.
    """

    name = "Brass Sermon"
    set_number = 6
    cost = 2
    rarity = "rare"
    text = "Gain 2 gold."
    flavour = "The ledger always balances, eventually."
    tags = ('economy',)
    gold = 2

    def apply(self, state, player, target=None):
        state.gain_gold(player, self.gold)


@register
class WildEffigy(Card):
    """Draw 3 cards.

    The ledger always balances, eventually.
    """

    name = "Wild Effigy"
    set_number = 7
    cost = 5
    rarity = "rare"
    text = "Draw 3 cards."
    flavour = "The ledger always balances, eventually."
    tags = ('card-draw',)
    cards = 3

    def apply(self, state, player, target=None):
        drawn = state.draw(player, self.cards)
        if drawn < self.cards:
            state.log.append(f"{player.name} ran out of cards")


@register
class AshenBanner(Card):
    """Drain 2 health from each opponent. Heal for the total drained.

    Every harvest has its tithe.
    """

    name = "Ashen Banner"
    set_number = 8
    cost = 1
    rarity = "uncommon"
    text = "Drain 2 health from each opponent. Heal for the total drained."
    flavour = "Every harvest has its tithe."
    tags = ('attack', 'area', 'drain')
    drain = 2

    def apply(self, state, player, target=None):
        total = 0
        for opponent in state.opponents(player):
            total += state.damage(opponent, self.drain)
        state.heal(player, total)


@register
class WildBargain(Card):
    """Take up to 1 gold from each opponent.

    Old soldiers swear by it; young ones swear at it.
    """

    name = "Wild Bargain"
    set_number = 9
    cost = 5
    rarity = "uncommon"
    text = "Take up to 1 gold from each opponent."
    flavour = "Old soldiers swear by it; young ones swear at it."
    tags = ('economy', 'area')
    levy = 1

    def apply(self, state, player, target=None):
        for opponent in state.opponents(player):
            state.take_gold(opponent, player, self.levy)


@register
class CinderPact(Card):
    """Heal 2 health.

    The ledger always balances, eventually.
    """

    name = "Cinder Pact"
    set_number = 10
    cost = 0
    rarity = "common"
    text = "Heal 2 health."
    flavour = "The ledger always balances, eventually."
    tags = ('support',)
    healing = 2

    def apply(self, state, player, target=None):
        state.heal(player, self.healing)


@register
class QuietMantle(Card):
    """Deal 4 damage to each opponent.

    Some debts are paid in coin, some in ash.
    """

    name = "Quiet Mantle"
    set_number = 11
    cost = 1
    rarity = "common"
    text = "Deal 4 damage to each opponent."
    flavour = "Some debts are paid in coin, some in ash."
    tags = ('attack', 'area')
    damage = 4

    def apply(self, state, player, target=None):
        for opponent in state.opponents(player):
            state.damage(opponent, self.damage)


@register
class RustMirror(Card):
    """Take up to 3 gold from each opponent.

    The ledger always balances, eventually.
    """

    name = "Rust Mirror"
    set_number = 12
    cost = 0
    rarity = "common"
    text = "Take up to 3 gold from each opponent."
    flavour = "The ledger always balances, eventually."
    tags = ('economy', 'area')
    levy = 3

    def apply(self, state, player, target=None):
        for opponent in state.opponents(player):
            state.take_gold(opponent, player, self.levy)


@register
class AmberJester(Card):
    """Drain 3 health from each opponent. Heal for the total drained.

    Bring a lantern, and a spare.
    """

    name = "Amber Jester"
    set_number = 13
    cost = 1
    rarity = "uncommon"
    text = "Drain 3 health from each opponent. Heal for the total drained."
    flavour = "Bring a lantern, and a spare."
    tags = ('attack', 'area', 'drain')
    drain = 3

    def apply(self, state, player, target=None):
        total = 0
        for opponent in state.opponents(player):
            total += state.damage(opponent, self.drain)
        state.heal(player, total)


@register
class CinderMantle(Card):
    """Gain 5 shield.

    Every harvest has its tithe.
    """

    name = "Cinder Mantle"
    set_number = 14
    cost = 3
    rarity = "rare"
    text = "Gain 5 shield."
    flavour = "Every harvest has its tithe."
    tags = ('defence',)
    shield = 5

    def apply(self, state, player, target=None):
        state.add_shield(player, self.shield)


@register
class QuietAnvil(Card):
    """Gain 4 gold. Take 2 damage.

    Bring a lantern, and a spare.
    """

    name = "Quiet Anvil"
    set_number = 15
    cost = 0
    rarity = "uncommon"
    text = "Gain 4 gold. Take 2 damage."
    flavour = "Bring a lantern, and a spare."
    tags = ('economy', 'risky')
    gold = 4
    self_damage = 2

    def apply(self, state, player, target=None):
        state.gain_gold(player, self.gold)
        state.damage(player, self.self_damage)


@register
class DuskJester(Card):
    """Take up to 2 gold from each opponent.

    Old soldiers swear by it; young ones swear at it.
    """

    name = "Dusk Jester"
    set_number = 16
    cost = 0
    rarity = "uncommon"
    text = "Take up to 2 gold from each opponent."
    flavour = "Old soldiers swear by it; young ones swear at it."
    tags = ('economy', 'area')
    levy = 2

    def apply(self, state, player, target=None):
        for opponent in state.opponents(player):
            state.take_gold(opponent, player, self.levy)


@register
class DrownedWarden(Card):
    """Drain 1 health from each opponent. Heal for the total drained.

    Forged twice, trusted once.
    """

    name = "Drowned Warden"
    set_number = 17
    cost = 3
    rarity = "uncommon"
    text = "Drain 1 health from each opponent. Heal for the total drained."
    flavour = "Forged twice, trusted once."
    tags = ('attack', 'area', 'drain')
    drain = 1

    def apply(self, state, player, target=None):
        total = 0
        for opponent in state.opponents(player):
            total += state.damage(opponent, self.drain)
        state.heal(player, total)


@register
class KindledAnvil(Card):
    """Deal 4 damage to an opponent.

    What the river takes, the river keeps.
    """

    name = "Kindled Anvil"
    set_number = 18
    cost = 0
    rarity = "common"
    text = "Deal 4 damage to an opponent."
    flavour = "What the river takes, the river keeps."
    tags = ('attack',)
    damage = 4

    def apply(self, state, player, target=None):
        target = target or self.first_opponent(state, player)
        if target is None:
            return
        state.damage(target, self.damage)


@register
class SaltBeacon(Card):
    """Gain 1 shield and heal 4 health.

    The ledger always balances, eventually.
    """

    name = "Salt Beacon"
    set_number = 19
    cost = 5
    rarity = "rare"
    text = "Gain 1 shield and heal 4 health."
    flavour = "The ledger always balances, eventually."
    tags = ('defence', 'support')
    shield = 1
    healing = 4

    def apply(self, state, player, target=None):
        state.add_shield(player, self.shield)
        state.heal(player, self.healing)


@register
class AmberFable(Card):
    """Deal 5 damage to an opponent.

    The ledger always balances, eventually.
    """

    name = "Amber Fable"
    set_number = 20
    cost = 4
    rarity = "common"
    text = "Deal 5 damage to an opponent."
    flavour = "The ledger always balances, eventually."
    tags = ('attack',)
    damage = 5

    def apply(self, state, player, target=None):
        target = target or self.first_opponent(state, player)
        if target is None:
            return
        state.damage(target, self.damage)


@register
class WildHymn(Card):
    """Gain 2 shield and heal 4 health.

    Old soldiers swear by it; young ones swear at it.
    """

    name = "Wild Hymn"
    set_number = 21
    cost = 1
    rarity = "common"
    text = "Gain 2 shield and heal 4 health."
    flavour = "Old soldiers swear by it; young ones swear at it."
    tags = ('defence', 'support')
    shield = 2
    healing = 4

    def apply(self, state, player, target=None):
        state.add_shield(player, self.shield)
        state.heal(player, self.healing)


@register
class LunarOmen(Card):
    """Gain 6 shield.

    Forged twice, trusted once.
    """

    name = "Lunar Omen"
    set_number = 22
    cost = 0
    rarity = "common"
    text = "Gain 6 shield."
    flavour = "Forged twice, trusted once."
    tags = ('defence',)
    shield = 6

    def apply(self, state, player, target=None):
        state.add_shield(player, self.shield)


@register
class CobaltHarvest(Card):
    """Drain 2 health from each opponent. Heal for the total drained.

    Nobody remembers who wrote the first verse.
    """

    name = "Cobalt Harvest"
    set_number = 23
    cost = 5
    rarity = "uncommon"
    text = "Drain 2 health from each opponent. Heal for the total drained."
    flavour = "Nobody remembers who wrote the first verse."
    tags = ('attack', 'area', 'drain')
    drain = 2

    def apply(self, state, player, target=None):
        total = 0
        for opponent in state.opponents(player):
            total += state.damage(opponent, self.drain)
        state.heal(player, total)


@register
class FeralLedger(Card):
    """Gain 1 gold and draw 2 cards.

    It hums when the moon is low.
    """

    name = "Feral Ledger"
    set_number = 24
    cost = 0
    rarity = "uncommon"
    text = "Gain 1 gold and draw 2 cards."
    flavour = "It hums when the moon is low."
    tags = ('economy', 'card-draw')
    gold = 1
    cards = 2

    def apply(self, state, player, target=None):
        state.gain_gold(player, self.gold)
        state.draw(player, self.cards)


@register
class WildVigil(Card):
    """Deal 2 damage to each opponent.

    Forged twice, trusted once.
    """

    name = "Wild Vigil"
    set_number = 25
    cost = 5
    rarity = "common"
    text = "Deal 2 damage to each opponent."
    flavour = "Forged twice, trusted once."
    tags = ('attack', 'area')
    damage = 2

    def apply(self, state, player, target=None):
        for opponent in state.opponents(player):
            state.damage(opponent, self.damage)


@register
class GraveGarland(Card):
    """Heal 8 health.

    Nobody remembers who wrote the first verse.
    """

    name = "Grave Garland"
    set_number = 26
    cost = 5
    rarity = "rare"
    text = "Heal 8 health."
    flavour = "Nobody remembers who wrote the first verse."
    tags = ('support',)
    healing = 8

    def apply(self, state, player, target=None):
        state.heal(player, self.healing)


@register
class HollowIdol(Card):
    """Deal 2 damage to an opponent.

    Old soldiers swear by it; young ones swear at it.
    """

    name = "Hollow Idol"
    set_number = 27
    cost = 2
    rarity = "common"
    text = "Deal 2 damage to an opponent."
    flavour = "Old soldiers swear by it; young ones swear at it."
    tags = ('attack',)
    damage = 2

    def apply(self, state, player, target=None):
        target = target or self.first_opponent(state, player)
        if target is None:
            return
        state.damage(target, self.damage)


@register
class BitterChorus(Card):
    """Drain 1 health from each opponent. Heal for the total drained.

    The quiet ones keep the best tricks.
    """

    name = "Bitter Chorus"
    set_number = 28
    cost = 5
    rarity = "common"
    text = "Drain 1 health from each opponent. Heal for the total drained."
    flavour = "The quiet ones keep the best tricks."
    tags = ('attack', 'area', 'drain')
    drain = 1

    def apply(self, state, player, target=None):
        total = 0
        for opponent in state.opponents(player):
            total += state.damage(opponent, self.drain)
        state.heal(player, total)


@register
class FrostDecree(Card):
    """Gain 1 gold.

    Some debts are paid in coin, some in ash.
    """

    name = "Frost Decree"
    set_number = 29
    cost = 2
    rarity = "rare"
    text = "Gain 1 gold."
    flavour = "Some debts are paid in coin, some in ash."
    tags = ('economy',)
    gold = 1

    def apply(self, state, player, target=None):
        state.gain_gold(player, self.gold)


@register
class ThornGambit(Card):
    """Deal 2 damage to an opponent.

    The quiet ones keep the best tricks.
    """

    name = "Thorn Gambit"
    set_number = 30
    cost = 2
    rarity = "uncommon"
    text = "Deal 2 damage to an opponent."
    flavour = "The quiet ones keep the best tricks."
    tags = ('attack',)
    damage = 2

    def apply(self, state, player, target=None):
        target = target or self.first_opponent(state, player)
        if target is None:
            return
        state.damage(target, self.damage)


@register
class GildedSermon(Card):
    """Drain 3 health from an opponent. Heal for the amount drained.

    Bring a lantern, and a spare.
    """

    name = "Gilded Sermon"
    set_number = 31
    cost = 4
    rarity = "common"
    text = "Drain 3 health from an opponent. Heal for the amount drained."
    flavour = "Bring a lantern, and a spare."
    tags = ('attack', 'drain')
    drain = 3

    def apply(self, state, player, target=None):
        target = target or self.first_opponent(state, player)
        if target is None:
            return
        taken = state.damage(target, self.drain)
        state.heal(player, taken)


@register
class ThornDrum(Card):
    """Gain 6 gold. Take 2 damage.

    Every harvest has its tithe.
    """

    name = "Thorn Drum"
    set_number = 32
    cost = 4
    rarity = "common"
    text = "Gain 6 gold. Take 2 damage."
    flavour = "Every harvest has its tithe."
    tags = ('economy', 'risky')
    gold = 6
    self_damage = 2

    def apply(self, state, player, target=None):
        state.gain_gold(player, self.gold)
        state.damage(player, self.self_damage)


@register
class KindledGarland(Card):
    """Heal 6 health.

    Forged twice, trusted once.
    """

    name = "Kindled Garland"
    set_number = 33
    cost = 2
    rarity = "uncommon"
    text = "Heal 6 health."
    flavour = "Forged twice, trusted once."
    tags = ('support',)
    healing = 6

    def apply(self, state, player, target=None):
        state.heal(player, self.healing)


@register
class KindledQuarry(Card):
    """Gain 3 gold and draw 2 cards.

    What the river takes, the river keeps.
    """

    name = "Kindled Quarry"
    set_number = 34
    cost = 0
    rarity = "uncommon"
    text = "Gain 3 gold and draw 2 cards."
    flavour = "What the river takes, the river keeps."
    tags = ('economy', 'card-draw')
    gold = 3
    cards = 2

    def apply(self, state, player, target=None):
        state.gain_gold(player, self.gold)
        state.draw(player, self.cards)


@register
class FrostOmen(Card):
    """Draw 3 cards.

    The quiet ones keep the best tricks.
    """

    name = "Frost Omen"
    set_number = 35
    cost = 3
    rarity = "uncommon"
    text = "Draw 3 cards."
    flavour = "The quiet ones keep the best tricks."
    tags = ('card-draw',)
    cards = 3

    def apply(self, state, player, target=None):
        drawn = state.draw(player, self.cards)
        if drawn < self.cards:
            state.log.append(f"{player.name} ran out of cards")


@register
class UmberEffigy(Card):
    """Drain 3 health from each opponent. Heal for the total drained.

    Every harvest has its tithe.
    """

    name = "Umber Effigy"
    set_number = 36
    cost = 4
    rarity = "uncommon"
    text = "Drain 3 health from each opponent. Heal for the total drained."
    flavour = "Every harvest has its tithe."
    tags = ('attack', 'area', 'drain')
    drain = 3

    def apply(self, state, player, target=None):
        total = 0
        for opponent in state.opponents(player):
            total += state.damage(opponent, self.drain)
        state.heal(player, total)


@register
class BitterWarden(Card):
    """Deal 2 damage to each opponent.

    Some debts are paid in coin, some in ash.
    """

    name = "Bitter Warden"
    set_number = 37
    cost = 1
    rarity = "common"
    text = "Deal 2 damage to each opponent."
    flavour = "Some debts are paid in coin, some in ash."
    tags = ('attack', 'area')
    damage = 2

    def apply(self, state, player, target=None):
        for opponent in state.opponents(player):
            state.damage(opponent, self.damage)


@register
class QuietSermon(Card):
    """Gain 2 shield and heal 1 health.

    Every harvest has its tithe.
    """

    name = "Quiet Sermon"
    set_number = 38
    cost = 5
    rarity = "uncommon"
    text = "Gain 2 shield and heal 1 health."
    flavour = "Every harvest has its tithe."
    tags = ('defence', 'support')
    shield = 2
    healing = 1

    def apply(self, state, player, target=None):
        state.add_shield(player, self.shield)
        state.heal(player, self.healing)


@register
class IronWarden(Card):
    """Deal 2 damage to an opponent.

    It hums when the moon is low.
    """

    name = "Iron Warden"
    set_number = 39
    cost = 0
    rarity = "common"
    text = "Deal 2 damage to an opponent."
    flavour = "It hums when the moon is low."
    tags = ('attack',)
    damage = 2

    def apply(self, state, player, target=None):
        target = target or self.first_opponent(state, player)
        if target is None:
            return
        state.damage(target, self.damage)


@register
class HazelHarvest(Card):
    """Draw 3 cards.

    Bring a lantern, and a spare.
    """

    name = "Hazel Harvest"
    set_number = 40
    cost = 1
    rarity = "uncommon"
    text = "Draw 3 cards."
    flavour = "Bring a lantern, and a spare."
    tags = ('card-draw',)
    cards = 3

    def apply(self, state, player, target=None):
        drawn = state.draw(player, self.cards)
        if drawn < self.cards:
            state.log.append(f"{player.name} ran out of cards")


@register
class ThornLantern(Card):
    """Gain 2 shield and heal 3 health.

    It hums when the moon is low.
    """

    name = "Thorn Lantern"
    set_number = 41
    cost = 3
    rarity = "rare"
    text = "Gain 2 shield and heal 3 health."
    flavour = "It hums when the moon is low."
    tags = ('defence', 'support')
    shield = 2
    healing = 3

    def apply(self, state, player, target=None):
        state.add_shield(player, self.shield)
        state.heal(player, self.healing)


@register
class HazelGambit(Card):
    """Heal 4 health.

    Bring a lantern, and a spare.
    """

    name = "Hazel Gambit"
    set_number = 42
    cost = 5
    rarity = "rare"
    text = "Heal 4 health."
    flavour = "Bring a lantern, and a spare."
    tags = ('support',)
    healing = 4

    def apply(self, state, player, target=None):
        state.heal(player, self.healing)


@register
class CobaltDecree(Card):
    """Deal 3 damage to each opponent.

    The quiet ones keep the best tricks.
    """

    name = "Cobalt Decree"
    set_number = 43
    cost = 1
    rarity = "rare"
    text = "Deal 3 damage to each opponent."
    flavour = "The quiet ones keep the best tricks."
    tags = ('attack', 'area')
    damage = 3

    def apply(self, state, player, target=None):
        for opponent in state.opponents(player):
            state.damage(opponent, self.damage)


@register
class HollowMantle(Card):
    """Take up to 1 gold from each opponent.

    Old soldiers swear by it; young ones swear at it.
    """

    name = "Hollow Mantle"
    set_number = 44
    cost = 2
    rarity = "uncommon"
    text = "Take up to 1 gold from each opponent."
    flavour = "Old soldiers swear by it; young ones swear at it."
    tags = ('economy', 'area')
    levy = 1

    def apply(self, state, player, target=None):
        for opponent in state.opponents(player):
            state.take_gold(opponent, player, self.levy)


@register
class ThornBeacon(Card):
    """Gain 2 gold.

    It hums when the moon is low.
    """

    name = "Thorn Beacon"
    set_number = 45
    cost = 4
    rarity = "common"
    text = "Gain 2 gold."
    flavour = "It hums when the moon is low."
    tags = ('economy',)
    gold = 2

    def apply(self, state, player, target=None):
        state.gain_gold(player, self.gold)


@register
class VesperRelic(Card):
    """Drain 1 health from each opponent. Heal for the total drained.

    Nobody remembers who wrote the first verse.
    """

    name = "Vesper Relic"
    set_number = 46
    cost = 0
    rarity = "common"
    text = "Drain 1 health from each opponent. Heal for the total drained."
    flavour = "Nobody remembers who wrote the first verse."
    tags = ('attack', 'area', 'drain')
    drain = 1

    def apply(self, state, player, target=None):
        total = 0
        for opponent in state.opponents(player):
            total += state.damage(opponent, self.drain)
        state.heal(player, total)


@register
class GraveMantle(Card):
    """Drain 1 health from each opponent. Heal for the total drained.

    Nobody remembers who wrote the first verse.
    """

    name = "Grave Mantle"
    set_number = 47
    cost = 1
    rarity = "common"
    text = "Drain 1 health from each opponent. Heal for the total drained."
    flavour = "Nobody remembers who wrote the first verse."
    tags = ('attack', 'area', 'drain')
    drain = 1

    def apply(self, state, player, target=None):
        total = 0
        for opponent in state.opponents(player):
            total += state.damage(opponent, self.drain)
        state.heal(player, total)


@register
class UmberVigil(Card):
    """Drain 3 health from each opponent. Heal for the total drained.

    Old soldiers swear by it; young ones swear at it.
    """

    name = "Umber Vigil"
    set_number = 48
    cost = 2
    rarity = "common"
    text = "Drain 3 health from each opponent. Heal for the total drained."
    flavour = "Old soldiers swear by it; young ones swear at it."
    tags = ('attack', 'area', 'drain')
    drain = 3

    def apply(self, state, player, target=None):
        total = 0
        for opponent in state.opponents(player):
            total += state.damage(opponent, self.drain)
        state.heal(player, total)


@register
class QuietWarden(Card):
    """Gain 3 gold. Take 2 damage.

    The quiet ones keep the best tricks.
    """

    name = "Quiet Warden"
    set_number = 49
    cost = 1
    rarity = "uncommon"
    text = "Gain 3 gold. Take 2 damage."
    flavour = "The quiet ones keep the best tricks."
    tags = ('economy', 'risky')
    gold = 3
    self_damage = 2

    def apply(self, state, player, target=None):
        state.gain_gold(player, self.gold)
        state.damage(player, self.self_damage)


@register
class IronBargain(Card):
    """Deal 1 damage to each opponent.

    It hums when the moon is low.
    """

    name = "Iron Bargain"
    set_number = 50
    cost = 3
    rarity = "common"
    text = "Deal 1 damage to each opponent."
    flavour = "It hums when the moon is low."
    tags = ('attack', 'area')
    damage = 1

    def apply(self, state, player, target=None):
        for opponent in state.opponents(player):
            state.damage(opponent, self.damage)


@register
class LunarSermon(Card):
    """Take up to 1 gold from each opponent.

    Bring a lantern, and a spare.
    """

    name = "Lunar Sermon"
    set_number = 51
    cost = 4
    rarity = "uncommon"
    text = "Take up to 1 gold from each opponent."
    flavour = "Bring a lantern, and a spare."
    tags = ('economy', 'area')
    levy = 1

    def apply(self, state, player, target=None):
        for opponent in state.opponents(player):
            state.take_gold(opponent, player, self.levy)


@register
class JadeLantern(Card):
    """Take up to 3 gold from each opponent.

    Forged twice, trusted once.
    """

    name = "Jade Lantern"
    set_number = 52
    cost = 3
    rarity = "common"
    text = "Take up to 3 gold from each opponent."
    flavour = "Forged twice, trusted once."
    tags = ('economy', 'area')
    levy = 3

    def apply(self, state, player, target=None):
        for opponent in state.opponents(player):
            state.take_gold(opponent, player, self.levy)


@register
class MireTalon(Card):
    """Deal 4 damage to an opponent.

    Nobody remembers who wrote the first verse.
    """

    name = "Mire Talon"
    set_number = 53
    cost = 4
    rarity = "common"
    text = "Deal 4 damage to an opponent."
    flavour = "Nobody remembers who wrote the first verse."
    tags = ('attack',)
    damage = 4

    def apply(self, state, player, target=None):
        target = target or self.first_opponent(state, player)
        if target is None:
            return
        state.damage(target, self.damage)


@register
class CinderTalon(Card):
    """Gain 2 shield and heal 1 health.

    Old soldiers swear by it; young ones swear at it.
    """

    name = "Cinder Talon"
    set_number = 54
    cost = 2
    rarity = "common"
    text = "Gain 2 shield and heal 1 health."
    flavour = "Old soldiers swear by it; young ones swear at it."
    tags = ('defence', 'support')
    shield = 2
    healing = 1

    def apply(self, state, player, target=None):
        state.add_shield(player, self.shield)
        state.heal(player, self.healing)


@register
class ThornHarvest(Card):
    """Gain 1 gold and draw 2 cards.

    Old soldiers swear by it; young ones swear at it.
    """

    name = "Thorn Harvest"
    set_number = 55
    cost = 3
    rarity = "common"
    text = "Gain 1 gold and draw 2 cards."
    flavour = "Old soldiers swear by it; young ones swear at it."
    tags = ('economy', 'card-draw')
    gold = 1
    cards = 2

    def apply(self, state, player, target=None):
        state.gain_gold(player, self.gold)
        state.draw(player, self.cards)


@register
class NightRelic(Card):
    """Take up to 1 gold from each opponent.

    Nobody remembers who wrote the first verse.
    """

    name = "Night Relic"
    set_number = 56
    cost = 0
    rarity = "rare"
    text = "Take up to 1 gold from each opponent."
    flavour = "Nobody remembers who wrote the first verse."
    tags = ('economy', 'area')
    levy = 1

    def apply(self, state, player, target=None):
        for opponent in state.opponents(player):
            state.take_gold(opponent, player, self.levy)


@register
class CinderLantern(Card):
    """Gain 3 gold. Take 2 damage.

    Every harvest has its tithe.
    """

    name = "Cinder Lantern"
    set_number = 57
    cost = 0
    rarity = "common"
    text = "Gain 3 gold. Take 2 damage."
    flavour = "Every harvest has its tithe."
    tags = ('economy', 'risky')
    gold = 3
    self_damage = 2

    def apply(self, state, player, target=None):
        state.gain_gold(player, self.gold)
        state.damage(player, self.self_damage)


@register
class LunarFurnace(Card):
    """Take up to 1 gold from each opponent.

    The ledger always balances, eventually.
    """

    name = "Lunar Furnace"
    set_number = 58
    cost = 2
    rarity = "rare"
    text = "Take up to 1 gold from each opponent."
    flavour = "The ledger always balances, eventually."
    tags = ('economy', 'area')
    levy = 1

    def apply(self, state, player, target=None):
        for opponent in state.opponents(player):
            state.take_gold(opponent, player, self.levy)


@register
class RustPact(Card):
    """Draw 1 card.

    It hums when the moon is low.
    """

    name = "Rust Pact"
    set_number = 59
    cost = 0
    rarity = "common"
    text = "Draw 1 card."
    flavour = "It hums when the moon is low."
    tags = ('card-draw',)
    cards = 1

    def apply(self, state, player, target=None):
        drawn = state.draw(player, self.cards)
        if drawn < self.cards:
            state.log.append(f"{player.name} ran out of cards")


@register
class OakenIdol(Card):
    """Drain 3 health from each opponent. Heal for the total drained.

    Old soldiers swear by it; young ones swear at it.
    """

    name = "Oaken Idol"
    set_number = 60
    cost = 0
    rarity = "common"
    text = "Drain 3 health from each opponent. Heal for the total drained."
    flavour = "Old soldiers swear by it; young ones swear at it."
    tags = ('attack', 'area', 'drain')
    drain = 3

    def apply(self, state, player, target=None):
        total = 0
        for opponent in state.opponents(player):
            total += state.damage(opponent, self.drain)
        state.heal(player, total)


@register
class DuskOracle(Card):
    """Deal 4 damage to an opponent.

    Old soldiers swear by it; young ones swear at it.
    """

    name = "Dusk Oracle"
    set_number = 61
    cost = 2
    rarity = "uncommon"
    text = "Deal 4 damage to an opponent."
    flavour = "Old soldiers swear by it; young ones swear at it."
    tags = ('attack',)
    damage = 4

    def apply(self, state, player, target=None):
        target = target or self.first_opponent(state, player)
        if target is None:
            return
        state.damage(target, self.damage)


@register
class CinderMirror(Card):
    """Take up to 1 gold from each opponent.

    Nobody remembers who wrote the first verse.
    """

    name = "Cinder Mirror"
    set_number = 62
    cost = 2
    rarity = "uncommon"
    text = "Take up to 1 gold from each opponent."
    flavour = "Nobody remembers who wrote the first verse."
    tags = ('economy', 'area')
    levy = 1

    def apply(self, state, player, target=None):
        for opponent in state.opponents(player):
            state.take_gold(opponent, player, self.levy)


@register
class CobaltBargain(Card):
    """Gain 1 gold.

    Some debts are paid in coin, some in ash.
    """

    name = "Cobalt Bargain"
    set_number = 63
    cost = 1
    rarity = "common"
    text = "Gain 1 gold."
    flavour = "Some debts are paid in coin, some in ash."
    tags = ('economy',)
    gold = 1

    def apply(self, state, player, target=None):
        state.gain_gold(player, self.gold)


@register
class MireQuarry(Card):
    """Deal 7 damage to an opponent.

    It hums when the moon is low.
    """

    name = "Mire Quarry"
    set_number = 64
    cost = 4
    rarity = "common"
    text = "Deal 7 damage to an opponent."
    flavour = "It hums when the moon is low."
    tags = ('attack',)
    damage = 7

    def apply(self, state, player, target=None):
        target = target or self.first_opponent(state, player)
        if target is None:
            return
        state.damage(target, self.damage)


@register
class UmberMantle(Card):
    """Drain 2 health from each opponent. Heal for the total drained.

    Nobody remembers who wrote the first verse.
    """

    name = "Umber Mantle"
    set_number = 65
    cost = 3
    rarity = "common"
    text = "Drain 2 health from each opponent. Heal for the total drained."
    flavour = "Nobody remembers who wrote the first verse."
    tags = ('attack', 'area', 'drain')
    drain = 2

    def apply(self, state, player, target=None):
        total = 0
        for opponent in state.opponents(player):
            total += state.damage(opponent, self.drain)
        state.heal(player, total)


@register
class HollowFurnace(Card):
    """Gain 3 gold and draw 2 cards.

    It hums when the moon is low.
    """

    name = "Hollow Furnace"
    set_number = 66
    cost = 1
    rarity = "uncommon"
    text = "Gain 3 gold and draw 2 cards."
    flavour = "It hums when the moon is low."
    tags = ('economy', 'card-draw')
    gold = 3
    cards = 2

    def apply(self, state, player, target=None):
        state.gain_gold(player, self.gold)
        state.draw(player, self.cards)


@register
class JadeEffigy(Card):
    """Gain 4 gold. Take 2 damage.

    The ledger always balances, eventually.
    """

    name = "Jade Effigy"
    set_number = 67
    cost = 2
    rarity = "rare"
    text = "Gain 4 gold. Take 2 damage."
    flavour = "The ledger always balances, eventually."
    tags = ('economy', 'risky')
    gold = 4
    self_damage = 2

    def apply(self, state, player, target=None):
        state.gain_gold(player, self.gold)
        state.damage(player, self.self_damage)


@register
class IronGambit(Card):
    """Gain 5 gold. Take 2 damage.

    Old soldiers swear by it; young ones swear at it.
    """

    name = "Iron Gambit"
    set_number = 68
    cost = 4
    rarity = "uncommon"
    text = "Gain 5 gold. Take 2 damage."
    flavour = "Old soldiers swear by it; young ones swear at it."
    tags = ('economy', 'risky')
    gold = 5
    self_damage = 2

    def apply(self, state, player, target=None):
        state.gain_gold(player, self.gold)
        state.damage(player, self.self_damage)


@register
class HollowJester(Card):
    """Drain 4 health from an opponent. Heal for the amount drained.

    The ledger always balances, eventually.
    """

    name = "Hollow Jester"
    set_number = 69
    cost = 4
    rarity = "uncommon"
    text = "Drain 4 health from an opponent. Heal for the amount drained."
    flavour = "The ledger always balances, eventually."
    tags = ('attack', 'drain')
    drain = 4

    def apply(self, state, player, target=None):
        target = target or self.first_opponent(state, player)
        if target is None:
            return
        taken = state.damage(target, self.drain)
        state.heal(player, taken)


@register
class CinderFurnace(Card):
    """Gain 6 gold. Take 2 damage.

    What the river takes, the river keeps.
    """

    name = "Cinder Furnace"
    set_number = 70
    cost = 2
    rarity = "common"
    text = "Gain 6 gold. Take 2 damage."
    flavour = "What the river takes, the river keeps."
    tags = ('economy', 'risky')
    gold = 6
    self_damage = 2

    def apply(self, state, player, target=None):
        state.gain_gold(player, self.gold)
        state.damage(player, self.self_damage)


@register
class HazelVigil(Card):
    """Deal 3 damage to an opponent.

    Forged twice, trusted once.
    """

    name = "Hazel Vigil"
    set_number = 71
    cost = 0
    rarity = "uncommon"
    text = "Deal 3 damage to an opponent."
    flavour = "Forged twice, trusted once."
    tags = ('attack',)
    damage = 3

    def apply(self, state, player, target=None):
        target = target or self.first_opponent(state, player)
        if target is None:
            return
        state.damage(target, self.damage)


@register
class CobaltDrum(Card):
    """Deal 4 damage to each opponent.

    Old soldiers swear by it; young ones swear at it.
    """

    name = "Cobalt Drum"
    set_number = 72
    cost = 1
    rarity = "uncommon"
    text = "Deal 4 damage to each opponent."
    flavour = "Old soldiers swear by it; young ones swear at it."
    tags = ('attack', 'area')
    damage = 4

    def apply(self, state, player, target=None):
        for opponent in state.opponents(player):
            state.damage(opponent, self.damage)


@register
class QuietLantern(Card):
    """Deal 3 damage to an opponent.

    Old soldiers swear by it; young ones swear at it.
    """

    name = "Quiet Lantern"
    set_number = 73
    cost = 4
    rarity = "common"
    text = "Deal 3 damage to an opponent."
    flavour = "Old soldiers swear by it; young ones swear at it."
    tags = ('attack',)
    damage = 3

    def apply(self, state, player, target=None):
        target = target or self.first_opponent(state, player)
        if target is None:
            return
        state.damage(target, self.damage)


@register
class PaleWarden(Card):
    """Deal 3 damage to an opponent.

    Nobody remembers who wrote the first verse.
    """

    name = "Pale Warden"
    set_number = 74
    cost = 5
    rarity = "uncommon"
    text = "Deal 3 damage to an opponent."
    flavour = "Nobody remembers who wrote the first verse."
    tags = ('attack',)
    damage = 3

    def apply(self, state, player, target=None):
        target = target or self.first_opponent(state, player)
        if target is None:
            return
        state.damage(target, self.damage)


@register
class IronSermon(Card):
    """Take up to 1 gold from each opponent.

    Bring a lantern, and a spare.
    """

    name = "Iron Sermon"
    set_number = 75
    cost = 4
    rarity = "uncommon"
    text = "Take up to 1 gold from each opponent."
    flavour = "Bring a lantern, and a spare."
    tags = ('economy', 'area')
    levy = 1

    def apply(self, state, player, target=None):
        for opponent in state.opponents(player):
            state.take_gold(opponent, player, self.levy)


@register
class KindledCairn(Card):
    """Gain 4 shield and heal 1 health.

    Old soldiers swear by it; young ones swear at it.
    """

    name = "Kindled Cairn"
    set_number = 76
    cost = 1
    rarity = "uncommon"
    text = "Gain 4 shield and heal 1 health."
    flavour = "Old soldiers swear by it; young ones swear at it."
    tags = ('defence', 'support')
    shield = 4
    healing = 1

    def apply(self, state, player, target=None):
        state.add_shield(player, self.shield)
        state.heal(player, self.healing)


@register
class DuskGambit(Card):
    """Gain 4 gold. Take 2 damage.

    It hums when the moon is low.
    """

    name = "Dusk Gambit"
    set_number = 77
    cost = 3
    rarity = "rare"
    text = "Gain 4 gold. Take 2 damage."
    flavour = "It hums when the moon is low."
    tags = ('economy', 'risky')
    gold = 4
    self_damage = 2

    def apply(self, state, player, target=None):
        state.gain_gold(player, self.gold)
        state.damage(player, self.self_damage)


@register
class BitterOracle(Card):
    """Draw 1 card.

    It hums when the moon is low.
    """

    name = "Bitter Oracle"
    set_number = 78
    cost = 2
    rarity = "uncommon"
    text = "Draw 1 card."
    flavour = "It hums when the moon is low."
    tags = ('card-draw',)
    cards = 1

    def apply(self, state, player, target=None):
        drawn = state.draw(player, self.cards)
        if drawn < self.cards:
            state.log.append(f"{player.name} ran out of cards")


@register
class RustWarden(Card):
    """Drain 1 health from each opponent. Heal for the total drained.

    Bring a lantern, and a spare.
    """

    name = "Rust Warden"
    set_number = 79
    cost = 5
    rarity = "uncommon"
    text = "Drain 1 health from each opponent. Heal for the total drained."
    flavour = "Bring a lantern, and a spare."
    tags = ('attack', 'area', 'drain')
    drain = 1

    def apply(self, state, player, target=None):
        total = 0
        for opponent in state.opponents(player):
            total += state.damage(opponent, self.drain)
        state.heal(player, total)


@register
class VesperPact(Card):
    """Drain 1 health from each opponent. Heal for the total drained.

    Bring a lantern, and a spare.
    """

    name = "Vesper Pact"
    set_number = 80
    cost = 0
    rarity = "rare"
    text = "Drain 1 health from each opponent. Heal for the total drained."
    flavour = "Bring a lantern, and a spare."
    tags = ('attack', 'area', 'drain')
    drain = 1

    def apply(self, state, player, target=None):
        total = 0
        for opponent in state.opponents(player):
            total += state.damage(opponent, self.drain)
        state.heal(player, total)


@register
class DuskIdol(Card):
    """Draw 1 card.

    Some debts are paid in coin, some in ash.
    """

    name = "Dusk Idol"
    set_number = 81
    cost = 0
    rarity = "common"
    text = "Draw 1 card."
    flavour = "Some debts are paid in coin, some in ash."
    tags = ('card-draw',)
    cards = 1

    def apply(self, state, player, target=None):
        drawn = state.draw(player, self.cards)
        if drawn < self.cards:
            state.log.append(f"{player.name} ran out of cards")


@register
class PaleFable(Card):
    """Gain 3 shield.

    Bring a lantern, and a spare.
    """

    name = "Pale Fable"
    set_number = 82
    cost = 3
    rarity = "uncommon"
    text = "Gain 3 shield."
    flavour = "Bring a lantern, and a spare."
    tags = ('defence',)
    shield = 3

    def apply(self, state, player, target=None):
        state.add_shield(player, self.shield)


@register
class FrostSermon(Card):
    """Drain 3 health from an opponent. Heal for the amount drained.

    It hums when the moon is low.
    """

    name = "Frost Sermon"
    set_number = 83
    cost = 4
    rarity = "common"
    text = "Drain 3 health from an opponent. Heal for the amount drained."
    flavour = "It hums when the moon is low."
    tags = ('attack', 'drain')
    drain = 3

    def apply(self, state, player, target=None):
        target = target or self.first_opponent(state, player)
        if target is None:
            return
        taken = state.damage(target, self.drain)
        state.heal(player, taken)


@register
class CinderFable(Card):
    """Heal 8 health.

    The quiet ones keep the best tricks.
    """

    name = "Cinder Fable"
    set_number = 84
    cost = 0
    rarity = "common"
    text = "Heal 8 health."
    flavour = "The quiet ones keep the best tricks."
    tags = ('support',)
    healing = 8

    def apply(self, state, player, target=None):
        state.heal(player, self.healing)


@register
class HollowAnvil(Card):
    """Drain 2 health from each opponent. Heal for the total drained.

    Nobody remembers who wrote the first verse.
    """

    name = "Hollow Anvil"
    set_number = 85
    cost = 5
    rarity = "common"
    text = "Drain 2 health from each opponent. Heal for the total drained."
    flavour = "Nobody remembers who wrote the first verse."
    tags = ('attack', 'area', 'drain')
    drain = 2

    def apply(self, state, player, target=None):
        total = 0
        for opponent in state.opponents(player):
            total += state.damage(opponent, self.drain)
        state.heal(player, total)


@register
class MireMantle(Card):
    """Gain 4 gold.

    The ledger always balances, eventually.
    """

    name = "Mire Mantle"
    set_number = 86
    cost = 1
    rarity = "rare"
    text = "Gain 4 gold."
    flavour = "The ledger always balances, eventually."
    tags = ('economy',)
    gold = 4

    def apply(self, state, player, target=None):
        state.gain_gold(player, self.gold)


@register
class IvoryDrum(Card):
    """Gain 4 shield.

    Old soldiers swear by it; young ones swear at it.
    """

    name = "Ivory Drum"
    set_number = 87
    cost = 4
    rarity = "common"
    text = "Gain 4 shield."
    flavour = "Old soldiers swear by it; young ones swear at it."
    tags = ('defence',)
    shield = 4

    def apply(self, state, player, target=None):
        state.add_shield(player, self.shield)


@register
class SaltFurnace(Card):
    """Gain 6 shield.

    Bring a lantern, and a spare.
    """

    name = "Salt Furnace"
    set_number = 88
    cost = 5
    rarity = "common"
    text = "Gain 6 shield."
    flavour = "Bring a lantern, and a spare."
    tags = ('defence',)
    shield = 6

    def apply(self, state, player, target=None):
        state.add_shield(player, self.shield)


@register
class QuietFable(Card):
    """Drain 1 health from each opponent. Heal for the total drained.

    Nobody remembers who wrote the first verse.
    """

    name = "Quiet Fable"
    set_number = 89
    cost = 1
    rarity = "common"
    text = "Drain 1 health from each opponent. Heal for the total drained."
    flavour = "Nobody remembers who wrote the first verse."
    tags = ('attack', 'area', 'drain')
    drain = 1

    def apply(self, state, player, target=None):
        total = 0
        for opponent in state.opponents(player):
            total += state.damage(opponent, self.drain)
        state.heal(player, total)


@register
class VesperDrum(Card):
    """Take up to 1 gold from each opponent.

    Bring a lantern, and a spare.
    """

    name = "Vesper Drum"
    set_number = 90
    cost = 0
    rarity = "uncommon"
    text = "Take up to 1 gold from each opponent."
    flavour = "Bring a lantern, and a spare."
    tags = ('economy', 'area')
    levy = 1

    def apply(self, state, player, target=None):
        for opponent in state.opponents(player):
            state.take_gold(opponent, player, self.levy)


@register
class ThornQuarry(Card):
    """Deal 3 damage to an opponent.

    Every harvest has its tithe.
    """

    name = "Thorn Quarry"
    set_number = 91
    cost = 5
    rarity = "uncommon"
    text = "Deal 3 damage to an opponent."
    flavour = "Every harvest has its tithe."
    tags = ('attack',)
    damage = 3

    def apply(self, state, player, target=None):
        target = target or self.first_opponent(state, player)
        if target is None:
            return
        state.damage(target, self.damage)


@register
class NightGambit(Card):
    """Gain 4 gold. Take 2 damage.

    Forged twice, trusted once.
    """

    name = "Night Gambit"
    set_number = 92
    cost = 0
    rarity = "common"
    text = "Gain 4 gold. Take 2 damage."
    flavour = "Forged twice, trusted once."
    tags = ('economy', 'risky')
    gold = 4
    self_damage = 2

    def apply(self, state, player, target=None):
        state.gain_gold(player, self.gold)
        state.damage(player, self.self_damage)


@register
class JadeWarden(Card):
    """Gain 4 shield and heal 4 health.

    Old soldiers swear by it; young ones swear at it.
    """

    name = "Jade Warden"
    set_number = 93
    cost = 4
    rarity = "uncommon"
    text = "Gain 4 shield and heal 4 health."
    flavour = "Old soldiers swear by it; young ones swear at it."
    tags = ('defence', 'support')
    shield = 4
    healing = 4

    def apply(self, state, player, target=None):
        state.add_shield(player, self.shield)
        state.heal(player, self.healing)


@register
class BitterQuarry(Card):
    """Take up to 1 gold from each opponent.

    The quiet ones keep the best tricks.
    """

    name = "Bitter Quarry"
    set_number = 94
    cost = 4
    rarity = "rare"
    text = "Take up to 1 gold from each opponent."
    flavour = "The quiet ones keep the best tricks."
    tags = ('economy', 'area')
    levy = 1

    def apply(self, state, player, target=None):
        for opponent in state.opponents(player):
            state.take_gold(opponent, player, self.levy)


@register
class RustGarland(Card):
    """Gain 6 gold. Take 2 damage.

    The ledger always balances, eventually.
    """

    name = "Rust Garland"
    set_number = 95
    cost = 3
    rarity = "common"
    text = "Gain 6 gold. Take 2 damage."
    flavour = "The ledger always balances, eventually."
    tags = ('economy', 'risky')
    gold = 6
    self_damage = 2

    def apply(self, state, player, target=None):
        state.gain_gold(player, self.gold)
        state.damage(player, self.self_damage)


@register
class PaleIdol(Card):
    """Gain 4 gold. Take 2 damage.

    Bring a lantern, and a spare.
    """

    name = "Pale Idol"
    set_number = 96
    cost = 3
    rarity = "common"
    text = "Gain 4 gold. Take 2 damage."
    flavour = "Bring a lantern, and a spare."
    tags = ('economy', 'risky')
    gold = 4
    self_damage = 2

    def apply(self, state, player, target=None):
        state.gain_gold(player, self.gold)
        state.damage(player, self.self_damage)


@register
class ThornWarden(Card):
    """Gain 3 shield and heal 3 health.

    The ledger always balances, eventually.
    """

    name = "Thorn Warden"
    set_number = 97
    cost = 3
    rarity = "uncommon"
    text = "Gain 3 shield and heal 3 health."
    flavour = "The ledger always balances, eventually."
    tags = ('defence', 'support')
    shield = 3
    healing = 3

    def apply(self, state, player, target=None):
        state.add_shield(player, self.shield)
        state.heal(player, self.healing)


@register
class UmberDecree(Card):
    """Drain 3 health from an opponent. Heal for the amount drained.

    The ledger always balances, eventually.
    """

    name = "Umber Decree"
    set_number = 98
    cost = 1
    rarity = "common"
    text = "Drain 3 health from an opponent. Heal for the amount drained."
    flavour = "The ledger always balances, eventually."
    tags = ('attack', 'drain')
    drain = 3

    def apply(self, state, player, target=None):
        target = target or self.first_opponent(state, player)
        if target is None:
            return
        taken = state.damage(target, self.drain)
        state.heal(player, taken)


@register
class OakenLedger(Card):
    """Gain 4 shield.

    Some debts are paid in coin, some in ash.
    """

    name = "Oaken Ledger"
    set_number = 99
    cost = 1
    rarity = "common"
    text = "Gain 4 shield."
    flavour = "Some debts are paid in coin, some in ash."
    tags = ('defence',)
    shield = 4

    def apply(self, state, player, target=None):
        state.add_shield(player, self.shield)


@register
class HazelRelic(Card):
    """Deal 7 damage to an opponent.

    Bring a lantern, and a spare.
    """

    name = "Hazel Relic"
    set_number = 100
    cost = 4
    rarity = "common"
    text = "Deal 7 damage to an opponent."
    flavour = "Bring a lantern, and a spare."
    tags = ('attack',)
    damage = 7

    def apply(self, state, player, target=None):
        target = target or self.first_opponent(state, player)
        if target is None:
            return
        state.damage(target, self.damage)


@register
class FrostLedger(Card):
    """Gain 4 shield.

    Old soldiers swear by it; young ones swear at it.
    """

    name = "Frost Ledger"
    set_number = 101
    cost = 1
    rarity = "common"
    text = "Gain 4 shield."
    flavour = "Old soldiers swear by it; young ones swear at it."
    tags = ('defence',)
    shield = 4

    def apply(self, state, player, target=None):
        state.add_shield(player, self.shield)


@register
class IronGarland(Card):
    """Deal 3 damage to each opponent.

    What the river takes, the river keeps.
    """

    name = "Iron Garland"
    set_number = 102
    cost = 2
    rarity = "common"
    text = "Deal 3 damage to each opponent."
    flavour = "What the river takes, the river keeps."
    tags = ('attack', 'area')
    damage = 3

    def apply(self, state, player, target=None):
        for opponent in state.opponents(player):
            state.damage(opponent, self.damage)


@register
class DrownedRelic(Card):
    """Gain 4 gold. Take 2 damage.

    The ledger always balances, eventually.
    """

    name = "Drowned Relic"
    set_number = 103
    cost = 1
    rarity = "rare"
    text = "Gain 4 gold. Take 2 damage."
    flavour = "The ledger always balances, eventually."
    tags = ('economy', 'risky')
    gold = 4
    self_damage = 2

    def apply(self, state, player, target=None):
        state.gain_gold(player, self.gold)
        state.damage(player, self.self_damage)


@register
class AshenBargain(Card):
    """Gain 3 gold. Take 2 damage.

    Some debts are paid in coin, some in ash.
    """

    name = "Ashen Bargain"
    set_number = 104
    cost = 1
    rarity = "rare"
    text = "Gain 3 gold. Take 2 damage."
    flavour = "Some debts are paid in coin, some in ash."
    tags = ('economy', 'risky')
    gold = 3
    self_damage = 2

    def apply(self, state, player, target=None):
        state.gain_gold(player, self.gold)
        state.damage(player, self.self_damage)


@register
class BitterFable(Card):
    """Draw 1 card.

    Every harvest has its tithe.
    """

    name = "Bitter Fable"
    set_number = 105
    cost = 2
    rarity = "uncommon"
    text = "Draw 1 card."
    flavour = "Every harvest has its tithe."
    tags = ('card-draw',)
    cards = 1

    def apply(self, state, player, target=None):
        drawn = state.draw(player, self.cards)
        if drawn < self.cards:
            state.log.append(f"{player.name} ran out of cards")


@register
class BitterHarvest(Card):
    """Gain 5 gold.

    Some debts are paid in coin, some in ash.
    """

    name = "Bitter Harvest"
    set_number = 106
    cost = 5
    rarity = "uncommon"
    text = "Gain 5 gold."
    flavour = "Some debts are paid in coin, some in ash."
    tags = ('economy',)
    gold = 5

    def apply(self, state, player, target=None):
        state.gain_gold(player, self.gold)


@register
class AmberLantern(Card):
    """Gain 6 shield.

    Every harvest has its tithe.
    """

    name = "Amber Lantern"
    set_number = 107
    cost = 5
    rarity = "uncommon"
    text = "Gain 6 shield."
    flavour = "Every harvest has its tithe."
    tags = ('defence',)
    shield = 6

    def apply(self, state, player, target=None):
        state.add_shield(player, self.shield)


@register
class FeralOmen(Card):
    """Deal 3 damage to an opponent.

    Nobody remembers who wrote the first verse.
    """

    name = "Feral Omen"
    set_number = 108
    cost = 4
    rarity = "common"
    text = "Deal 3 damage to an opponent."
    flavour = "Nobody remembers who wrote the first verse."
    tags = ('attack',)
    damage = 3

    def apply(self, state, player, target=None):
        target = target or self.first_opponent(state, player)
        if target is None:
            return
        state.damage(target, self.damage)


@register
class QuietBanner(Card):
    """Deal 1 damage to each opponent.

    What the river takes, the river keeps.
    """

    name = "Quiet Banner"
    set_number = 109
    cost = 4
    rarity = "rare"
    text = "Deal 1 damage to each opponent."
    flavour = "What the river takes, the river keeps."
    tags = ('attack', 'area')
    damage = 1

    def apply(self, state, player, target=None):
        for opponent in state.opponents(player):
            state.damage(opponent, self.damage)


@register
class CobaltFurnace(Card):
    """Gain 2 gold and draw 1 card.

    Every harvest has its tithe.
    """

    name = "Cobalt Furnace"
    set_number = 110
    cost = 0
    rarity = "common"
    text = "Gain 2 gold and draw 1 card."
    flavour = "Every harvest has its tithe."
    tags = ('economy', 'card-draw')
    gold = 2
    cards = 1

    def apply(self, state, player, target=None):
        state.gain_gold(player, self.gold)
        state.draw(player, self.cards)


@register
class PaleBanner(Card):
    """Gain 1 gold and draw 1 card.

    The ledger always balances, eventually.
    """

    name = "Pale Banner"
    set_number = 111
    cost = 4
    rarity = "common"
    text = "Gain 1 gold and draw 1 card."
    flavour = "The ledger always balances, eventually."
    tags = ('economy', 'card-draw')
    gold = 1
    cards = 1

    def apply(self, state, player, target=None):
        state.gain_gold(player, self.gold)
        state.draw(player, self.cards)


@register
class ThornHymn(Card):
    """Drain 2 health from an opponent. Heal for the amount drained.

    The ledger always balances, eventually.
    """

    name = "Thorn Hymn"
    set_number = 112
    cost = 4
    rarity = "rare"
    text = "Drain 2 health from an opponent. Heal for the amount drained."
    flavour = "The ledger always balances, eventually."
    tags = ('attack', 'drain')
    drain = 2

    def apply(self, state, player, target=None):
        target = target or self.first_opponent(state, player)
        if target is None:
            return
        taken = state.damage(target, self.drain)
        state.heal(player, taken)


@register
class MireEffigy(Card):
    """Gain 2 shield.

    Forged twice, trusted once.
    """

    name = "Mire Effigy"
    set_number = 113
    cost = 5
    rarity = "rare"
    text = "Gain 2 shield."
    flavour = "Forged twice, trusted once."
    tags = ('defence',)
    shield = 2

    def apply(self, state, player, target=None):
        state.add_shield(player, self.shield)


@register
class RustSermon(Card):
    """Drain 1 health from an opponent. Heal for the amount drained.

    Every harvest has its tithe.
    """

    name = "Rust Sermon"
    set_number = 114
    cost = 1
    rarity = "rare"
    text = "Drain 1 health from an opponent. Heal for the amount drained."
    flavour = "Every harvest has its tithe."
    tags = ('attack', 'drain')
    drain = 1

    def apply(self, state, player, target=None):
        target = target or self.first_opponent(state, player)
        if target is None:
            return
        taken = state.damage(target, self.drain)
        state.heal(player, taken)


@register
class MireJester(Card):
    """Deal 2 damage to each opponent.

    Bring a lantern, and a spare.
    """

    name = "Mire Jester"
    set_number = 115
    cost = 4
    rarity = "common"
    text = "Deal 2 damage to each opponent."
    flavour = "Bring a lantern, and a spare."
    tags = ('attack', 'area')
    damage = 2

    def apply(self, state, player, target=None):
        for opponent in state.opponents(player):
            state.damage(opponent, self.damage)


@register
class EmberTithe(Card):
    """Drain 2 health from each opponent. Heal for the total drained.

    Every harvest has its tithe.
    """

    name = "Ember Tithe"
    set_number = 116
    cost = 3
    rarity = "rare"
    text = "Drain 2 health from each opponent. Heal for the total drained."
    flavour = "Every harvest has its tithe."
    tags = ('attack', 'area', 'drain')
    drain = 2

    def apply(self, state, player, target=None):
        for opponent in state.opponents(player):
            taken = state.damage(opponent, self.drain)
        state.heal(player, taken)


@register
class LunarGambit(Card):
    """Draw 1 card.

    Some debts are paid in coin, some in ash.
    """

    name = "Lunar Gambit"
    set_number = 117
    cost = 1
    rarity = "rare"
    text = "Draw 1 card."
    flavour = "Some debts are paid in coin, some in ash."
    tags = ('card-draw',)
    cards = 1

    def apply(self, state, player, target=None):
        drawn = state.draw(player, self.cards)
        if drawn < self.cards:
            state.log.append(f"{player.name} ran out of cards")


@register
class IronJester(Card):
    """Gain 3 shield.

    Bring a lantern, and a spare.
    """

    name = "Iron Jester"
    set_number = 118
    cost = 0
    rarity = "uncommon"
    text = "Gain 3 shield."
    flavour = "Bring a lantern, and a spare."
    tags = ('defence',)
    shield = 3

    def apply(self, state, player, target=None):
        state.add_shield(player, self.shield)


@register
class AmberMirror(Card):
    """Deal 3 damage to each opponent.

    The quiet ones keep the best tricks.
    """

    name = "Amber Mirror"
    set_number = 119
    cost = 0
    rarity = "common"
    text = "Deal 3 damage to each opponent."
    flavour = "The quiet ones keep the best tricks."
    tags = ('attack', 'area')
    damage = 3

    def apply(self, state, player, target=None):
        for opponent in state.opponents(player):
            state.damage(opponent, self.damage)


@register
class UmberFurnace(Card):
    """Drain 2 health from each opponent. Heal for the total drained.

    Bring a lantern, and a spare.
    """

    name = "Umber Furnace"
    set_number = 120
    cost = 5
    rarity = "common"
    text = "Drain 2 health from each opponent. Heal for the total drained."
    flavour = "Bring a lantern, and a spare."
    tags = ('attack', 'area', 'drain')
    drain = 2

    def apply(self, state, player, target=None):
        total = 0
        for opponent in state.opponents(player):
            total += state.damage(opponent, self.drain)
        state.heal(player, total)


@register
class JadeCairn(Card):
    """Gain 2 shield and heal 4 health.

    It hums when the moon is low.
    """

    name = "Jade Cairn"
    set_number = 121
    cost = 2
    rarity = "uncommon"
    text = "Gain 2 shield and heal 4 health."
    flavour = "It hums when the moon is low."
    tags = ('defence', 'support')
    shield = 2
    healing = 4

    def apply(self, state, player, target=None):
        state.add_shield(player, self.shield)
        state.heal(player, self.healing)


@register
class FrostGarland(Card):
    """Gain 4 gold. Take 2 damage.

    What the river takes, the river keeps.
    """

    name = "Frost Garland"
    set_number = 122
    cost = 3
    rarity = "common"
    text = "Gain 4 gold. Take 2 damage."
    flavour = "What the river takes, the river keeps."
    tags = ('economy', 'risky')
    gold = 4
    self_damage = 2

    def apply(self, state, player, target=None):
        state.gain_gold(player, self.gold)
        state.damage(player, self.self_damage)


@register
class DuskQuarry(Card):
    """Heal 3 health.

    It hums when the moon is low.
    """

    name = "Dusk Quarry"
    set_number = 123
    cost = 3
    rarity = "uncommon"
    text = "Heal 3 health."
    flavour = "It hums when the moon is low."
    tags = ('support',)
    healing = 3

    def apply(self, state, player, target=None):
        state.heal(player, self.healing)


@register
class RustBargain(Card):
    """Drain 3 health from an opponent. Heal for the amount drained.

    Every harvest has its tithe.
    """

    name = "Rust Bargain"
    set_number = 124
    cost = 0
    rarity = "uncommon"
    text = "Drain 3 health from an opponent. Heal for the amount drained."
    flavour = "Every harvest has its tithe."
    tags = ('attack', 'drain')
    drain = 3

    def apply(self, state, player, target=None):
        target = target or self.first_opponent(state, player)
        if target is None:
            return
        taken = state.damage(target, self.drain)
        state.heal(player, taken)


@register
class SaltOracle(Card):
    """Gain 6 gold. Take 2 damage.

    Every harvest has its tithe.
    """

    name = "Salt Oracle"
    set_number = 125
    cost = 4
    rarity = "rare"
    text = "Gain 6 gold. Take 2 damage."
    flavour = "Every harvest has its tithe."
    tags = ('economy', 'risky')
    gold = 6
    self_damage = 2

    def apply(self, state, player, target=None):
        state.gain_gold(player, self.gold)
        state.damage(player, self.self_damage)


@register
class BitterFurnace(Card):
    """Gain 1 gold and draw 2 cards.

    What the river takes, the river keeps.
    """

    name = "Bitter Furnace"
    set_number = 126
    cost = 0
    rarity = "common"
    text = "Gain 1 gold and draw 2 cards."
    flavour = "What the river takes, the river keeps."
    tags = ('economy', 'card-draw')
    gold = 1
    cards = 2

    def apply(self, state, player, target=None):
        state.gain_gold(player, self.gold)
        state.draw(player, self.cards)


@register
class UmberFable(Card):
    """Gain 4 gold.

    Old soldiers swear by it; young ones swear at it.
    """

    name = "Umber Fable"
    set_number = 127
    cost = 1
    rarity = "rare"
    text = "Gain 4 gold."
    flavour = "Old soldiers swear by it; young ones swear at it."
    tags = ('economy',)
    gold = 4

    def apply(self, state, player, target=None):
        state.gain_gold(player, self.gold)


@register
class HazelFurnace(Card):
    """Gain 6 shield.

    It hums when the moon is low.
    """

    name = "Hazel Furnace"
    set_number = 128
    cost = 0
    rarity = "uncommon"
    text = "Gain 6 shield."
    flavour = "It hums when the moon is low."
    tags = ('defence',)
    shield = 6

    def apply(self, state, player, target=None):
        state.add_shield(player, self.shield)


@register
class PaleAnvil(Card):
    """Drain 1 health from each opponent. Heal for the total drained.

    The quiet ones keep the best tricks.
    """

    name = "Pale Anvil"
    set_number = 129
    cost = 4
    rarity = "uncommon"
    text = "Drain 1 health from each opponent. Heal for the total drained."
    flavour = "The quiet ones keep the best tricks."
    tags = ('attack', 'area', 'drain')
    drain = 1

    def apply(self, state, player, target=None):
        total = 0
        for opponent in state.opponents(player):
            total += state.damage(opponent, self.drain)
        state.heal(player, total)


@register
class NightCairn(Card):
    """Gain 4 shield and heal 1 health.

    Old soldiers swear by it; young ones swear at it.
    """

    name = "Night Cairn"
    set_number = 130
    cost = 5
    rarity = "rare"
    text = "Gain 4 shield and heal 1 health."
    flavour = "Old soldiers swear by it; young ones swear at it."
    tags = ('defence', 'support')
    shield = 4
    healing = 1

    def apply(self, state, player, target=None):
        state.add_shield(player, self.shield)
        state.heal(player, self.healing)


@register
class RustHymn(Card):
    """Gain 4 gold.

    Every harvest has its tithe.
    """

    name = "Rust Hymn"
    set_number = 131
    cost = 1
    rarity = "rare"
    text = "Gain 4 gold."
    flavour = "Every harvest has its tithe."
    tags = ('economy',)
    gold = 4

    def apply(self, state, player, target=None):
        state.gain_gold(player, self.gold)


@register
class AmberPact(Card):
    """Drain 3 health from each opponent. Heal for the total drained.

    Nobody remembers who wrote the first verse.
    """

    name = "Amber Pact"
    set_number = 132
    cost = 5
    rarity = "common"
    text = "Drain 3 health from each opponent. Heal for the total drained."
    flavour = "Nobody remembers who wrote the first verse."
    tags = ('attack', 'area', 'drain')
    drain = 3

    def apply(self, state, player, target=None):
        total = 0
        for opponent in state.opponents(player):
            total += state.damage(opponent, self.drain)
        state.heal(player, total)


@register
class UmberBargain(Card):
    """Draw 2 cards.

    What the river takes, the river keeps.
    """

    name = "Umber Bargain"
    set_number = 133
    cost = 1
    rarity = "rare"
    text = "Draw 2 cards."
    flavour = "What the river takes, the river keeps."
    tags = ('card-draw',)
    cards = 2

    def apply(self, state, player, target=None):
        drawn = state.draw(player, self.cards)
        if drawn < self.cards:
            state.log.append(f"{player.name} ran out of cards")


@register
class CobaltPact(Card):
    """Gain 5 gold.

    Old soldiers swear by it; young ones swear at it.
    """

    name = "Cobalt Pact"
    set_number = 134
    cost = 1
    rarity = "common"
    text = "Gain 5 gold."
    flavour = "Old soldiers swear by it; young ones swear at it."
    tags = ('economy',)
    gold = 5

    def apply(self, state, player, target=None):
        state.gain_gold(player, self.gold)


@register
class HazelBeacon(Card):
    """Take up to 2 gold from each opponent.

    The ledger always balances, eventually.
    """

    name = "Hazel Beacon"
    set_number = 135
    cost = 1
    rarity = "rare"
    text = "Take up to 2 gold from each opponent."
    flavour = "The ledger always balances, eventually."
    tags = ('economy', 'area')
    levy = 2

    def apply(self, state, player, target=None):
        for opponent in state.opponents(player):
            state.take_gold(opponent, player, self.levy)


@register
class CinderHymn(Card):
    """Deal 1 damage to each opponent.

    Some debts are paid in coin, some in ash.
    """

    name = "Cinder Hymn"
    set_number = 136
    cost = 3
    rarity = "rare"
    text = "Deal 1 damage to each opponent."
    flavour = "Some debts are paid in coin, some in ash."
    tags = ('attack', 'area')
    damage = 1

    def apply(self, state, player, target=None):
        for opponent in state.opponents(player):
            state.damage(opponent, self.damage)


@register
class MireGambit(Card):
    """Heal 5 health.

    The quiet ones keep the best tricks.
    """

    name = "Mire Gambit"
    set_number = 137
    cost = 5
    rarity = "rare"
    text = "Heal 5 health."
    flavour = "The quiet ones keep the best tricks."
    tags = ('support',)
    healing = 5

    def apply(self, state, player, target=None):
        state.heal(player, self.healing)


@register
class HollowWarden(Card):
    """Take up to 3 gold from each opponent.

    Bring a lantern, and a spare.
    """

    name = "Hollow Warden"
    set_number = 138
    cost = 0
    rarity = "common"
    text = "Take up to 3 gold from each opponent."
    flavour = "Bring a lantern, and a spare."
    tags = ('economy', 'area')
    levy = 3

    def apply(self, state, player, target=None):
        for opponent in state.opponents(player):
            state.take_gold(opponent, player, self.levy)


@register
class GraveRelic(Card):
    """Drain 3 health from an opponent. Heal for the amount drained.

    Some debts are paid in coin, some in ash.
    """

    name = "Grave Relic"
    set_number = 139
    cost = 5
    rarity = "rare"
    text = "Drain 3 health from an opponent. Heal for the amount drained."
    flavour = "Some debts are paid in coin, some in ash."
    tags = ('attack', 'drain')
    drain = 3

    def apply(self, state, player, target=None):
        target = target or self.first_opponent(state, player)
        if target is None:
            return
        taken = state.damage(target, self.drain)
        state.heal(player, taken)


@register
class KindledHymn(Card):
    """Gain 5 gold.

    Nobody remembers who wrote the first verse.
    """

    name = "Kindled Hymn"
    set_number = 140
    cost = 2
    rarity = "rare"
    text = "Gain 5 gold."
    flavour = "Nobody remembers who wrote the first verse."
    tags = ('economy',)
    gold = 5

    def apply(self, state, player, target=None):
        state.gain_gold(player, self.gold)


@register
class GildedBanner(Card):
    """Draw 2 cards.

    What the river takes, the river keeps.
    """

    name = "Gilded Banner"
    set_number = 141
    cost = 3
    rarity = "common"
    text = "Draw 2 cards."
    flavour = "What the river takes, the river keeps."
    tags = ('card-draw',)
    cards = 2

    def apply(self, state, player, target=None):
        drawn = state.draw(player, self.cards)
        if drawn < self.cards:
            state.log.append(f"{player.name} ran out of cards")
