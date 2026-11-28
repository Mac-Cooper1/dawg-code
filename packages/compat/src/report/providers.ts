/**
 * Every feature's report provider, in the order the report lists them. Each feature adds its own
 * here (instructions and settings, skills and commands, hooks, and detection for the kinds dawg
 * does not run yet).
 */
import { hooksReportProvider } from "../hooks/report.ts";
import { sandboxReportProvider } from "../sandbox/report.ts";
import { skillsReportProvider } from "../skills/report.ts";
import { agentsProvider } from "./agents.ts";
import { instructionsProvider } from "./instructions.ts";
import { mcpProvider } from "./mcp.ts";
import { otherProvider } from "./other.ts";
import { settingsProvider } from "./settings.ts";
import type { ReportProvider } from "./types.ts";

export const REPORT_PROVIDERS: ReportProvider[] = [
  instructionsProvider,
  settingsProvider,
  skillsReportProvider,
  agentsProvider,
  hooksReportProvider,
  mcpProvider,
  sandboxReportProvider,
  otherProvider,
];
