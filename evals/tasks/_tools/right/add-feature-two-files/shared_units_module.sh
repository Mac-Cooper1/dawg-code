# Alternative: refactor into one shared unit table used by both files.
cat > src/units.js <<'JS'
export const UNITS = [
  { symbol: "d", seconds: 86400, one: "day", many: "days" },
  { symbol: "h", seconds: 3600, one: "hour", many: "hours" },
  { symbol: "m", seconds: 60, one: "minute", many: "minutes" },
  { symbol: "s", seconds: 1, one: "second", many: "seconds" },
];
JS
python3 - <<'PY'
p = "src/parse.js"
s = open(p).read()
s = s.replace('''const UNIT_SECONDS = new Map([
  ["h", 3600],
  ["m", 60],
  ["s", 1],
]);''', '''import { UNITS } from "./units.js";

const UNIT_SECONDS = new Map(UNITS.map((u) => [u.symbol, u.seconds]));''')
open(p, "w").write(s)
p = "src/format.js"
s = open(p).read()
s = s.replace('''const COMPACT = [
  ["h", 3600],
  ["m", 60],
  ["s", 1],
];

const LONG_NAMES = {
  h: ["hour", "hours"],
  m: ["minute", "minutes"],
  s: ["second", "seconds"],
};''', '''import { UNITS } from "./units.js";

const COMPACT = UNITS.map((u) => [u.symbol, u.seconds]);
const LONG_NAMES = Object.fromEntries(UNITS.map((u) => [u.symbol, [u.one, u.many]]));''')
open(p, "w").write(s)
PY
cat >> test/format.test.js <<'JS'

test("days", () => {
  assert.equal(formatDuration(90000), "1d1h");
  assert.equal(parseDuration("2d"), 172800);
});
JS
