/**
 * Fetches the pinned ripgrep into apps/desktop/resources/bin/<platform>-<arch>/.
 *
 *   node scripts/fetch-ripgrep.ts [--target <platform-arch>|all]
 *
 * Downloads the archive named in ripgrep.lock.json for each target, refuses it unless its
 * SHA-256 matches, and unpacks `rg` and its licence files. Does nothing for a target that is
 * already installed and still verifies. The default target is this machine.
 */
import { parseArgs } from "node:util";
import { installRipgrep } from "../packages/engine/src/tools/ripgrep/install.ts";
import {
  currentTarget,
  isRipgrepTarget,
  RIPGREP_TARGETS,
  type RipgrepTarget,
  readRipgrepLock,
} from "../packages/engine/src/tools/ripgrep/lock.ts";

const usage = `usage: node scripts/fetch-ripgrep.ts [--target ${RIPGREP_TARGETS.join("|")}|all]`;

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      target: { type: "string" },
      help: { type: "boolean", short: "h", default: false },
    },
    strict: true,
  });
  if (values.help) {
    console.log(usage);
    return;
  }
  const requested = values.target ?? currentTarget();
  let targets: RipgrepTarget[];
  if (requested === "all") targets = [...RIPGREP_TARGETS];
  else if (isRipgrepTarget(requested)) targets = [requested];
  else throw new Error(`no pinned ripgrep for target ${requested}\n${usage}`);

  const lock = await readRipgrepLock();
  const log = (message: string) => console.log(`[fetch-ripgrep] ${message}`);
  log(`ripgrep ${lock.ripgrep.version} (${lock.ripgrep.repo}@${lock.ripgrep.commit.slice(0, 12)})`);
  for (const target of targets) {
    const result = await installRipgrep({ target, lock, log });
    if (result.version) log(`${target}: ${result.version}`);
  }
}

main().catch((error: unknown) => {
  console.error(`[fetch-ripgrep] ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
