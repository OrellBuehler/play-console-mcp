# play-console-mcp

[![npm](https://img.shields.io/npm/v/@orellbuehler/play-console-mcp.svg)](https://www.npmjs.com/package/@orellbuehler/play-console-mcp)
[![CI](https://github.com/OrellBuehler/play-console-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/OrellBuehler/play-console-mcp/actions/workflows/ci.yml)
[![node](https://img.shields.io/node/v/@orellbuehler/play-console-mcp.svg)](https://nodejs.org)
[![license: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](./LICENSE)

MCP server for the **Google Play Console** that exposes the official
[Google Play Developer API](https://developers.google.com/android-publisher) and
[Play Developer Reporting API](https://developers.google.com/play/developer/reporting) as tools for
AI agents.

Its focus is **managing user feedback and Android app releases** — reading and replying to Play
Store reviews, cutting a release from an uploaded bundle, editing release notes, promoting a build
from beta to production, steering a staged rollout, editing the store listing, rolling out an app
recovery action, and checking crash/ANR vitals before and after a release.

> **What it deliberately does not do:** no app bundle (AAB/APK) uploads — upload those from CI or
> the Play Console and reference the resulting version codes here — no in-app product or
> subscription management, no user and permission management, and no Android device management
> (that is the unrelated [Android Management API](https://developers.google.com/android/management)).

> **Deletes, image uploads and app recovery writes are opt-in.** They are only registered when
> `GOOGLE_PLAY_ALLOW_DESTRUCTIVE` is set — see [Configuration](#configuration).

## Install

```bash
claude mcp add play-console \
  -e GOOGLE_SERVICE_ACCOUNT_KEY_PATH=/path/to/service-account.json \
  -e GOOGLE_PLAY_PACKAGE_NAME=com.example.app \
  -- npx -y @orellbuehler/play-console-mcp
```

The `-e` flags must come **before** the `--` separator; anything after `--` is passed to the server
process instead of being read as configuration.

## Getting a service account key

1. In the [Google Cloud console](https://console.cloud.google.com), select or create a project and
   enable the **Google Play Android Developer API**.
2. Go to **IAM & Admin → Service accounts → Create service account**. You can skip the optional
   "grant access" steps — Play Console permissions are granted separately, not via Cloud IAM roles.
3. Open the new service account, go to the **Keys** tab, and choose **Add key → Create new key →
   JSON**. The file downloads once and cannot be retrieved again.
4. In the [Google Play Console](https://play.google.com/console), go to **Users and permissions →
   Invite new users** and paste the service account's email address
   (`name@project-id.iam.gserviceaccount.com`) as if it were a person.
5. Select your app and grant at least:
   - **View app information** (required by every tool)
   - **Reply to reviews** (for `reply_to_review`)
   - **Release to testing tracks** and/or **Production releases** (for `create_release`,
     `promote_release`, `update_rollout`, `halt_rollout`, `update_release_notes`, `create_track`,
     `update_testers`, and the app recovery tools)
   - **Edit store listing, pricing & distribution** (for `update_listing`, `update_app_details` and
     the listing image tools)
6. Point `GOOGLE_SERVICE_ACCOUNT_KEY_PATH` at the downloaded JSON file.

You no longer need to link your Play developer account to a Google Cloud project to use the API.
Treat the JSON key like a password — it carries whatever permissions you granted, with no second
factor in front of it. Keep it outside the repository and consider `chmod 600`.

Permission changes can take a few minutes to propagate. Until they do, calls fail with
`The caller does not have permission`.

## Configuration

| Variable                          | Required | Description                                                                               |
| --------------------------------- | -------- | ----------------------------------------------------------------------------------------- |
| `GOOGLE_SERVICE_ACCOUNT_KEY_PATH` | one of   | Path to the downloaded service account JSON key                                           |
| `GOOGLE_SERVICE_ACCOUNT_KEY`      | one of   | The service account JSON key inline, as a raw JSON string                                 |
| `GOOGLE_PLAY_PACKAGE_NAME`        | no       | Default app package name, so tools can omit `package_name`                                |
| `GOOGLE_PLAY_ALLOW_DESTRUCTIVE`   | no       | Set to `1`, `true` or `yes` to register the delete, image upload and recovery write tools |

## Usage with Claude Code

```json
{
  "mcpServers": {
    "play-console": {
      "command": "npx",
      "args": ["-y", "@orellbuehler/play-console-mcp"],
      "env": {
        "GOOGLE_SERVICE_ACCOUNT_KEY_PATH": "/path/to/service-account.json",
        "GOOGLE_PLAY_PACKAGE_NAME": "com.example.app"
      }
    }
  }
}
```

## Example prompts

- "What are people complaining about in this week's Play Store reviews?"
- "Reply to the 1-star review from Ada apologising for the crash and saying a fix ships this week."
- "Which tracks have releases right now, and what version code is in production?"
- "Promote the current beta release to production as a 10% staged rollout."
- "Ship version code 415 to the internal track with release notes saying 'adds offline mode'."
- "Fix the typo in the German release notes on production without touching the rollout."
- "Show me the current English store listing and shorten the tagline to fit 80 characters."
- "The crash rate spiked — halt the production rollout."
- "Compare the crash rate for version code 415 against 414 over the last two weeks."
- "Show me the top crash issues by affected users and the stack trace for the worst one."

## Tools

### Reviews

| Tool              | Description                                                                       |
| ----------------- | --------------------------------------------------------------------------------- |
| `list_reviews`    | List recent reviews with rating, text, device, app version and any existing reply |
| `get_review`      | Get a single review and its full comment thread by review ID                      |
| `reply_to_review` | Post or edit the public developer reply to a review (max 350 characters)          |

### Releases

| Tool                       | Description                                                                           |
| -------------------------- | ------------------------------------------------------------------------------------- |
| `list_tracks`              | List all tracks with their releases (version codes, status, rollout fraction, notes)  |
| `get_track`                | Get a single track and its releases                                                   |
| `create_release`           | Release explicit version codes on a track, with notes, rollout fraction and targeting |
| `promote_release`          | Promote the active release of one track to another, optionally as a staged rollout    |
| `update_release_notes`     | Replace the "what's new" text of a track's active release, leaving the rollout alone  |
| `update_rollout`           | Change the staged rollout percentage, or complete it by passing `user_fraction: 1`    |
| `halt_rollout`             | Halt an in-progress staged rollout, keeping its current fraction                      |
| `create_track`             | Create a custom closed testing track                                                  |
| `get_country_availability` | Get the countries a track is available in                                             |
| `get_testers`              | Get the Google Groups with access to a closed track                                   |
| `update_testers`           | Set the Google Groups with access to a closed track                                   |

### Artifacts

| Tool                  | Description                                                                  |
| --------------------- | ---------------------------------------------------------------------------- |
| `list_bundles`        | List uploaded app bundles with their version codes and hashes                |
| `list_apks`           | List uploaded APKs with their version codes and hashes                       |
| `list_generated_apks` | List the APKs Play generated from a bundle, grouped by signing key           |
| `get_expansion_file`  | Get the OBB expansion file attached to an APK version code (legacy APK-only) |

Bundles and APKs are read-only here — upload them from CI or the Play Console, then pass the
version codes to `create_release`.

### Listings

| Tool                        | Description                                                        | Opt-in |
| --------------------------- | ------------------------------------------------------------------ | ------ |
| `list_listings`             | List every localized store listing                                 |        |
| `get_listing`               | Get the store listing for one locale                               |        |
| `update_listing`            | Update title, short/full description or promo video for one locale |        |
| `get_app_details`           | Get contact email, phone, website and default language             |        |
| `update_app_details`        | Update contact details and default language                        |        |
| `list_listing_images`       | List store images of one type for one locale, with their ids       |        |
| `upload_listing_image`      | Upload a PNG/JPEG screenshot, icon, feature graphic or TV banner   | ✅     |
| `delete_listing`            | Delete the store listing for one locale                            | ✅     |
| `delete_all_listings`       | Delete every localized store listing                               | ✅     |
| `delete_listing_image`      | Delete one store image by id                                       | ✅     |
| `delete_all_listing_images` | Delete every image of one type for one locale                      | ✅     |

### Recovery

| Tool                     | Description                                                           | Opt-in |
| ------------------------ | --------------------------------------------------------------------- | ------ |
| `list_recovery_actions`  | List app recovery actions targeting a version code, with their status |        |
| `create_recovery_action` | Create a draft remote in-app update for users on a broken release     | ✅     |
| `deploy_recovery_action` | Deploy a draft recovery action to its targeted users                  | ✅     |
| `add_recovery_targeting` | Widen the targeting of an existing recovery action                    | ✅     |
| `cancel_recovery_action` | Cancel a recovery action                                              | ✅     |

Tools marked **Opt-in** are only registered when `GOOGLE_PLAY_ALLOW_DESTRUCTIVE` is set.

Every write tool that goes through the Play edits workflow accepts `validate_only: true` for a dry
run — the change is validated against the API and then discarded instead of being committed. The
app recovery tools are outside that workflow and have no dry run, which is why their writes are
opt-in.

### Vitals

| Tool                   | Description                                                                 |
| ---------------------- | --------------------------------------------------------------------------- |
| `query_crash_rate`     | Crash rate and user-perceived crash rate over time, optionally by dimension |
| `query_anr_rate`       | ANR rate and user-perceived ANR rate over time                              |
| `query_error_counts`   | Absolute error report counts and affected users, e.g. broken down by issue  |
| `search_error_issues`  | Grouped crash/ANR issues with cause, location, counts and Play Console link |
| `search_error_reports` | Individual error reports including the raw stack trace                      |

## Notes & caveats

- **Reviews are limited by Google, not by this server.** The API only returns reviews created or
  modified in the **last 7 days**, only reviews that contain **written text**, and only for
  **production** releases. Replies are capped at **350 characters** and the user is only notified
  about the first reply to a review.
- **Quotas:** review reads are limited to roughly 200 requests/hour and replies to 2,000/day per
  developer account.
- **Release and listing writes use the Play edits workflow.** Each write tool opens an edit, applies
  the change, and commits it in a single call; failed calls delete the edit again. Promoting or
  creating a release replaces the destination track's release list, which is what the Play Console
  does too.
- **Listing updates are partial, deletes are not.** `update_listing` and `update_app_details` only
  change the fields you pass, but `update_release_notes` and `update_testers` replace the whole set —
  read the current value first and include everything you want to keep.
- **Store listing limits are Google's:** title 30 characters, short description 80, full description
  4000, release notes 500 per locale, listing images 15 MB and PNG or JPEG only.
- **App recovery actions are user-visible and have no dry run.** `deploy_recovery_action` pushes a
  remote in-app update immediately; confirm the targeting with `list_recovery_actions` first.
- **Vitals data lags.** Android vitals metrics are aggregated daily in `America/Los_Angeles` and are
  typically about a day behind. Slices with too few users are omitted by Google.
- **Ratings over time are not available** through the Reporting API; per-review star ratings come
  from `list_reviews`.

## Development

```bash
npm install
npm run build         # tsc -p tsconfig.build.json -> dist/
npm test              # vitest run
npm run lint          # eslint src
npm run typecheck     # tsc --noEmit
npm run format        # prettier --write .
```

Smoke-test the built server against a real app:

```bash
GOOGLE_SERVICE_ACCOUNT_KEY_PATH=/path/to/service-account.json \
GOOGLE_PLAY_PACKAGE_NAME=com.example.app \
npx @modelcontextprotocol/inspector node dist/index.js
```

## CI / Releasing

CI runs `format:check`, `lint`, `typecheck`, `test` and `build` on Node 20 and 22. Publishing happens
on GitHub release via npm trusted publishing (OIDC, no tokens):

```bash
npm version patch
git push --follow-tags
gh release create "v$(node -p "require('./package.json').version")" --generate-notes
```

## License

MIT © Orell Bühler
