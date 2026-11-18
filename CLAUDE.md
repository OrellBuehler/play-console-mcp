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
Node 22 and 24 — all must pass. Run them locally before committing.

## Architecture

Request flow: `index.ts` reads config, builds the server via `server.ts:createServer(client,
reportingClient, packageName, allowWrites, allowDestructive)`, and connects it over stdio. Each tool calls one of
the two REST clients.

- **`src/index.ts`** — entry point. Stdio transport only (single-account).
- **`src/config.ts`** — reads env at import time and **exits the process** if neither
  `GOOGLE_SERVICE_ACCOUNT_KEY` nor `GOOGLE_SERVICE_ACCOUNT_KEY_PATH` is set. Exports `config`
  (including `allowWrites` from `GOOGLE_PLAY_ALLOW_WRITES` and `allowDestructive` from
  `GOOGLE_PLAY_ALLOW_DESTRUCTIVE`, both off by default), `client` (androidpublisher) and
  `reportingClient` (Play Developer Reporting). Warns on stderr when the destructive flag is set
  without the writes flag, since it then has no effect.
- **`src/play/auth.ts`** — `createTokenProvider(auth)`: signs an RS256 service-account JWT with
  `jose` and exchanges it at `https://oauth2.googleapis.com/token` for an OAuth access token, cached
  until expiry with a 60 s buffer. The JWT carries **both** scopes (`androidpublisher` and
  `playdeveloperreporting`), so one provider serves both clients. The key JSON is loaded lazily on
  first use (inline or from a file path). No `googleapis` / `google-auth-library` dependency.
- **`src/play/client.ts`** — `GooglePlayClient`, a thin `fetch` wrapper. One class, two instances
  built from `PUBLISHER_BASE_URL` and `REPORTING_BASE_URL`. `get`/`post`/`put`/`patch`/`del`; `post`
  takes optional query params (needed for `:commit?changesNotSentForReview`) and tolerates empty
  response bodies. `upload` posts raw bytes with an explicit `Content-Type` to
  `PUBLISHER_UPLOAD_BASE_URL` with `uploadType=media` — that host is a separate prefix
  (`/upload/androidpublisher/v3`), which is why it is its own method. Throws on non-2xx with the
  response body in the message.
- **`src/play/edits.ts`** — the Play **edits workflow**, which every release write goes through:
  `readWithEdit` (insert edit → read → always delete) and `withEdit` (insert → mutate →
  `:validate` + delete for a dry run, or `:commit`; delete the edit on failure).
- **`src/play/format.ts`** — `ok`/`err` (MCP content envelopes; `ok` passes strings through
  unquoted) and `resolvePackage` (per-tool `package_name` overriding `GOOGLE_PLAY_PACKAGE_NAME`,
  throwing a helpful error if neither is set).
- **`src/tools/*.ts`** — each exports a `register*Tools(server, client, packageName?)` function that
  `server.ts` calls: `reviews`, `releases`, `listings`, `artifacts`, `recovery` (all on the publisher
  client), `vitals` and `apps` (on the reporting client). `reviews` and `releases` take a fourth
  `allowWrites` argument; `listings` and `recovery` take `allowWrites` and `allowDestructive`.
- **`src/tools/shared.ts`** — Zod shapes reused across tool modules: `packageArg`, `writeShape`
  (`validate_only` + `changes_not_sent_for_review`) and `releaseNotesSchema`, plus the tool
  annotation presets (`readOnly`, `additive`, `destructive`) and `UNTRUSTED_NOTE`. Reuse these
  instead of redeclaring them.

## Conventions

- **ESM with Node16 module resolution: all relative imports must end in `.js`** (e.g.
  `import { ok } from "../play/format.js"`), even though the source is `.ts`.
- **Tool handler shape:** `server.tool(name, description, zodShape, annotations, async (args) => {
try { return ok(...); } catch (e) { return err(e); } })`. The third argument is a raw Zod shape
  object. Match this try/catch-`ok`/`err` style exactly.
- **Every tool has annotations**, taken from the presets in `tools/shared.ts`: `readOnly` for reads,
  `additive` for writes that only add (`create_track`, `create_recovery_action`,
  `upload_listing_image`), `destructive` for anything that overwrites, deletes or cannot be undone.
  `server.test.ts` fails when a tool has none.
- **Text written by strangers is untrusted.** Reviews and error reports can carry prompt injection.
  Any tool returning such text appends `UNTRUSTED_NOTE` to its description, and `server.test.ts`
  asserts the exact list of tools that do.
- **Tool args are snake_case** and every field gets a `.describe(...)`. Descriptions are long and
  agent-facing: name the fields that come back, state defaults and limits, and cross-reference
  sibling tools ("Get review IDs from list_reviews").
- **Every tool takes an optional `package_name`** resolved through `resolvePackage`.
- **Pass the API through, don't fabricate fields.** Surface whatever Google returns rather than
  hand-mapping into a fixed schema, so the server stays correct if fields are added or renamed.
- **Don't add comments, docstrings, or type annotations** unless they already exist in the file
  you're editing (per global preference).
- **Scope of writes:** review replies, release/track/tester management, store listing and metadata
  edits (including listing images), and app recovery actions. Do **not** add AAB/APK/deobfuscation
  upload, in-app products/subscriptions, app creation, or user/permission management. Every write
  tool that goes through the edits workflow must keep supporting `validate_only`.
- **Writes are opt-in, and the server is read-only by default.** Write tools are only registered
  when `allowWrites` is true (`GOOGLE_PLAY_ALLOW_WRITES`), because they sit next to untrusted review
  text. Implemented as an early `if (!allowWrites) return;` in the register function, with the read
  tools above it and every write tool below it, so the gating is one obvious line rather than a
  per-tool condition.
- **Destructive tools need a second opt-in.** Deletes, listing image uploads, and app recovery
  writes are only registered when `allowDestructive` is true (`GOOGLE_PLAY_ALLOW_DESTRUCTIVE`) as
  well, via a second early `if (!allowDestructive) return;` below the writes gate. The destructive
  flag does not imply the writes flag: on its own it registers nothing. Any new delete, binary
  upload, or irreversible non-edits-workflow write goes below that second line.
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

The fake server's `tool` takes five arguments (name, description, schema, annotations, handler).
Gated modules (`reviews`, `releases`, `listings`, `recovery`) take `allowWrites` (and
`allowDestructive`) as extra arguments of the test `collect()` helper, defaulting to true, and assert
the **exact list of registered tool names** at each gate level, so a new write tool added above a
gate fails the test. `server.test.ts` connects a real `McpServer` to an in-memory client and asserts
the full tool list per gate level, that every tool carries annotations, and which tools are flagged
as returning untrusted text. `listings.test.ts` `vi.mock`s
`node:fs/promises` to stub `readFile` for the image upload path.
