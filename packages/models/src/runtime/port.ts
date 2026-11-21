import { createServer } from "node:net";

/**
 * Asks the OS for a free port on `host`. There is an unavoidable gap between this check and
 * llama-server binding the port, so the supervisor also detects a bind failure in the server's
 * output (see `isBindFailure`) and retries with a new port.
 */
export function findFreePort(host: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.unref();
    server.once("error", reject);
    server.listen({ host, port: 0, exclusive: true }, () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close(() => (port > 0 ? resolve(port) : reject(new Error("no port assigned"))));
    });
  });
}

/** llama-server (b12359) prints this and exits with status 1 when the port is taken. */
const BIND_FAILURE = /couldn't bind HTTP server socket|address already in use/i;

export function isBindFailure(output: string): boolean {
  return BIND_FAILURE.test(output);
}
