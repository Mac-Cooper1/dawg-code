import { describe, expect, test } from "vitest";
import { permissionRequest } from "./__fixtures__/samples.ts";
import { PermissionRequestSchema, ToolDisplaySchema } from "./common.ts";
import { CommandSandboxSchema } from "./sandbox.ts";

const command = {
  kind: "command",
  command: "touch /etc/x",
  cwd: "/Users/me/tally",
  exitCode: 1,
  durationMs: 40,
  timedOut: false,
  interrupted: false,
  backgroundTaskId: null,
  outputPath: null,
  output: "touch: /etc/x: Operation not permitted",
  notes: [],
} as const;

describe("sandbox", () => {
  test("a command display may say how the command ran", () => {
    const inside = ToolDisplaySchema.parse({
      ...command,
      sandbox: { placement: "inside", reason: null, blocked: ["Writing /etc/x"] },
    });
    expect(inside).toMatchObject({ sandbox: { placement: "inside", blocked: ["Writing /etc/x"] } });
    const outside = ToolDisplaySchema.parse({
      ...command,
      sandbox: { placement: "outside", reason: "retry" },
    });
    expect(outside).toMatchObject({
      sandbox: { placement: "outside", reason: "retry", blocked: [] },
    });
  });

  test("displays stored before the sandbox, and with it off, have none", () => {
    expect(ToolDisplaySchema.parse(command)).not.toHaveProperty("sandbox");
  });

  test("a permission request may carry it", () => {
    const parsed = PermissionRequestSchema.parse({
      ...permissionRequest,
      sandbox: { placement: "outside", reason: "excluded", blocked: [] },
    });
    expect(parsed.sandbox).toEqual({ placement: "outside", reason: "excluded", blocked: [] });
    expect(PermissionRequestSchema.parse(permissionRequest).sandbox).toBeUndefined();
  });

  test("unknown placements and reasons are refused", () => {
    expect(CommandSandboxSchema.safeParse({ placement: "nearby", reason: null }).success).toBe(
      false,
    );
    expect(CommandSandboxSchema.safeParse({ placement: "outside", reason: "whim" }).success).toBe(
      false,
    );
  });
});
