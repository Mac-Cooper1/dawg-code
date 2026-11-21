import { createDb } from "./db.js";
import { HttpError } from "./errors.js";
import { createRouter } from "./router.js";
import { routes } from "./routes/index.js";
import { SEED } from "./seed.js";
import { createServices } from "./services/index.js";

/**
 * @param {{ db?: ReturnType<typeof createDb> }} [options]
 */
export function createApp({ db = createDb(SEED) } = {}) {
  const services = createServices(db);
  const router = createRouter(routes);

  /**
   * @param {{ method: string, path: string, body?: any, auth?: { userId: string, scopes: string[] } }} request
   * @returns {{ status: number, body: any }}
   */
  function handle({ method, path, body = {}, auth }) {
    const found = router.match(method, path);
    if (!found) return { status: 404, body: { error: "not_found" } };
    try {
      return found.route.handler({ params: found.params, body, auth, services, db });
    } catch (err) {
      if (err instanceof HttpError) return { status: err.status, body: { error: err.code } };
      throw err;
    }
  }

  return { handle, db };
}
