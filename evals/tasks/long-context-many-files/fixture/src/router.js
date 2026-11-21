// Matches "METHOD /path" against route patterns with :params.

function compile(path) {
  const names = [];
  const pattern = path.replace(/:([a-zA-Z]+)/g, (_, name) => {
    names.push(name);
    return "([^/]+)";
  });
  return { regex: new RegExp(`^${pattern}$`), names };
}

export function createRouter(routes) {
  const compiled = routes.map((route) => ({ route, ...compile(route.path) }));
  return {
    match(method, path) {
      for (const { route, regex, names } of compiled) {
        if (route.method !== method) continue;
        const m = regex.exec(path);
        if (!m) continue;
        const params = Object.fromEntries(names.map((n, i) => [n, decodeURIComponent(m[i + 1])]));
        return { route, params };
      }
      return null;
    },
  };
}
