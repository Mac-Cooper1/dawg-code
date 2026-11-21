import { createDb } from "./db.js";
import { HttpError } from "./errors.js";
import { createRouter } from "./router.js";
import { routes } from "./routes/index.js";
import { SEED } from "./seed.js";
import { createServices } from "./services/index.js";

// Scopes are ordered; a granted scope allows everything a lower one does.
const RANK = { read: 1, write: 2, admin: 3 };

for (const route of routes) {
  if (route.scope !== "public" && !(route.scope in RANK)) {
    throw new Error(`route ${route.method} ${route.path} has no valid scope`);
  }
}

function grantedRank(auth) {
  const scopes = Array.isArray(auth.scopes) ? auth.scopes : [];
  return Math.max(0, ...scopes.map((s) => RANK[s] ?? 0));
}

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
    const { scope } = found.route;
    if (scope !== "public") {
      if (!auth) return { status: 401, body: { error: "unauthenticated" } };
      if (grantedRank(auth) < RANK[scope]) {
        return { status: 403, body: { error: "forbidden", required: scope } };
      }
    }
    try {
      return found.route.handler({ params: found.params, body, auth, services, db });
    } catch (err) {
      if (err instanceof HttpError) return { status: err.status, body: { error: err.code } };
      throw err;
    }
  }

  return { handle, db };
}
