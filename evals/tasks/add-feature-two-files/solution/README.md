# tickspan

Parse and format human-friendly durations. Durations are whole seconds.

```js
import { parseDuration, formatDuration } from "tickspan";

parseDuration("1h30m"); // 5400
parseDuration("2h 5s"); // 7205
formatDuration(5400); // "1h30m"
formatDuration(5400, { long: true }); // "1 hour 30 minutes"
```

## Compact syntax

A duration is one or more `<integer><unit>` parts, optionally separated by
spaces. Units are `d` (24 hours), `h`, `m` and `s`; days are the largest unit. Each unit may appear at most once, and units
must go from largest to smallest. Amounts are not capped: `90m` is valid.

## Formatting

`formatDuration` uses the largest units first and leaves out zero parts.
Zero is `0s` (or `0 seconds` in the long form). The long form uses singular
names for an amount of 1.

Run the tests with `node --test`.
