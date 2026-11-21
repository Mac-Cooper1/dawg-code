# teamboard-api

The API behind our team task board: projects, tasks, comments, tags, users
and reports. Storage is in memory (`src/db.js`); `src/seed.js` has demo data.

- `src/app.js` builds the app: `createApp()` returns `{ handle, db }`.
  `handle(request)` takes `{ method, path, body, auth }` and returns
  `{ status, body }`.
- `src/routes/` has one file per route; `src/routes/index.js` lists them.
- `src/services/` has the business logic the routes call.
- `docs/permissions.md` describes the access rules.

Requests carry `auth: { userId, scopes }` once the gateway has checked the
caller's token; requests without a token have no `auth` at all.

Run the tests with `node --test`.
