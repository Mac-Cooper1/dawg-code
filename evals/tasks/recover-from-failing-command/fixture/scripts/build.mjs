// Builds build/units.json, the table published for the mobile app.
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { convert, dimensions, symbolsFor, unit } from "../src/convert.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

const table = {};
for (const dimension of dimensions()) {
  const symbols = symbolsFor(dimension);
  table[dimension] = {
    base: symbols.find((s) => unit(s).factor === 1),
    units: Object.fromEntries(
      symbols.map((s) => [s, { name: unit(s).name, toBase: unit(s).factor }]),
    ),
  };
}

const checks = {
  "1 mi in km": convert(1, "mi", "km"),
  "1 ft in cm": Number(convert(1, "ft", "cm").toFixed(6)),
  "1 lb in g": Number(convert(1, "lb", "g").toFixed(6)),
  "1 d in min": convert(1, "d", "min"),
};

mkdirSync(join(root, "build"), { recursive: true });
writeFileSync(join(root, "build", "units.json"), `${JSON.stringify({ table, checks }, null, 2)}\n`);
console.log("wrote build/units.json");
