/**
 * Run by resume.test.ts as a separate process that is then killed with SIGKILL mid-turn. Opens a
 * session against the mock model given on the command line, prints its id, sends one prompt and
 * never closes anything.
 *
 *   node crash-child.ts <store root> <home> <project> <endpoint JSON>
 */
import type { Endpoint } from "@dawg/models";
import { createModelClient } from "../../model/index.ts";
import { Engine } from "../engine.ts";
import { localDate } from "../known.ts";
import { fakeAssembler, fakeCompactor, fakeEstimator, fakeProfile } from "./fakes.ts";

const [storeRoot, homeDir, project, endpointJson] = process.argv.slice(2);
if (!storeRoot || !homeDir || !project || !endpointJson) {
  throw new Error("usage: crash-child.ts <store root> <home> <project> <endpoint JSON>");
}
const endpoint = JSON.parse(endpointJson) as Endpoint;
const client = createModelClient(endpoint);
const engine = new Engine({
  storeRoot,
  homeDir,
  models: { connect: async () => ({ client }) },
  assembler: fakeAssembler,
  compactor: fakeCompactor(),
  estimator: fakeEstimator,
  profile: fakeProfile,
  generateTitles: false,
  durability: "none",
  environment: async (input) => ({
    cwd: input.cwd,
    additionalDirectories: [...input.additionalDirectories],
    platform: "darwin",
    osVersion: "macOS test",
    shell: "bash",
    date: localDate(input.now),
    git: null,
  }),
});
const session = await engine.createSession({ cwd: project });
process.stdout.write(`${JSON.stringify({ sessionId: session.id })}\n`);
await session.prompt({ content: [{ type: "text", text: "read a, then write b" }] });
// Keeps running until killed.
setInterval(() => {}, 1000);
