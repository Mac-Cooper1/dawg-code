/**
 * Fetches the pinned llama.cpp runtime into apps/desktop/resources/runtime/<arch>/.
 *
 *   node scripts/fetch-runtime.ts [--arch arm64|x64|all] [--test-model]
 *
 * Downloads each archive named in runtime.lock.json, refuses it unless its SHA-256 matches,
 * and unpacks llama-server, the libraries it loads and llama.cpp's LICENSE. Does nothing for an
 * architecture that is already installed and still verifies. `--test-model` also fetches the
 * tiny model the opt-in runtime integration test uses (into .cache/test-models/).
 */
import { parseArgs } from "node:util";
import { hostArch, isRuntimeArch, type RuntimeArch } from "../packages/models/src/runtime/arch.ts";
import { ensureTestModel, installRuntime } from "../packages/models/src/runtime/install.ts";
import { readRuntimeLock } from "../packages/models/src/runtime/lock.ts";

const usage = "usage: node scripts/fetch-runtime.ts [--arch arm64|x64|all] [--test-model]";

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      arch: { type: "string" },
      "test-model": { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false },
    },
    strict: true,
  });
  if (values.help) {
    console.log(usage);
    return;
  }
  const requested = values.arch ?? hostArch();
  let arches: RuntimeArch[];
  if (requested === "all") arches = ["arm64", "x64"];
  else if (isRuntimeArch(requested)) arches = [requested];
  else throw new Error(`unknown --arch ${requested}\n${usage}`);

  const lock = await readRuntimeLock();
  const log = (message: string) => console.log(`[fetch-runtime] ${message}`);
  log(`llama.cpp ${lock.llamaCpp.tag} (${lock.llamaCpp.release ?? "nightly"})`);
  for (const arch of arches) {
    await installRuntime({ arch, lock, log });
  }
  if (values["test-model"]) {
    await ensureTestModel({ pin: lock.testModel, log });
  }
}

main().catch((error: unknown) => {
  console.error(`[fetch-runtime] ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
