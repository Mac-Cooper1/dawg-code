"""Players and game state.

Health never goes below 0 or above max_health. Shield absorbs damage before
health does. A player with 0 health is out of the game.
"""


class NotEnoughGold(Exception):
    pass


class Player:
    def __init__(self, name, health=20, max_health=20, gold=0, shield=0, deck=()):
        self.name = name
        self.health = health
        self.max_health = max_health
        self.gold = gold
        self.shield = shield
        self.deck = list(deck)
        self.hand = []

    @property
    def alive(self):
        return self.health > 0

    def __repr__(self):
        return f"<Player {self.name} hp={self.health}/{self.max_health} sh={self.shield} g={self.gold}>"


class GameState:
    def __init__(self, players):
        self.players = list(players)
        self.log = []

    def player(self, name):
        for p in self.players:
            if p.name == name:
                return p
        raise KeyError(name)

    def opponents(self, player):
        """Living players other than `player`, in seat order."""
        return [p for p in self.players if p is not player and p.alive]

    def damage(self, target, amount):
        """Deal damage; shield absorbs first. Returns the health actually lost."""
        absorbed = min(target.shield, amount)
        target.shield -= absorbed
        lost = min(target.health, amount - absorbed)
        target.health -= lost
        self.log.append(f"{target.name} loses {lost} health ({absorbed} absorbed)")
        return lost

    def heal(self, target, amount):
        """Heal up to max_health. Returns the health actually gained."""
        gained = max(0, min(target.max_health - target.health, amount))
        target.health += gained
        self.log.append(f"{target.name} heals {gained}")
        return gained

    def gain_gold(self, player, amount):
        player.gold += amount
        self.log.append(f"{player.name} gains {amount} gold")

    def take_gold(self, source, receiver, amount):
        """Move up to `amount` gold from source to receiver. Returns gold moved."""
        moved = min(source.gold, amount)
        source.gold -= moved
        receiver.gold += moved
        self.log.append(f"{receiver.name} takes {moved} gold from {source.name}")
        return moved

    def add_shield(self, player, amount):
        player.shield += amount
        self.log.append(f"{player.name} gains {amount} shield")

    def draw(self, player, count):
        """Move up to `count` cards from deck to hand. Returns cards drawn."""
        drawn = 0
        while drawn < count and player.deck:
            player.hand.append(player.deck.pop(0))
            drawn += 1
        self.log.append(f"{player.name} draws {drawn}")
        return drawn
