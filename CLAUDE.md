# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A STDIO MCP server that exposes the **official Google Play Developer API** (`androidpublisher` v3)
and the **Play Developer Reporting API** (v1beta1) as tools for AI agents, centered on **user
feedback** (read and reply to Play Store reviews) and **release management** (tracks, promotion,
staged rollouts, app bundle upload), plus Android vitals (crash/ANR rates, error issues and reports),
the monetization catalog (subscriptions, one-time products, offers), orders and purchases, and the
developer account's users and per-app grants. Published to npm
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
reportingClient, packageName, allowWrites, allowDestructive, developerId)`, and connects it over stdio. Each tool calls one of
the two REST clients.

- **`src/index.ts`** — entry point. Stdio transport only (single-account).
- **`src/config.ts`** — reads env at import time and **exits the process** if neither
  `GOOGLE_SERVICE_ACCOUNT_KEY` nor `GOOGLE_SERVICE_ACCOUNT_KEY_PATH` is set. Exports `config`
  (including `allowWrites` from `GOOGLE_PLAY_ALLOW_WRITES` and `allowDestructive` from
  `GOOGLE_PLAY_ALLOW_DESTRUCTIVE`, both off by default, and `developerId` from `GOOGLE_PLAY_DEVELOPER_ID`), `client` (androidpublisher) and
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
  (`/upload/androidpublisher/v3`), which is why it is its own method; it takes an optional
  per-call timeout because a bundle upload outlasts the 30 s default. Throws on non-2xx with the
  response body in the message.
- **`src/play/edits.ts`** — the Play **edits workflow**, which every release write goes through:
  `readWithEdit` (insert edit → read → always delete) and `withEdit` (insert → mutate →
  `:validate` + delete for a dry run, or `:commit`; delete the edit on failure).
- **`src/play/format.ts`** — `ok`/`err` (MCP content envelopes; `ok` passes strings through
  unquoted), `resolvePackage` (per-tool `package_name` overriding `GOOGLE_PLAY_PACKAGE_NAME`,
  throwing a helpful error if neither is set) and `resolveDeveloper` (the same for `developer_id` /
  `GOOGLE_PLAY_DEVELOPER_ID`, used by the user tools).
- **`src/tools/*.ts`** — each exports a `register*Tools(server, client, packageName?)` function that
  `server.ts` calls: `reviews`, `releases`, `listings`, `artifacts`, `recovery`, `datasafety`,
  `subscriptions`, `products` (one-time products and `convert_region_prices`), `purchases` (orders
  and purchases), `users` (all on the publisher client), `vitals` and `apps` (on the reporting
  client). `reviews` and `releases` take a fourth `allowWrites` argument; the other publisher modules
  take `allowWrites` and `allowDestructive`. `users` also takes a default developer ID before the
  gate arguments.
- **`src/tools/shared.ts`** — Zod shapes reused across tool modules: `packageArg`, `writeShape`
  (`validate_only`, `changes_not_sent_for_review` and `changes_in_review_behavior`), `releaseNotesSchema`, `pageShape`,
  `regionsVersionArg`, `updateMaskArg` and `resourceArg` (a pass-through object for resources sent in
  Google's own format), plus the tool
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
  `upload_listing_image`, `create_subscription`, `create_user`, ...), `destructive` for anything that overwrites, deletes or cannot be undone.
  `server.test.ts` fails when a tool has none.
- **Text written by strangers is untrusted.** Reviews and error reports can carry prompt injection.
  So can a subscriber's cancel survey answer (`get_subscription_purchase`).
  Any tool returning such text appends `UNTRUSTED_NOTE` to its description, and `server.test.ts`
  asserts the exact list of tools that do.
- **Tool args are snake_case** and every field gets a `.describe(...)`. Descriptions are long and
  agent-facing: name the fields that come back, state defaults and limits, and cross-reference
  sibling tools ("Get review IDs from list_reviews").
- **Every tool takes an optional `package_name`** resolved through `resolvePackage`. The exception
  is the account-level user tools (`list_users`, `create_user`, `update_user`, `delete_user`), which
  take `developer_id` instead; the grant tools take both.
- **Complex resources are passed through as objects.** Subscriptions, one-time products, offers and
  device tier configs are taken as a `resourceArg` in Google's format with the path IDs and
  `packageName` filled in by the handler, rather than rebuilt from flat arguments.
- **Request shapes come from the discovery document**
  (`https://androidpublisher.googleapis.com/$discovery/rest?version=v3`). Check paths, query params
  and body schemas there before adding or changing a tool — e.g. one-time products are read under
  `oneTimeProducts` but patched under `onetimeproducts`.
- **Pass the API through, don't fabricate fields.** Surface whatever Google returns rather than
  hand-mapping into a fixed schema, so the server stays correct if fields are added or renamed.
- **Don't add comments, docstrings, or type annotations** unless they already exist in the file
  you're editing (per global preference).
- **Scope of writes:** review replies, release/track/tester management, store listing and metadata
  edits (including listing images), app bundle (AAB) upload, device tier config creation, app recovery actions, the Data safety declaration,
  the subscription and one-time product catalog, order refunds and purchase changes, and users and grants. Do **not** add APK/deobfuscation/expansion file
  upload, internal app sharing, binary downloads (generated or system APKs), the legacy `inappproducts` API, batch variants of calls that already
  have a single-item tool, billing-backend calls (plan transitions, offer targeting, `orders.reviewrefund`, external transactions), or Cloud KMS app signing. Every write
  tool that goes through the edits workflow must keep supporting `validate_only`.
- **Writes are opt-in, and the server is read-only by default.** Write tools are only registered
  when `allowWrites` is true (`GOOGLE_PLAY_ALLOW_WRITES`), because they sit next to untrusted review
  text. Implemented as an early `if (!allowWrites) return;` in the register function, with the read
  tools above it and every write tool below it, so the gating is one obvious line rather than a
  per-tool condition.
- **Destructive tools need a second opt-in.** Deletes, bundle and listing image uploads, app recovery writes,
  the Data safety update, every purchase and order write (refund, revoke, cancel, defer, acknowledge, consume),
  `migrate_base_plan_prices` and every user and grant write are only registered when `allowDestructive` is true (`GOOGLE_PLAY_ALLOW_DESTRUCTIVE`) as
  well, via a second early `if (!allowDestructive) return;` below the writes gate. The destructive
  flag does not imply the writes flag: on its own it registers nothing. Any new delete, binary
  upload, or irreversible non-edits-workflow write goes below that second line. Catalog creates,
  updates and state changes (activate/deactivate) sit under the writes gate only.
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
Gated modules (`reviews`, `releases`, `listings`, `artifacts`, `recovery`, `datasafety`, `subscriptions`,
`products`, `purchases`, `users`) take `allowWrites` (and
`allowDestructive`) as extra arguments of the test `collect()` helper, defaulting to true, and assert
the **exact list of registered tool names** at each gate level, so a new write tool added above a
gate fails the test. `server.test.ts` connects a real `McpServer` to an in-memory client and asserts
the full tool list per gate level, that every tool carries annotations, and which tools are flagged
as returning untrusted text. `listings.test.ts`, `artifacts.test.ts` and `datasafety.test.ts` `vi.mock`
`node:fs/promises` to stub `readFile` for the file upload paths.
