/**
 * The sandbox through a whole engine (Phase 4): settings files turn it on, the permission engine
 * auto-allows sandboxed commands when told to, a retry outside is a normal prompt that says why,
 * and the runtime's temp folder goes when the engine closes. Real runtime, so macOS only.
 */
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { text, toolCall } from "@dawg/mock-model";
import type { CommandDisplay, PermissionRequest } from "@dawg/protocol";
import { afterEach, describe, expect, it } from "vitest";
import { createTrustStore } from "../trust/index.ts";
import { type Harness, startHarness } from "./__fixtures__/harness.ts";
import type { LoggedEvent } from "./event-log.ts";

const onMac = process.platform === "darwin" && existsSync("/usr/bin/sandbox-exec");

let h: Harness | null = null;
const folders: string[] = [];
afterEach(async () => {
  expect(h?.problems ?? []).toEqual([]);
  await h?.close();
  h = null;
  await Promise.all(folders.splice(0).map((f) => rm(f, { recursive: true, force: true })));
});

/** A folder outside the project, removed after the test. */
async function outsideFolder(): Promise<string> {
  const folder = await realpath(await mkdtemp(path.join(tmpdir(), "dawg-sandbox-outside-")));
  folders.push(folder);
  return folder;
}

const ask = (t: string) => ({ content: [{ type: "text" as const, text: t }] });

function finished(harness: Harness, sessionId: string) {
  return harness.ofType(sessionId, "tool.finished").map((e) => e.payload);
}

describe.skipIf(!onMac)("the sandbox in a session", () => {
  it("auto-allows a sandboxed command, which still cannot write outside; the retry asks", async () => {
    const outsideDir = await outsideFolder();
    const target = path.join(outsideDir, "escaped.txt");
    h = await startHarness({
      files: {
        ".dawg/settings.local.json": JSON.stringify({
          sandbox: { enabled: true, autoAllowBashIfSandboxed: true },
        }),
      },
      script: [
        toolCall("Bash", { command: `echo hi > '${target}'` }),
        toolCall("Bash", { command: `echo hi > '${target}'`, dangerouslyDisableSandbox: true }),
        text("done"),
      ],
    });
    const session = await h.engine.createSession({ cwd: h.project });
    const requests: PermissionRequest[] = [];
    session.subscribe((event: LoggedEvent) => {
      if (event.event !== "permission.requested") return;
      const request = event.payload.request as PermissionRequest;
      requests.push(request);
      setImmediate(() =>
        session.respondPermission(request.requestId, { behavior: "deny", message: "not now" }),
      );
    });
    await session.run(ask("write it"));

    // The first call needed no prompt: the sandbox answered for it, and blocked the write.
    expect(requests).toHaveLength(1);
    const [first, second] = finished(h, session.id);
    const display = first?.display as CommandDisplay | undefined;
    expect(display?.sandbox?.placement).toBe("inside");
    expect(display?.sandbox?.blocked).toContain(`Writing ${target}`);
    expect(existsSync(target)).toBe(false);

    // The retry outside is a normal prompt that says where it would run.
    const retry = requests[0];
    expect(retry?.title).toBe("Run a shell command outside the sandbox");
    expect(retry?.sandbox).toEqual({ placement: "outside", reason: "retry", blocked: [] });
    expect(retry?.input).toMatchObject({ dangerouslyDisableSandbox: true });
    expect(second?.outcome).toBe("denied");
    expect(existsSync(target)).toBe(false);
  });

  it("asks as usual without auto-allow, and the card says the command runs inside", async () => {
    h = await startHarness({
      files: { ".dawg/settings.local.json": JSON.stringify({ sandbox: { enabled: true } }) },
      script: [toolCall("Bash", { command: "touch made.txt" }), text("done")],
    });
    const session = await h.engine.createSession({ cwd: h.project });
    const requests: PermissionRequest[] = [];
    session.subscribe((event: LoggedEvent) => {
      if (event.event !== "permission.requested") return;
      const request = event.payload.request as PermissionRequest;
      requests.push(request);
      setImmediate(() =>
        session.respondPermission(request.requestId, { behavior: "allow", scope: "once" }),
      );
    });
    await session.run(ask("touch"));
    expect(requests).toHaveLength(1);
    expect(requests[0]?.title).toBe("Run a shell command");
    expect(requests[0]?.sandbox).toEqual({ placement: "inside", reason: null, blocked: [] });
    expect(existsSync(path.join(h.project, "made.txt"))).toBe(true);
  });

  it("a project's shared file cannot turn auto-allow on", async () => {
    h = await startHarness({
      files: {
        ".claude/settings.json": JSON.stringify({
          sandbox: { enabled: true, autoAllowBashIfSandboxed: true },
        }),
      },
      script: [toolCall("Bash", { command: "touch made.txt" }), text("done")],
    });
    const session = await h.engine.createSession({ cwd: h.project });
    let asked = 0;
    session.subscribe((event: LoggedEvent) => {
      if (event.event !== "permission.requested") return;
      asked += 1;
      const request = event.payload.request as PermissionRequest;
      setImmediate(() => session.respondPermission(request.requestId, { behavior: "deny" }));
    });
    await session.run(ask("touch"));
    expect(asked).toBe(1);
  });

  it("removes its temp folder when the engine closes", async () => {
    h = await startHarness({
      files: {
        ".dawg/settings.local.json": JSON.stringify({
          sandbox: { enabled: true, autoAllowBashIfSandboxed: true },
        }),
      },
      script: [toolCall("Bash", { command: 'echo "$TMPDIR"' }), text("done")],
    });
    const sigint = process.listenerCount("SIGINT");
    const sigterm = process.listenerCount("SIGTERM");
    const session = await h.engine.createSession({ cwd: h.project });
    await session.run(ask("where is temp"));
    const display = finished(h, session.id)[0]?.display as CommandDisplay | undefined;
    const tempDir = display?.output?.trim() ?? "";
    expect(path.basename(tempDir)).toMatch(/^dawg-sandbox-/);
    expect(existsSync(tempDir)).toBe(true);
    // The runtime's own signal handlers are not left behind to keep Ctrl-C from working.
    expect(process.listenerCount("SIGINT")).toBe(sigint);
    expect(process.listenerCount("SIGTERM")).toBe(sigterm);
    await h.close();
    h = null;
    expect(existsSync(tempDir)).toBe(false);
  });
});

