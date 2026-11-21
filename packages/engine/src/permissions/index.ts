/**
 * The permission engine: decides whether a tool call is allowed, asked about or denied.
 * See docs/specs/phase-2-engine-core.md, "Permissions".
 */
export {
  createPermissionEngine,
  decidePermission,
  type PermissionEngineOptions,
  readDeniedBy,
} from "./decide.ts";
export { type FsProbe, nodeFsProbe, type ProtectedKind, protectedKind } from "./paths.ts";
export {
  commandPatternMatches,
  type ParsedRule,
  parseRuleText,
  type RuleList,
  type RuleParseResult,
  type RuleProblem,
  validatePermissionRules,
} from "./rules.ts";
export {
  type AnalyzeOptions,
  analyzeCommand,
  type CommandAnalysis,
  type CommandPart,
  type FileTarget,
  isReadOnlyCommand,
} from "./shell/analyze.ts";
export { type ParsedCommand, type ParseResult, parseShell } from "./shell/parse.ts";
export { escapeGitignore } from "./suggest.ts";
export {
  denialMessage,
  describePermissionRequest,
  describeReason,
  displayPath,
  type WordingContext,
} from "./wording.ts";
