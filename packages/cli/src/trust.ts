/**
 * Consent for the code a project supplies, on the command line (Phase 4 spec, principle 3).
 *
 * - Interactive `dawg` asks once per project, before the first prompt, when hooks, skills or MCP
 *   servers wait for consent. Yes is kept (the app and later runs see it); no keeps them off for
 *   this run, and the next run asks again.
 * - `dawg -p` never runs unapproved code. `--approve-project-code` approves what the project
 *   defines now, before the session opens, and says so on standard error; it is for scripts in
 *   a project the person controls.
 */
import type { Client, CodeApproval, EventPayload } from "@dawg/protocol";

/** What waits for consent, as lines for the terminal. */
export function approvalLines(approval: CodeApproval, projectDir: string): string[] {
  const waiting = approval.items.filter((item) => item.status === "needs-approval");
  const lines = [`${projectDir} has code that runs on your Mac and waits for your approval:`];
  for (const item of waiting) {
    lines.push(`  ${item.kind === "mcp-server" ? "MCP server" : item.kind}: ${item.name}`);
    lines.push(`    from ${item.source.path}`);
    for (const note of item.notes) lines.push(`    ${note}`);
  }
  return lines;
}

export type ProjectCodeAnswer = "approved" | "declined" | "nothing";

/**
 * Asks once whether the project's waiting code may run. `ask` shows the question and returns the
 * next line of input (null at its end).
 */
export async function askProjectCode(
  client: Client,
  projectDir: string,
  io: { line(text: string): void; ask(question: string): Promise<string | null> },
): Promise<ProjectCodeAnswer> {
  const report = await client.request("project.inspect", { projectDir });
  const approval = report.approval;
  if (approval === null || approval.approved) return "nothing";
  for (const line of approvalLines(approval, projectDir)) io.line(line);
  const answer = await io.ask("Let them run? y = yes, n = not now: ");
  if (answer === null || !/^y(es)?$/i.test(answer.trim())) {
    io.line("They stay off for this run; dawg asks again next time.");
    return "declined";
  }
  await client.request("project.trust", { projectDir, hash: approval.hash, approved: true });
  io.line("Approved. dawg asks again if they change.");
  return "approved";
}

/** `--approve-project-code`: approves what the project defines now. */
export async function approveProjectCode(
  client: Client,
  projectDir: string,
  log: (line: string) => void,
): Promise<void> {
  const report = await client.request("project.inspect", { projectDir });
  const approval = report.approval;
  if (approval === null || approval.approved) return;
  const waiting = approval.items.filter((item) => item.status === "needs-approval");
  await client.request("project.trust", { projectDir, hash: approval.hash, approved: true });
  log(
    `Approved ${waiting.length} ${waiting.length === 1 ? "item" : "items"} of project code (--approve-project-code): ${waiting.map((item) => item.name).join("; ")}`,
  );
}

/** One line for a hook that ran, as the transcript shows it. */
export function hookLine(payload: EventPayload<"hook.ran">): string {
  const { hook } = payload;
  const said = payload.message === null ? "" : `: ${payload.message}`;
  switch (payload.outcome) {
    case "blocked":
      return `(${hook.event} hook blocked${said})`;
    case "timeout":
      return `(${hook.event} hook timed out: ${hook.command})`;
    case "error":
      return `(${hook.event} hook failed${payload.exitCode === null ? "" : ` with exit code ${payload.exitCode}`}${said})`;
    case "success":
      return payload.decision === null
        ? `(${hook.event} hook ran: ${hook.command})`
        : `(${hook.event} hook said ${payload.decision}${said})`;
  }
}

/** The quiet notice for hooks held back for consent. */
export function skippedLine(payload: EventPayload<"hook.skipped">, headless: boolean): string {
  const files = payload.sources.map((source) => source.path).join(", ");
  return headless
    ? `Hooks in ${files} were not run: they wait for your approval. Run dawg in the project to review them, or pass --approve-project-code.`
    : `Hooks in ${files} were not run: they wait for your approval. Start dawg again in the project to review them.`;
}
