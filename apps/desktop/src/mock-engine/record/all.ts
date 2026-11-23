/** Every recorded scenario, in the order the fixture script writes them. */
import type { ScenarioDefinition } from "./define.ts";
import { brokenLinks } from "./scenarios/broken-links.ts";
import { docsSearch } from "./scenarios/docs-search.ts";
import { exportMd } from "./scenarios/export-md.ts";
import { fixSplit } from "./scenarios/fix-split.ts";
import { flakyCsv } from "./scenarios/flaky-csv.ts";
import { multiCurrency } from "./scenarios/multi-currency.ts";
import { python313 } from "./scenarios/python-313.ts";
import { receiptPdf } from "./scenarios/receipt-pdf.ts";
import { tipSupport } from "./scenarios/tip-support.ts";

export const ALL_SCENARIOS: readonly (() => ScenarioDefinition)[] = [
  fixSplit,
  flakyCsv,
  tipSupport,
  multiCurrency,
  receiptPdf,
  docsSearch,
  brokenLinks,
  python313,
  exportMd,
];
