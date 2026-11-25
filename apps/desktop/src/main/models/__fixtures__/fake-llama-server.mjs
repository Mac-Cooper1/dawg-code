/**
 * A small stand-in for llama-server (b12359): it serves /health, /props and /v1/models on the
 * given port, works out the per-slot window the way the pinned build does (a unified cache is
 * shared, each slot capped by --kv-unified-per-slot; otherwise -c is divided between the slots),
 * and exits on SIGTERM. Run through a `llama-server` shell wrapper.
 */
import { createServer } from "node:http";

const argv = process.argv.slice(2);
const value = (flag) => {
  const i = argv.indexOf(flag);
  return i === -1 ? undefined : argv[i + 1];
};
const ctx = Number(value("-c"));
const slots = Number(value("-np"));
const cap = value("--kv-unified-per-slot");
const perSlot = argv.includes("--kv-unified")
  ? Math.min(ctx, cap ? Number(cap) : ctx)
  : Math.floor(ctx / slots);
const json = (res, body) => {
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify(body));
};
createServer((req, res) => {
  if (req.url === "/health") return json(res, { status: "ok" });
  if (req.url === "/props") {
    return json(res, { default_generation_settings: { n_ctx: perSlot }, total_slots: slots });
  }
  if (req.url === "/v1/models") {
    return json(res, { data: [{ id: value("--alias"), meta: { n_ctx: perSlot } }] });
  }
  res.statusCode = 404;
  return json(res, {});
}).listen(Number(value("--port")), value("--host"));
process.on("SIGTERM", () => process.exit(0));
