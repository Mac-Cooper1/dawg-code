# cardgame

Rules engine for a small deck-building card game.

- `cardgame/state.py`: players and the game state. All changes to health,
  shield, gold and cards go through `GameState` methods.
- `cardgame/cards.py`: every card, one class each, in set order. It is long;
  search for a card's display name to find it.

Run the tests with `python3 -m unittest discover -s tests`.
