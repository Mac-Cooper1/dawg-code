/**
 * The host's project and hook methods with the real trust store: `project.inspect` marks what
 * waits for consent, `project.trust` refuses a stale hash, and `hooks.list` / `hooks.setEnabled`.
 */
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { ErrorCodes, RpcError } from "@dawg/protocol";
import { afterEach, describe, expect, it } from "vitest";
import type { CodeTrust } from "../trust/index.ts";
import { createTrustStore, type TrustStore } from "../trust/store.ts";
import { type Setup, setup } from "./__fixtures__/setup.ts";

let s: Setup | null = null;
afterEach(async () => {
  await s?.close();
  s = null;
});

/** The engine is made before its folders are known; the store is put behind it once they are. */
function lateTrust(): { trust: CodeTrust; set(store: TrustStore): void } {
  let store: TrustStore | null = null;
  const get = () => {
    if (store === null) throw new Error("trust store not set");
    return store;
  };
  return {
    trust: {
      approval: (dir) => get().approval(dir),
      decide: (dir, hash, approved) => get().decide(dir, hash, approved),
      allows: (source, dir) => get().allows(source, dir),
      switches: {
        off: (dir) => get().switches.off(dir),
        set: (input) => get().switches.set(input),
      },
    },
    set: (value) => {
      store = value;
    },
  };
}

const hooks = (value: unknown) => JSON.stringify({ hooks: value });

async function rpcError(promise: Promise<unknown>): Promise<RpcError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof RpcError) return error;
    throw error;
  }
  throw new Error("expected the request to fail");
}

describe("project.inspect and project.trust", () => {
  it("shows the project's hooks as waiting until approved, and refuses a stale hash", async () => {
    const late = lateTrust();
    s = await setup({
      engine: { trust: late.trust },
      files: {
        ".claude/settings.json": hooks({
          PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "./check.sh" }] }],
        }),
      },
    });
    late.set(createTrustStore({ storeRoot: s.storeRoot, homeDir: s.home }));
    const c = await s.connect();
    const report = await c.client.request("project.inspect", { projectDir: s.project });
    const item = report.items.find((i) => i.kind === "hook");
    expect(item).toMatchObject({
      name: "PreToolUse on Bash: ./check.sh",
      status: "needs-approval",
      notes: ["Runs a command from the project's files, so it waits for your approval."],
    });
    expect(report.approval).toMatchObject({
      approved: false,
      items: [{ status: "needs-approval" }],
    });

    // The definitions change after the person looked: their consent does not cover the new ones.
    await writeFile(
      path.join(s.project, ".claude", "settings.json"),
      hooks({
        PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "./other.sh" }] }],
      }),
    );
    const stale = await rpcError(
      c.client.request("project.trust", {
        projectDir: s.project,
        hash: report.approval?.hash ?? "x",
        approved: true,
      }),
    );
    expect(stale.code).toBe(ErrorCodes.InvalidState);
    expect(stale.message).toContain("changed");

    const fresh = await c.client.request("project.inspect", { projectDir: s.project });
    expect(
      await c.client.request("project.trust", {
        projectDir: s.project,
        hash: fresh.approval?.hash ?? "x",
        approved: true,
      }),
    ).toEqual({ approved: true });
    const after = await c.client.request("project.inspect", { projectDir: s.project });
    expect(after.items.find((i) => i.kind === "hook")?.status).toBe("loaded");
    expect(after.approval?.approved).toBe(true);
  });
});

describe("hooks.list and hooks.setEnabled", () => {
  it("lists every hook with its consent and switch, and turns one off", async () => {
    const late = lateTrust();
    s = await setup({
      engine: { trust: late.trust },
      files: {
        ".claude/settings.json": hooks({
          Stop: [{ hooks: [{ type: "command", command: "./notify.sh", timeout: 5 }] }],
          FileChanged: [{ hooks: [{ type: "command", command: "./later.sh" }] }],
          PermissionRequest: [{ hooks: [{ type: "http", url: "http://localhost:8080/ask" }] }],
        }),
      },
    });
    late.set(createTrustStore({ storeRoot: s.storeRoot, homeDir: s.home }));
    await mkdir(path.join(s.home, ".dawg"), { recursive: true });
    await writeFile(
      path.join(s.home, ".dawg", "settings.json"),
      hooks({
        SessionStart: [{ matcher: "startup", hooks: [{ type: "command", command: "git status" }] }],
      }),
    );
    const c = await s.connect();
    const list = await c.client.request("hooks.list", { projectDir: s.project });
    expect(list.disabledBy).toBeNull();
    expect(
      list.hooks.map((h) => [
        h.event,
        h.matcher,
        h.command,
        h.timeout,
        h.source.scope,
        h.status,
        h.enabled,
      ]),
    ).toEqual([
      ["Stop", null, "./notify.sh", 5, "project", "needs-approval", true],
      ["FileChanged", null, "./later.sh", null, "project", "not-supported", true],
      [
        "PermissionRequest",
        null,
        "http://localhost:8080/ask",
        null,
        "project",
        "needs-approval",
        true,
      ],
      ["SessionStart", "startup", "git status", null, "user", "loaded", true],
    ]);
    // What a hook that is not a command reaches.
    expect(list.hooks[2]?.reaches).toEqual({
      host: "localhost:8080",
      model: null,
      server: null,
      tool: null,
    });
    expect(list.hooks[0]?.reaches).toBeNull();

    const mine = list.hooks[3];
    expect(
      await c.client.request("hooks.setEnabled", {
        projectDir: s.project,
        id: mine?.id ?? "",
        enabled: false,
      }),
    ).toEqual({ enabled: false });
    const again = await c.client.request("hooks.list", { projectDir: s.project });
    expect(again.hooks[3]?.enabled).toBe(false);
    // The person's own hook is off in every project.
    expect((await c.client.request("hooks.list", { projectDir: null })).hooks[0]?.enabled).toBe(
      false,
    );

    const unknown = await rpcError(
      c.client.request("hooks.setEnabled", {
        projectDir: s.project,
        id: "sha256:nope",
        enabled: false,
      }),
    );
    expect(unknown.code).toBe(ErrorCodes.InvalidParams);
  });
});
