#!/usr/bin/env python3
"""Generate the card-game fixture for change-deep-in-long-file.

Writes (all under change-deep-in-long-file/):
  fixture/cardgame/cards.py         3,000+ lines, one class per card; Ember Tithe has a bug
  solution/cardgame/cards.py        the same file with Ember Tithe fixed
  check/fingerprints.json           state after playing every card, from the ORIGINAL file
  check/target_span.json            first/last line (1-based) of the EmberTithe class in the fixture

state.py, tests and the rest of the fixture are hand-written and live in the fixture.
Deterministic: fixed word lists and a fixed seed.
"""
import json
import os
import random
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
TASK = os.path.join(os.path.dirname(HERE), "change-deep-in-long-file")
TARGET = "Ember Tithe"
TARGET_INDEX = 115  # position among the cards; puts the class around line 2,550 of ~3,150

ADJECTIVES = [
    "Ashen", "Brass", "Cinder", "Dusk", "Feral", "Gilded", "Hollow", "Iron", "Jade", "Kindled",
    "Lunar", "Mire", "Night", "Oaken", "Pale", "Quiet", "Rust", "Salt", "Thorn", "Umber",
    "Vesper", "Wild", "Amber", "Bitter", "Cobalt", "Drowned", "Frost", "Grave", "Hazel", "Ivory",
]
NOUNS = [
    "Bargain", "Banner", "Chorus", "Decree", "Effigy", "Furnace", "Gambit", "Harvest", "Idol", "Jester",
    "Ledger", "Mantle", "Omen", "Pact", "Quarry", "Relic", "Sermon", "Talon", "Vigil", "Warden",
    "Anvil", "Beacon", "Cairn", "Drum", "Fable", "Garland", "Hymn", "Lantern", "Mirror", "Oracle",
]
RARITIES = ["common", "common", "common", "uncommon", "uncommon", "rare"]

FLAVOUR = [
    "Old soldiers swear by it; young ones swear at it.",
    "The ledger always balances, eventually.",
    "Nobody remembers who wrote the first verse.",
    "Some debts are paid in coin, some in ash.",
    "It hums when the moon is low.",
    "Bring a lantern, and a spare.",
    "Every harvest has its tithe.",
    "The quiet ones keep the best tricks.",
    "Forged twice, trusted once.",
    "What the river takes, the river keeps.",
]

# Each template returns (attribute lines, text, apply body lines, tags)


def t_strike(rng):
    n = rng.randint(2, 7)
    return ([f"damage = {n}"], f"Deal {n} damage to an opponent.", [
        "target = target or self.first_opponent(state, player)",
        "if target is None:",
        "    return",
        "state.damage(target, self.damage)",
    ], ("attack",))


def t_volley(rng):
    n = rng.randint(1, 4)
    return ([f"damage = {n}"], f"Deal {n} damage to each opponent.", [
        "for opponent in state.opponents(player):",
        "    state.damage(opponent, self.damage)",
    ], ("attack", "area"))


def t_mend(rng):
    n = rng.randint(2, 8)
    return ([f"healing = {n}"], f"Heal {n} health.", [
        "state.heal(player, self.healing)",
    ], ("support",))


def t_coin(rng):
    n = rng.randint(1, 5)
    return ([f"gold = {n}"], f"Gain {n} gold.", [
        "state.gain_gold(player, self.gold)",
    ], ("economy",))


def t_study(rng):
    n = rng.randint(1, 3)
    return ([f"cards = {n}"], f"Draw {n} card{'s' if n > 1 else ''}.", [
        "drawn = state.draw(player, self.cards)",
        "if drawn < self.cards:",
        "    state.log.append(f\"{player.name} ran out of cards\")",
    ], ("card-draw",))


def t_ward(rng):
    n = rng.randint(2, 6)
    return ([f"shield = {n}"], f"Gain {n} shield.", [
        "state.add_shield(player, self.shield)",
    ], ("defence",))


def t_leech(rng):
    n = rng.randint(1, 4)
    return ([f"drain = {n}"], f"Drain {n} health from an opponent. Heal for the amount drained.", [
        "target = target or self.first_opponent(state, player)",
        "if target is None:",
        "    return",
        "taken = state.damage(target, self.drain)",
        "state.heal(player, taken)",
    ], ("attack", "drain"))


def t_siphon(rng, n=None):
    n = n or rng.randint(1, 3)
    return ([f"drain = {n}"], f"Drain {n} health from each opponent. Heal for the total drained.", [
        "total = 0",
        "for opponent in state.opponents(player):",
        "    total += state.damage(opponent, self.drain)",
        "state.heal(player, total)",
    ], ("attack", "area", "drain"))


def t_levy(rng):
    n = rng.randint(1, 3)
    return ([f"levy = {n}"], f"Take up to {n} gold from each opponent.", [
        "for opponent in state.opponents(player):",
        "    state.take_gold(opponent, player, self.levy)",
    ], ("economy", "area"))


def t_bundle(rng):
    g, c = rng.randint(1, 3), rng.randint(1, 2)
    return ([f"gold = {g}", f"cards = {c}"], f"Gain {g} gold and draw {c} card{'s' if c > 1 else ''}.", [
        "state.gain_gold(player, self.gold)",
        "state.draw(player, self.cards)",
    ], ("economy", "card-draw"))


