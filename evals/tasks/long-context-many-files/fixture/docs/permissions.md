# Permissions

Status: agreed, **not implemented yet**. Today every route is open.

## Scopes

A request's `auth.scopes` is a list drawn from `read`, `write` and `admin`.
They are ordered: `write` includes everything `read` allows, and `admin`
includes everything `write` allows. Unknown scope strings are ignored.

## Which scope a route needs

1. **Public routes** need nothing: `GET /health` and `GET /version`.
2. Any route whose path starts with `/admin/` needs `admin`.
3. Every other route needs `write` if handling the request can modify the
   database (`db.insert`, `db.update` or `db.remove`), directly in the route
   or through any service it calls, on any code path. Otherwise it needs
   `read`.

The HTTP method does not decide it: some GET routes write and some POST routes
only read. Look at what the code does.

## Responses

- Request without `auth` to a non-public route: status `401`, body
  `{ "error": "unauthenticated" }`.
- Request with `auth` whose scopes are not enough: status `403`, body
  `{ "error": "forbidden", "required": "<scope the route needs>" }`.
- These checks happen before the route's handler runs, so a rejected request
  never changes anything.
- Unknown routes still answer `404` whatever the auth.
