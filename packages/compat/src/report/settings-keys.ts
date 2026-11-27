/**
 * What dawg does with each settings key it does not use, for the report's notes. Built from the
 * public settings reference (code.claude.com/docs/en/settings-reference): its key index, and
 * which keys need an Anthropic account, Anthropic's API or its cloud. A key in none of these
 * lists is reported as not used yet.
 *
 * A feature that starts honouring a key, or reports it as its own items, adds it here.
 */

/** The MCP keys of the settings reference, which MCP servers honour (../mcp/settings.ts). */
export const MCP_SETTINGS_KEYS = [
  "enableAllProjectMcpServers",
  "enabledMcpjsonServers",
  "disabledMcpjsonServers",
  "allowedMcpServers",
  "deniedMcpServers",
] as const;

/** The MCP keys that approve a project's servers: a project's own files cannot. */
export const MCP_APPROVAL_KEYS: ReadonlySet<string> = new Set([
  "enableAllProjectMcpServers",
  "enabledMcpjsonServers",
]);

/**
 * Keys another part of the report lists as items of their own, so the settings file's note does
 * not repeat them: hooks (one item per handler), and the Phase 5 items in other.ts.
 */
export const KEYS_WITH_OWN_ITEMS: ReadonlySet<string> = new Set([
  "hooks",
  // Honoured: each hook's item says when it turns them all off.
  "disableAllHooks",
  "statusLine",
  "outputStyle",
  "enabledPlugins",
  "extraKnownMarketplaces",
  // Honoured by MCP (../mcp/settings.ts): each server's item says when one keeps it off. The
  // approvals count only from the person's own files; settings.ts notes them elsewhere.
  ...MCP_SETTINGS_KEYS,
  // Honoured: one item per file that has it (../sandbox/report.ts).
  "sandbox",
]);

/**
 * Keys that only mean something with an Anthropic account, Anthropic's API or its cloud:
 * signing in, API and cloud-provider credentials, claude.ai connectors and sync, server-managed
 * settings, Remote Control and phone notifications, release channels, feedback and telemetry.
 */
export const CLOUD_KEYS: ReadonlySet<string> = new Set([
  "apiKeyHelper",
  "forceLoginMethod",
  "forceLoginOrgUUID",
  "forceLoginGatewayUrl",
  "enforceAnthropicSignIn",
  "gatewayInternalNetworks",
  "allowedProviders",
  "awsAuthRefresh",
  "awsCredentialExport",
  "gcpAuthRefresh",
  "otelHeadersHelper",
  "allowAllClaudeAiMcps",
  "disableClaudeAiConnectors",
  "syncClaudeAiPlugins",
  "syncClaudeAiSkills",
  "autoContinueAtUsageLimit",
  "enableArtifact",
  "disableArtifact",
  "forceRemoteSettingsRefresh",
  "policyHelper",
  "managedSourcesBehavior",
  "parentSettingsBehavior",
  "minimumVersion",
  "requiredMinimumVersion",
  "requiredMaximumVersion",
  "autoUpdatesChannel",
  "feedbackDrafts",
  "feedbackSurveyRate",
  "modelPricing",
  "disableRemoteControl",
  "remoteControlAtStartup",
  "dialogExpiry",
  "agentPushNotifEnabled",
  "inputNeededNotifEnabled",
  "remote",
  "skipWebFetchPreflight",
  "promptCacheTtl",
  "subagentPromptCacheTtl",
  "fastMode",
  "fastModePerSessionOptIn",
  "ultracode",
  "advisorModel",
]);

/**
 * Keys that choose among Anthropic's models. Model names are mapped, not obeyed (spec,
 * principle 4): sessions use the models set up in dawg.
 */
export const MODEL_KEYS: ReadonlySet<string> = new Set([
  "model",
  "availableModels",
  "availableModelsMatch",
  "deniedModels",
  "enforceAvailableModels",
  "fallbackModel",
  "modelOverrides",
  "modelPicker",
  "modelSettings",
]);

/** Keys for features that arrive later in Phase 4 (spec, Scope). */
export const LATER_PHASE_4_KEYS: ReadonlySet<string> = new Set([
  "fileCheckpointingEnabled",
  "autoMemoryEnabled",
  "autoMemoryDirectory",
  "agent",
  "allowedHttpHookUrls",
  "httpHookAllowedEnvVars",
]);

/** Environment variables that configure Claude Code itself or Anthropic's API. */
export const HOSTED_ENV_PREFIXES = ["env.ANTHROPIC_", "env.CLAUDE_CODE_"];

export type KeyGroup = "own-item" | "cloud" | "model" | "later" | "hosted-env" | "unused";

/** Which group an ignored key (as `parseSettingsText` names it: "theme", "permissions.x") is in. */
export function keyGroup(key: string): KeyGroup {
  if (HOSTED_ENV_PREFIXES.some((prefix) => key.startsWith(prefix))) return "hosted-env";
  const top = key.split(".")[0] ?? key;
  if (KEYS_WITH_OWN_ITEMS.has(top)) return "own-item";
  if (CLOUD_KEYS.has(top)) return "cloud";
  if (MODEL_KEYS.has(top)) return "model";
  if (LATER_PHASE_4_KEYS.has(top)) return "later";
  return "unused";
}
