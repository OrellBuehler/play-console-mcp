# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A STDIO MCP server that exposes the **official Google Play Developer API** (`androidpublisher` v3)
and the **Play Developer Reporting API** (v1beta1) as tools for AI agents, centered on **user
feedback** (read and reply to Play Store reviews) and **release management** (tracks, promotion,
staged rollouts), plus Android vitals (crash/ANR rates, error issues and reports). Published to npm
as `@orellbuehler/play-console-mcp` and run via `npx`; the compiled `dist/index.js` is the `bin`
entry. See `README.md` for the tool catalog and env-var reference.

Note the Android Management API is a **different, unrelated** API for enterprise device management —
it is not used here.

## Commands

```bash
npm run build         # tsc -p tsconfig.build.json -> dist/
npm test              # vitest run (all tests)
npm run test:watch    # vitest watch
npm run lint          # eslint src
npm run typecheck     # tsc --noEmit
npm run format        # prettier --write .
npm run format:check  # prettier --check . (what CI runs)
```

Run a single test file or pattern:

```bash
npx vitest run src/__tests__/releases.test.ts
npx vitest run -t "promote_release"
```

CI (`.github/workflows/ci.yml`) runs `format:check`, `lint`, `typecheck`, and `test` + `build` on
Node 20 and 22 — all must pass. Run them locally before committing.

## Architecture

Request flow: `index.ts` reads config, builds the server via `server.ts:createServer(client,
reportingClient, packageName)`, and connects it over stdio. Each tool calls one of the two REST
clients.

- **`src/index.ts`** — entry point. Stdio transport only (single-account).
- **`src/config.ts`** — reads env at import time and **exits the process** if neither
  `GOOGLE_SERVICE_ACCOUNT_KEY` nor `GOOGLE_SERVICE_ACCOUNT_KEY_PATH` is set. Exports `config`,
  `client` (androidpublisher) and `reportingClient` (Play Developer Reporting).
- **`src/play/auth.ts`** — `createTokenProvider(auth)`: signs an RS256 service-account JWT with
  `jose` and exchanges it at `https://oauth2.googleapis.com/token` for an OAuth access token, cached
  until expiry with a 60 s buffer. The JWT carries **both** scopes (`androidpublisher` and
  `playdeveloperreporting`), so one provider serves both clients. The key JSON is loaded lazily on
  first use (inline or from a file path). No `googleapis` / `google-auth-library` dependency.
- **`src/play/client.ts`** — `GooglePlayClient`, a thin `fetch` wrapper. One class, two instances
  built from `PUBLISHER_BASE_URL` and `REPORTING_BASE_URL`. `get`/`post`/`put`/`del`; `post` takes
  optional query params (needed for `:commit?changesNotSentForReview`) and tolerates empty response
  bodies. Throws on non-2xx with the response body in the message.
- **`src/play/edits.ts`** — the Play **edits workflow**, which every release write goes through:
  `readWithEdit` (insert edit → read → always delete) and `withEdit` (insert → mutate →
  `:validate` + delete for a dry run, or `:commit`; delete the edit on failure).
- **`src/play/format.ts`** — `ok`/`err` (MCP content envelopes; `ok` passes strings through
  unquoted) and `resolvePackage` (per-tool `package_name` overriding `GOOGLE_PLAY_PACKAGE_NAME`,
  throwing a helpful error if neither is set).
- **`src/tools/*.ts`** — each exports a `register*Tools(server, client, packageName?)` function that
  `server.ts` calls: `reviews`, `releases` (both on the publisher client), `vitals` (on the
  reporting client).

## Conventions

- **ESM with Node16 module resolution: all relative imports must end in `.js`** (e.g.
  `import { ok } from "../play/format.js"`), even though the source is `.ts`.
- **Tool handler shape:** `server.tool(name, description, zodShape, async (args) => { try { return
ok(...); } catch (e) { return err(e); } })`. The third argument is a raw Zod shape object. Match this
  try/catch-`ok`/`err` style exactly.
- **Tool args are snake_case** and every field gets a `.describe(...)`. Descriptions are long and
  agent-facing: name the fields that come back, state defaults and limits, and cross-reference
  sibling tools ("Get review IDs from list_reviews").
- **Every tool takes an optional `package_name`** resolved through `resolvePackage`.
- **Pass the API through, don't fabricate fields.** Surface whatever Google returns rather than
  hand-mapping into a fixed schema, so the server stays correct if fields are added or renamed.
- **Don't add comments, docstrings, or type annotations** unless they already exist in the file
  you're editing (per global preference).
- **Scope of writes is deliberately narrow:** review replies and release track updates only. Do not
  add AAB/APK upload, store listing or metadata edits, in-app products/subscriptions, app creation,
  or user/permission management. Every write tool must keep supporting `validate_only`.
- **Secrets:** the repo is public. Never log the service account key or access tokens; only read
  them from env. Tests use a locally generated throwaway RSA key.

## Tests

Tests live in `src/__tests__/*.test.ts`. Tool tests pass a fake `{ tool: (name, desc, schema,
handler) => ... }` server to the `register*Tools` function to capture handlers, construct a real
`GooglePlayClient` with a fake token provider (`async () => "tok"`), then stub global `fetch` and
assert the exact request URL (path + `searchParams`) and request bodies. `releases.test.ts` asserts
the **order and method of every call** in the edits workflow (insert → get → put → commit, or
validate + delete), which is the part most likely to regress. `client.test.ts` covers URL building,
empty bodies and error handling; `auth.test.ts` signs with a generated RSA key and asserts the JWT
header/claims, both scopes and token caching; `config.ts` reads env at import time and exits if it's
missing, so `config.test.ts` `vi.resetModules()` + `vi.stubEnv(...)` then dynamically `import()`s it.
