/**
 * A stand-in for the app's main process, for the test that kills it: starts the bundled runtime
 * the way main does (`bundledRuntimeFactory`, under the package's watchdog, run by this Node as
 * main runs it with Electron), prints its pid and llama-server's as one JSON line, then idles
 * until it is killed.
 *
 * Usage: node app.ts <data root> <llama-server binary> <model file>
 */
import { fileURLToPath } from "node:url";
import { bundledRuntimeFactory } from "../runtime.ts";

const [dataRoot, binary, model] = process.argv.slice(2);
if (!dataRoot || !binary || !model) {
  process.stderr.write("usage: app.ts <data root> <llama-server binary> <model file>\n");
  process.exit(2);
}

const watchdog = fileURLToPath(
  new URL("../../../../../../packages/models/src/runtime/watchdog.ts", import.meta.url),
);
const create = bundledRuntimeFactory({
  dataRoot,
  runtimeDir: dataRoot,
  env: { ...process.env, DAWG_RUNTIME_BIN: binary },
  watchdog: { path: watchdog, nodePath: process.execPath },
});
const runtime = await create({ modelId: "tiny", modelPath: model, contextPerSlot: 4096 });
const endpoint = await runtime.start();
process.stdout.write(
  `${JSON.stringify({ app: process.pid, server: runtime.pid, contextWindow: endpoint.contextWindow })}\n`,
);
setInterval(() => {}, 60_000);