def t_bulwark(rng):
    s, h = rng.randint(1, 4), rng.randint(1, 4)
    return ([f"shield = {s}", f"healing = {h}"], f"Gain {s} shield and heal {h} health.", [
        "state.add_shield(player, self.shield)",
        "state.heal(player, self.healing)",
    ], ("defence", "support"))


def t_gamble(rng):
    n = rng.randint(3, 6)
    return ([f"gold = {n}", "self_damage = 2"], f"Gain {n} gold. Take 2 damage.", [
        "state.gain_gold(player, self.gold)",
        "state.damage(player, self.self_damage)",
    ], ("economy", "risky"))


TEMPLATES = [t_strike, t_volley, t_mend, t_coin, t_study, t_ward, t_leech, t_siphon, t_levy, t_bundle, t_bulwark, t_gamble]

HEADER = '''"""Every card in the game.

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
'''


def class_name(name):
    return "".join(part for part in name.replace("'", "").split())


def card_names(rng, count):
    pairs = [(a, n) for a in ADJECTIVES for n in NOUNS]
    rng.shuffle(pairs)
    names = []
    for a, n in pairs:
        name = f"{a} {n}"
        if name == TARGET or "Tithe" in name:
            continue
        names.append(name)
        if len(names) == count:
            return names
    raise RuntimeError("not enough names")


def render_card(number, name, template, rng, buggy=False, fixed=False):
    attrs, text, body, tags = template
    cost = rng.randint(0, 5)
    rarity = rng.choice(RARITIES)
    flavour = rng.choice(FLAVOUR)
    lines = [
        "",
        "",
        "@register",
        f"class {class_name(name)}(Card):",
        f'    """{text}',
        "",
        f"    {flavour}",
        '    """',
        "",
        f'    name = "{name}"',
        f"    set_number = {number}",
        f"    cost = {cost}",
        f'    rarity = "{rarity}"',
        f'    text = "{text}"',
        f'    flavour = "{flavour}"',
        f"    tags = {tags!r}",
    ]
    lines += [f"    {a}" for a in attrs]
    lines += ["", "    def apply(self, state, player, target=None):"]
    lines += [f"        {b}" for b in body]
    return lines


def ember_tithe(number, fixed):
    lines = [
        "",
        "",
        "@register",
        "class EmberTithe(Card):",
        '    """Drain 2 health from each opponent. Heal for the total drained.',
        "",
        "    Every harvest has its tithe.",
        '    """',
        "",
        '    name = "Ember Tithe"',
        f"    set_number = {number}",
        "    cost = 3",
        '    rarity = "rare"',
        '    text = "Drain 2 health from each opponent. Heal for the total drained."',
        '    flavour = "Every harvest has its tithe."',
        "    tags = ('attack', 'area', 'drain')",
        "    drain = 2",
        "",
        "    def apply(self, state, player, target=None):",
    ]
    if fixed:
        lines += [
            "        total = 0",
            "        for opponent in state.opponents(player):",
            "            total += state.damage(opponent, self.drain)",
            "        state.heal(player, total)",
        ]
    else:
        lines += [
            "        for opponent in state.opponents(player):",
            "            taken = state.damage(opponent, self.drain)",
            "        state.heal(player, taken)",
        ]
    return lines


def build(fixed):
    rng = random.Random(9091)
    names = card_names(rng, 140)
    out = HEADER.rstrip("\n").split("\n")
    span = None
    number = 0
    for i, name in enumerate(names):
        number += 1
        if i == TARGET_INDEX:
            start = len(out) + 3  # 1-based line of "@register" (two blank lines precede it)
            out += ember_tithe(number, fixed)
            span = (start, len(out))
            number += 1
        # Make sure several correct "drain each opponent" cards exist on both sides.
        template_fn = t_siphon if i in (12, 47, 88, 118, 127) else rng.choice(TEMPLATES)
        template = template_fn(rng)
        out += render_card(number, name, template, rng)
    out.append("")
    return "\n".join(out), span


def write(path, text):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8", newline="") as f:
        f.write(text)


def main():
    original, span = build(fixed=False)
    fixed, fixed_span = build(fixed=True)
    write(os.path.join(TASK, "fixture", "cardgame", "cards.py"), original)
    write(os.path.join(TASK, "solution", "cardgame", "cards.py"), fixed)
    write(os.path.join(TASK, "check", "target_span.json"), json.dumps({"start": span[0], "end": span[1]}) + "\n")
    # Fingerprints come from running the ORIGINAL file (see check/fingerprint.py).
    fp = subprocess.run(
        [sys.executable, os.path.join(TASK, "check", "fingerprint.py")],
        env=dict(os.environ, PYTHONPATH=os.path.join(TASK, "fixture"), PYTHONDONTWRITEBYTECODE="1"),
        capture_output=True, text=True, check=True,
    ).stdout
    write(os.path.join(TASK, "check", "fingerprints.json"), fp)
    print(f"cards.py: {original.count(chr(10))} lines; EmberTithe at lines {span[0]}-{span[1]}")


if __name__ == "__main__":
    main()
