/**
 * Compatibility fixtures for the sandbox (see ../types.ts), written from Claude Code's public
 * sandboxing page and settings reference (code.claude.com/docs/en/sandboxing, /settings-reference,
 * "sandbox.*"). Each says which keys dawg applies from where, and why the others are ignored.
 */
import type { CompatFixture } from "../types.ts";

const json = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`;

export const FIXTURES: Record<string, CompatFixture> = {
  "sandbox/documented-keys": {
    description:
      "The documented example: the sandbox on with an allow-list, a denied host, excluded commands and extra paths (docs: sandboxing, settings reference).",
    files: {
      "home/.claude/settings.json": json({
        sandbox: {
          enabled: true,
          autoAllowBashIfSandboxed: true,
          excludedCommands: ["docker *"],
          network: {
            allowedDomains: ["github.com", "*.npmjs.org", "api.example.com:443"],
            deniedDomains: ["uploads.github.com"],
            allowLocalBinding: true,
          },
          filesystem: { allowWrite: ["~/.kube"], denyRead: ["~/.aws/credentials"] },
          credentials: { envVars: [{ name: "GITHUB_TOKEN", mode: "deny" }] },
        },
      }),
    },
    expected: {
      items: [
        {
          kind: "other",
          name: "sandbox",
          scope: "user",
          origin: "claude",
          status: "loaded",
          notes: ["Turns the sandbox on for shell commands."],
        },
      ],
      approval: null,
    },
    ignoreKinds: ["settings"],
  },

  "sandbox/project-cannot-loosen": {
    description:
      "A project's shared file turns the sandbox on but cannot skip prompts, loosen isolation or open writes outside the project (docs: settings reference, scopes).",
    files: {
      "project/.claude/settings.json": json({
        sandbox: {
          enabled: true,
          autoAllowBashIfSandboxed: true,
          allowAppleEvents: true,
          network: { allowedDomains: ["registry.npmjs.org"], allowLocalBinding: true },
          filesystem: { allowWrite: ["./build", "~/.ssh"] },
        },
      }),
    },
    expected: {
      items: [
        {
          kind: "other",
          name: "sandbox",
          scope: "project",
          origin: "claude",
          status: "partly-supported",
          notes: [
            "Turns the sandbox on for shell commands.",
            "sandbox.allowAppleEvents: Only your own settings",
            "sandbox.autoAllowBashIfSandboxed: It loosens the sandbox",
            "sandbox.network.allowLocalBinding: It loosens the sandbox",
            "(stricter than Claude Code, on purpose), so these are ignored: ~/.ssh.",
          ],
        },
        {
          kind: "other",
          name: "Network access to registry.npmjs.org (sandbox)",
          scope: "project",
          origin: "claude",
          status: "loaded",
          notes: ["until you approve it, they cannot"],
        },
      ],
      // Its allowed host is the project's: it waits for consent (engine trust store).
      approval: { items: 1 },
    },
    ignoreKinds: ["settings"],
  },

  "sandbox/project-hosts-need-approval": {
    description:
      "Hosts a project's files open to sandboxed commands, from sandbox.network.allowedDomains and WebFetch(domain:...) rules, wait for consent; the person's own do not (docs: sandboxing, permission rules and the sandbox).",
    files: {
      "project/.claude/settings.json": json({
        sandbox: { enabled: true, network: { allowedDomains: ["registry.npmjs.org", "*.pypi.org"] } },
      }),
      "project/.dawg/settings.local.json": json({
        permissions: { allow: ["WebFetch(domain:docs.python.org)", "WebFetch(domain:*)"] },
      }),
      "home/.claude/settings.json": json({
        sandbox: { network: { allowedDomains: ["github.com"] } },
      }),
    },
    expected: {
      items: [
        {
          kind: "other",
          name: "sandbox",
          scope: "project",
          origin: "claude",
          status: "loaded",
          notes: ["Turns the sandbox on for shell commands."],
        },
        {
          kind: "other",
          name: "Network access to registry.npmjs.org (sandbox)",
          scope: "project",
          origin: "claude",
          status: "loaded",
          notes: ["until you approve it, they cannot"],
        },
        {
          kind: "other",
          name: "Network access to *.pypi.org (sandbox)",
          scope: "project",
          origin: "claude",
          status: "loaded",
          notes: ["until you approve it, they cannot"],
        },
        {
          kind: "other",
          name: "Network access to docs.python.org (sandbox)",
          scope: "local",
          origin: "dawg",
          status: "loaded",
          notes: ["until you approve it, they cannot"],
        },
        { kind: "other", name: "sandbox", scope: "user", origin: "claude", status: "loaded" },
      ],
      // registry.npmjs.org, *.pypi.org and docs.python.org; a bare * opens nothing, and
      // github.com is the person's own.
      approval: { items: 3 },
    },
    ignoreKinds: ["settings"],
  },

  "sandbox/unsupported-keys": {
    description:
      "Keys dawg reads but does not apply: a proxy of your own, TLS termination, managed-only keys, credential masking (docs: settings reference).",
    files: {
      "home/.claude/settings.json": json({
        sandbox: {
          enabled: false,
          bwrapPath: "/usr/bin/bwrap",
          network: { httpProxyPort: 8080, tlsTerminate: {}, allowedDomains: ["https://x.org"] },
          credentials: { files: [{ path: "~/.config/gh/hosts.yml", mode: "mask" }] },
          shinyNewKey: 1,
        },
      }),
    },
    expected: {
      items: [
        {
          kind: "other",
          name: "sandbox",
          scope: "user",
          origin: "claude",
          status: "partly-supported",
          notes: [
            "Turns the sandbox off.",
            "sandbox.bwrapPath: Only managed settings can set it",
            "sandbox.network.httpProxyPort: dawg's own proxy always filters",
            "sandbox.network.tlsTerminate: dawg's proxy checks host names only",
            'sandbox.credentials.files: Masking needs a proxy that decrypts traffic',
            "sandbox.shinyNewKey: Not a documented sandbox setting",
            "is a URL; list the host name alone",
          ],
        },
      ],
      approval: null,
    },
    ignoreKinds: ["settings"],
  },
};
