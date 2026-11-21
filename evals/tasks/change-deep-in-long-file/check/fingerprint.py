"""Play every card in a fixed scenario and print the resulting state as JSON.

Used twice: by the generator (against the original fixture) to record
check/fingerprints.json, and by check.sh (against the workspace) to make sure
no card other than Ember Tithe changed behaviour.
"""
import json

from cardgame import CARDS, GameState, Player


def scenario():
    me = Player("me", health=15, max_health=20, gold=10, deck=["a", "b", "c", "d", "e"])
    ann = Player("ann", health=20, gold=4, shield=3)
    bo = Player("bo", health=1, gold=0)
    cy = Player("cy", health=7, gold=9)
    return GameState([me, ann, bo, cy]), me


def snapshot(state):
    return [[p.name, p.health, p.shield, p.gold, len(p.hand), len(p.deck)] for p in state.players]


def main():
    result = {}
    for name in sorted(CARDS):
        state, me = scenario()
        try:
            CARDS[name].play(state, me)
            result[name] = snapshot(state)
        except Exception as e:  # recorded, not raised: behaviour is what we compare
            result[name] = f"error: {type(e).__name__}"
    print(json.dumps(result, indent=1, sort_keys=True))


if __name__ == "__main__":
    main()
