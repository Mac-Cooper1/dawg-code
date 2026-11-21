import { describe, expect, test } from "vitest";
import { buildLaunchArgs, LaunchArgsError, type LaunchInput } from "./args.ts";

const base: LaunchInput = {
  model: { path: "/models/qwen.gguf" },
  contextSize: 131072,
  slots: 3,
  port: 41234,
  settings: { cacheRamMiB: 8192, ctxCheckpoints: 32, checkpointMinStep: 4096 },
  paths: {
    apiKeyFile: "/tmp/k/api-key",
    slotSaveDir: "/home/u/.dawg/runtime/slots",
    logFile: "/home/u/.dawg/logs/llama-server.log",
  },
};

describe("buildLaunchArgs", () => {
  test("emits the spec's flags in order, loopback only, key by file", () => {
    expect(buildLaunchArgs(base)).toEqual([
      "-m",
      "/models/qwen.gguf",
      "--host",
      "127.0.0.1",
      "--port",
      "41234",
      "--api-key-file",
      "/tmp/k/api-key",
      "-c",
      "131072",
      "-np",
      "3",
      "-ngl",
      "all",
      "--no-ui",
      "--slot-save-path",
      "/home/u/.dawg/runtime/slots",
      "--cache-ram",
      "8192",
      "--ctx-checkpoints",
      "32",
      "--checkpoint-min-step",
      "4096",
      "--log-file",
      "/home/u/.dawg/logs/llama-server.log",
      "--offline",
    ]);
  });

  test("never puts a key on the command line", () => {
    const args = buildLaunchArgs(base);
    expect(args).not.toContain("--api-key");
    expect(args).toContain("--api-key-file");
  });

  test("adds the projector, reasoning and slot options from settings", () => {
    const args = buildLaunchArgs({
      ...base,
      model: { path: "/m.gguf", projectorPath: "/mmproj.gguf" },
      settings: {
        ...base.settings,
        reasoning: {
          mode: "on",
          format: "deepseek",
          budget: 4096,
          effort: "high",
          preserve: false,
        },
        kvUnified: true,
        kvUnifiedPerSlot: 65536,
        idleUnloadSeconds: 900,
        timeoutSeconds: 1200,
        alias: "qwen3.8-27b-q8",
        offline: false,
        extraArgs: ["--chat-template-file", "/t.jinja"],
      },
    });
    const tail = args.slice(args.indexOf("--log-file") + 2);
    expect(tail).toEqual([
      "--mmproj",
      "/mmproj.gguf",
      "--reasoning",
      "on",
      "--reasoning-format",
      "deepseek",
      "--reasoning-budget",
      "4096",
      "--reasoning-effort",
      "high",
      "--no-reasoning-preserve",
      "--kv-unified",
      "--kv-unified-per-slot",
      "65536",
      "--sleep-idle-seconds",
      "900",
      "--timeout",
      "1200",
      "--alias",
      "qwen3.8-27b-q8",
      "--chat-template-file",
      "/t.jinja",
    ]);
  });

  test("idle unload is off unless configured", () => {
    expect(buildLaunchArgs(base)).not.toContain("--sleep-idle-seconds");
  });

  test.each([
    ["contextSize", { contextSize: 0 }],
    ["slots", { slots: 1.5 }],
    ["port", { port: 70000 }],
    ["cacheRamMiB", { settings: { ...base.settings, cacheRamMiB: -2 } }],
    ["reasoning.effort", { settings: { ...base.settings, reasoning: { effort: "high --x" } } }],
  ] as const)("rejects an invalid %s", (_name, override) => {
    expect(() => buildLaunchArgs({ ...base, ...override } as LaunchInput)).toThrow(LaunchArgsError);
  });

  test.each(["--host", "--port", "--api-key", "--webui", "--props", "--tools", "--cors-origins"])(
    "refuses %s as an extra argument",
    (flag) => {
      expect(() =>
        buildLaunchArgs({ ...base, settings: { ...base.settings, extraArgs: [flag, "x"] } }),
      ).toThrow(/managed by the supervisor/);
      expect(() =>
        buildLaunchArgs({ ...base, settings: { ...base.settings, extraArgs: [`${flag}=x`] } }),
      ).toThrow(/managed by the supervisor/);
    },
  );
});
