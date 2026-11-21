import { type ChildProcess, spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, test } from "vitest";

const cli = fileURLToPath(new URL("./cli.ts", import.meta.url));
const children: ChildProcess[] = [];
const dirs: string[] = [];

afterEach(async () => {
  for (const child of children.splice(0)) {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  }
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

async function scriptFile(content: unknown): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "dawg-mock-cli-"));
  dirs.push(dir);
  const file = join(dir, "script.json");
  await writeFile(file, JSON.stringify(content));
  return file;
}

function run(args: string[]) {
  const child = spawn(process.execPath, [cli, ...args], { stdio: ["ignore", "pipe", "pipe"] });
  children.push(child);
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8").on("data", (d: string) => (stdout += d));
  child.stderr.setEncoding("utf8").on("data", (d: string) => (stderr += d));
  const exited = new Promise<number | null>((resolve) =>
    child.once("exit", (code) => resolve(code)),
  );
  const firstLine = new Promise<string>((resolve, reject) => {
    const check = () => {
      const newline = stdout.indexOf("\n");
      if (newline >= 0) resolve(stdout.slice(0, newline));
    };
    child.stdout.on("data", check);
    child.once("exit", () => reject(new Error(`exited early: ${stderr}`)));
  });
  // Tests that expect an early exit never await the line.
  firstLine.catch(() => {});
  return { child, exited, firstLine, output: () => ({ stdout, stderr }) };
}

test("serves a script file, prints one listening line, exits cleanly on SIGTERM", async () => {
  const file = await scriptFile({
    server: { model: "cli-model", contextWindow: 1234 },
    replies: [{ text: "from the file" }],
  });
  const proc = run(["--script", file, "--port", "0"]);
  const line = JSON.parse(await proc.firstLine) as { event: string; port: number; baseUrl: string };
  expect(line).toEqual({
    event: "listening",
    port: expect.any(Number),
    baseUrl: `http://127.0.0.1:${line.port}/v1`,
  });
  const res = await fetch(`${line.baseUrl}/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ messages: [{ role: "user", content: "hi" }] }),
  });
  const body = (await res.json()) as { model: string; choices: { message: { content: string } }[] };
  expect(body.model).toBe("cli-model");
  expect(body.choices[0]?.message.content).toBe("from the file");
  const models = (await (await fetch(`${line.baseUrl}/models`)).json()) as {
    data: { meta: { n_ctx: number } }[];
  };
  expect(models.data[0]?.meta.n_ctx).toBe(1234);
  proc.child.kill("SIGTERM");
  expect(await proc.exited).toBe(0);
  expect(proc.output().stdout.trim().split("\n")).toHaveLength(1);
});

test("rejects a bad script with the offending path", async () => {
  const file = await scriptFile([{ text: "ok" }, { txet: "typo" }]);
  const proc = run(["--script", file]);
  expect(await proc.exited).toBe(2);
  expect(proc.output().stderr).toContain("replies[1].txet: is not a reply field");
});

test("requires --script", async () => {
  const proc = run([]);
  expect(await proc.exited).toBe(2);
  expect(proc.output().stderr).toContain("--script <file.json> is required");
});
