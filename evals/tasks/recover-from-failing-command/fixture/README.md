# unitkit

Unit conversion helpers. The unit table lives in `data/units.csv` (factor =
how many of the dimension's base unit one of this unit is) and is turned into
`src/generated/units.js` by `scripts/generate-units.mjs`. The generated file is
not committed.

`bash ci.sh` is what CI runs on every push, starting from a fresh clone:
generate, test, then build `build/units.json`, the table we publish for the
mobile app.