describe.skipIf(!onMac)("hosts a project's settings allow", () => {
  const servers: http.Server[] = [];
  afterEach(async () => {
    await Promise.all(
      servers.splice(0).map((server) => new Promise((resolve) => server.close(resolve))),
    );
  });

  async function server(): Promise<number> {
    const s = http.createServer((_req, res) => res.end("hello from the test server\n"));
    await new Promise<void>((resolve) => s.listen(0, "127.0.0.1", resolve));
    servers.push(s);
    return (s.address() as AddressInfo).port;
  }

  // Through the proxy (NO_PROXY names 127.0.0.1), to a test-only host given by address and port.
  const curl = (port: number) =>
    `env -u NO_PROXY -u no_proxy curl -sS -m 10 http://127.0.0.1:${port}/ 2>&1`;

  const personal = JSON.stringify({ sandbox: { enabled: true, autoAllowBashIfSandboxed: true } });

  it("waits for approval: blocked until approved, reachable after, asked again on a change", async () => {
    const port = await server();
    const other = await server();
    h = await startHarness({
      files: {
        ".dawg/settings.local.json": personal,
        ".claude/settings.json": JSON.stringify({
          sandbox: { network: { allowedDomains: [`127.0.0.1:${port}`] } },
        }),
      },
      script: [
        toolCall("Bash", { command: curl(port) }),
        text("first"),
        toolCall("Bash", { command: curl(port) }, { id: "second" }),
        text("second"),
      ],
    });
    const trust = createTrustStore({ storeRoot: h.storeRoot, homeDir: h.home });
    const engine = h.newEngine({ trust });
    const host = `127.0.0.1:${port}`;

    // Listed for approval, by name, from the project's file.
    const approval = await trust.approval(h.project);
    expect(approval?.approved).toBe(false);
    expect(approval?.items.map((i) => [i.kind, i.name, i.source.scope])).toEqual([
      ["other", `Network access to ${host} (sandbox)`, "project"],
    ]);

    // Not approved: the host is not on the list, and the result says it waits for approval.
    const session = await engine.createSession({ cwd: h.project });
    await session.run(ask("fetch"));
    const blocked = finished(h, session.id)[0];
    const blockedText = JSON.stringify(blocked?.content ?? []);
    expect(blockedText).not.toContain("hello from the test server");
    expect(blockedText).toContain("which the person has not approved yet");
    expect((blocked?.display as CommandDisplay | undefined)?.sandbox?.blocked).toContain(
      `Connecting to ${host} (not on the allowed list)`,
    );

    // Approved: reachable.
    await trust.decide(h.project, approval?.hash ?? "", true);
    await session.run(ask("fetch again"));
    const reached = finished(h, session.id)[1];
    expect(JSON.stringify(reached?.content ?? [])).toContain("hello from the test server");

    // Another host in the project's file: the setup asks again.
    await writeFile(
      path.join(h.project, ".claude", "settings.json"),
      JSON.stringify({
        sandbox: { network: { allowedDomains: [host, `127.0.0.1:${other}`] } },
      }),
    );
    const again = await trust.approval(h.project);
    expect(again?.approved).toBe(false);
    expect(again?.items.filter((i) => i.status === "needs-approval").map((i) => i.name)).toEqual([
      `Network access to 127.0.0.1:${other} (sandbox)`,
    ]);
    expect(again?.hash).not.toBe(approval?.hash);
  });

  it("counts WebFetch domain rules in a project's file as the project's hosts", async () => {
    const port = await server();
    h = await startHarness({
      files: {
        ".dawg/settings.local.json": JSON.stringify({
          sandbox: { enabled: true, autoAllowBashIfSandboxed: true },
          permissions: { allow: [`WebFetch(domain:127.0.0.1:${port})`] },
        }),
      },
      script: [toolCall("Bash", { command: curl(port) }), text("done")],
    });
    const trust = createTrustStore({ storeRoot: h.storeRoot, homeDir: h.home });
    const approval = await trust.approval(h.project);
    expect(approval?.items.map((i) => [i.name, i.source.scope])).toEqual([
      [`Network access to 127.0.0.1:${port} (sandbox)`, "local"],
    ]);
    const engine = h.newEngine({ trust });
    const session = await engine.createSession({ cwd: h.project });
    await session.run(ask("fetch"));
    expect(JSON.stringify(finished(h, session.id)[0]?.content ?? [])).not.toContain(
      "hello from the test server",
    );
  });

  it("leaves the person's own hosts alone", async () => {
    const mine = await server();
    const theirs = await server();
    h = await startHarness({
      files: { ".dawg/settings.local.json": personal },
      script: [
        toolCall("Bash", { command: curl(mine) }),
        toolCall("Bash", { command: curl(theirs) }, { id: "theirs" }),
        text("done"),
      ],
    });
    for (const [folder, port] of [
      [".dawg", mine],
      [".claude", theirs],
    ] as const) {
      await mkdir(path.join(h.home, folder), { recursive: true });
      await writeFile(
        path.join(h.home, folder, "settings.json"),
        JSON.stringify({ sandbox: { network: { allowedDomains: [`127.0.0.1:${port}`] } } }),
      );
    }
    const trust = createTrustStore({ storeRoot: h.storeRoot, homeDir: h.home });
    // Nothing of the person's is offered for approval, and both hosts are reachable.
    expect(await trust.approval(h.project)).toBeNull();
    const engine = h.newEngine({ trust });
    const session = await engine.createSession({ cwd: h.project });
    await session.run(ask("fetch both"));
    for (const call of finished(h, session.id)) {
      expect(JSON.stringify(call.content)).toContain("hello from the test server");
    }
    expect(finished(h, session.id)).toHaveLength(2);
  });
});
