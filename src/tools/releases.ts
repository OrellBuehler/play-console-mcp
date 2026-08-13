import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { GooglePlayClient } from "../play/client.js";
import { ok, err, resolvePackage } from "../play/format.js";
import { readWithEdit, withEdit } from "../play/edits.js";

export interface Release {
  name?: string;
  versionCodes?: string[];
  status?: string;
  userFraction?: number;
  countryTargeting?: unknown;
  inAppUpdatePriority?: number;
  releaseNotes?: Array<{ language: string; text: string }>;
}

export interface Track {
  track?: string;
  releases?: Release[];
}

interface TracksListResponse {
  tracks?: Track[];
}

const writeShape = {
  validate_only: z
    .boolean()
    .optional()
    .describe("Dry run: validate the change and discard the edit instead of committing it"),
  changes_not_sent_for_review: z
    .boolean()
    .optional()
    .describe(
      "Commit without sending the changes for review (only for apps where changes are reviewed separately)",
    ),
};

const releaseNotesSchema = z
  .array(z.object({ language: z.string(), text: z.string() }))
  .optional()
  .describe(
    "Release notes per locale, e.g. [{language:'en-US',text:'Bug fixes'}]. Defaults to the source release's notes.",
  );

function activeRelease(track: Track, statuses: string[]): Release | undefined {
  return (track.releases ?? []).find((r) => r.status && statuses.includes(r.status));
}

function describeReleases(track: Track): string {
  return JSON.stringify(
    (track.releases ?? []).map((r) => ({
      name: r.name,
      status: r.status,
      versionCodes: r.versionCodes,
      userFraction: r.userFraction,
    })),
  );
}

export function registerReleaseTools(
  server: McpServer,
  client: GooglePlayClient,
  defaultPackageName?: string,
) {
  server.tool(
    "list_tracks",
    "List all release tracks for an app (internal, alpha, beta, production and any custom closed tracks) with their releases: name, versionCodes, status (draft/inProgress/halted/completed), userFraction for staged rollouts, and releaseNotes. Start here to see what is live before using promote_release, update_rollout or halt_rollout.",
    {
      package_name: z
        .string()
        .optional()
        .describe("App package name, e.g. 'com.acme.app' (defaults to GOOGLE_PLAY_PACKAGE_NAME)"),
    },
    async ({ package_name }) => {
      try {
        const pkg = resolvePackage(package_name, defaultPackageName);
        const res = await readWithEdit(client, pkg, (base) =>
          client.get<TracksListResponse>(`${base}/tracks`),
        );
        const tracks = res.tracks ?? [];
        return ok({ packageName: pkg, count: tracks.length, tracks });
      } catch (e) {
        return err(e);
      }
    },
  );

  server.tool(
    "get_track",
    "Get a single release track with its releases (name, versionCodes, status, userFraction, releaseNotes). Use list_tracks first if you do not know the track name.",
    {
      track: z
        .string()
        .describe("Track name: 'internal', 'alpha', 'beta', 'production' or a custom track name"),
      package_name: z
        .string()
        .optional()
        .describe("App package name, e.g. 'com.acme.app' (defaults to GOOGLE_PLAY_PACKAGE_NAME)"),
    },
    async ({ track, package_name }) => {
      try {
        const pkg = resolvePackage(package_name, defaultPackageName);
        const res = await readWithEdit(client, pkg, (base) =>
          client.get<Track>(`${base}/tracks/${encodeURIComponent(track)}`),
        );
        return ok(res);
      } catch (e) {
        return err(e);
      }
    },
  );

  server.tool(
    "promote_release",
    "Promote the active release of one track to another (e.g. beta -> production), keeping its version codes. Omit user_fraction for a full rollout (status 'completed'); pass user_fraction for a staged rollout (status 'inProgress'). This replaces the destination track's release list, matching how promoting works in the Play Console. Use validate_only first to check the change without committing.",
    {
      from_track: z.string().describe("Source track to promote from, e.g. 'beta'"),
      to_track: z.string().describe("Destination track to promote to, e.g. 'production'"),
      user_fraction: z
        .number()
        .gt(0)
        .lt(1)
        .optional()
        .describe(
          "Staged rollout fraction between 0 and 1 exclusive, e.g. 0.1 for 10%. Omit to release to all users.",
        ),
      release_name: z
        .string()
        .optional()
        .describe("Release name shown in the Play Console (defaults to the source release's name)"),
      release_notes: releaseNotesSchema,
      package_name: z
        .string()
        .optional()
        .describe("App package name, e.g. 'com.acme.app' (defaults to GOOGLE_PLAY_PACKAGE_NAME)"),
      ...writeShape,
    },
    async ({
      from_track,
      to_track,
      user_fraction,
      release_name,
      release_notes,
      package_name,
      validate_only,
      changes_not_sent_for_review,
    }) => {
      try {
        const pkg = resolvePackage(package_name, defaultPackageName);
        const { result, committed } = await withEdit(
          client,
          pkg,
          async (base) => {
            const source = await client.get<Track>(
              `${base}/tracks/${encodeURIComponent(from_track)}`,
            );
            const release = activeRelease(source, ["completed", "inProgress"]);
            if (!release) {
              throw new Error(
                `No active release on track '${from_track}'. Releases: ${describeReleases(source)}`,
              );
            }
            const promoted: Release = {
              name: release_name ?? release.name,
              versionCodes: release.versionCodes,
              releaseNotes: release_notes ?? release.releaseNotes,
              status: user_fraction === undefined ? "completed" : "inProgress",
              ...(user_fraction === undefined ? {} : { userFraction: user_fraction }),
            };
            return client.put<Track>(`${base}/tracks/${encodeURIComponent(to_track)}`, {
              track: to_track,
              releases: [promoted],
            });
          },
          { validateOnly: validate_only, changesNotSentForReview: changes_not_sent_for_review },
        );
        return ok({ committed, validatedOnly: !committed, track: result });
      } catch (e) {
        return err(e);
      }
    },
  );

  server.tool(
    "update_rollout",
    "Change the staged rollout percentage of the in-progress release on a track. Pass user_fraction 1 to complete the rollout to all users (status becomes 'completed'). Updating a halted release resumes it. Use get_track to see the current userFraction first.",
    {
      track: z.string().describe("Track whose rollout to update, e.g. 'production'"),
      user_fraction: z
        .number()
        .gt(0)
        .max(1)
        .describe(
          "New rollout fraction between 0 (exclusive) and 1, e.g. 0.25 for 25%. Pass 1 to complete the rollout.",
        ),
      package_name: z
        .string()
        .optional()
        .describe("App package name, e.g. 'com.acme.app' (defaults to GOOGLE_PLAY_PACKAGE_NAME)"),
      ...writeShape,
    },
    async ({ track, user_fraction, package_name, validate_only, changes_not_sent_for_review }) => {
      try {
        const pkg = resolvePackage(package_name, defaultPackageName);
        const { result, committed } = await withEdit(
          client,
          pkg,
          async (base) => {
            const current = await client.get<Track>(`${base}/tracks/${encodeURIComponent(track)}`);
            const release = activeRelease(current, ["inProgress", "halted"]);
            if (!release) {
              throw new Error(
                `No in-progress or halted release on track '${track}'. Releases: ${describeReleases(current)}`,
              );
            }
            const updated: Release = { ...release };
            if (user_fraction === 1) {
              updated.status = "completed";
              delete updated.userFraction;
            } else {
              updated.status = "inProgress";
              updated.userFraction = user_fraction;
            }
            return client.put<Track>(`${base}/tracks/${encodeURIComponent(track)}`, {
              track,
              releases: [updated],
            });
          },
          { validateOnly: validate_only, changesNotSentForReview: changes_not_sent_for_review },
        );
        return ok({ committed, validatedOnly: !committed, track: result });
      } catch (e) {
        return err(e);
      }
    },
  );

  server.tool(
    "halt_rollout",
    "Halt the in-progress staged rollout on a track, stopping delivery to new users while keeping the current userFraction. Use update_rollout afterwards to resume or complete it.",
    {
      track: z.string().describe("Track whose rollout to halt, e.g. 'production'"),
      package_name: z
        .string()
        .optional()
        .describe("App package name, e.g. 'com.acme.app' (defaults to GOOGLE_PLAY_PACKAGE_NAME)"),
      ...writeShape,
    },
    async ({ track, package_name, validate_only, changes_not_sent_for_review }) => {
      try {
        const pkg = resolvePackage(package_name, defaultPackageName);
        const { result, committed } = await withEdit(
          client,
          pkg,
          async (base) => {
            const current = await client.get<Track>(`${base}/tracks/${encodeURIComponent(track)}`);
            const release = activeRelease(current, ["inProgress"]);
            if (!release) {
              throw new Error(
                `No in-progress rollout on track '${track}'. Releases: ${describeReleases(current)}`,
              );
            }
            return client.put<Track>(`${base}/tracks/${encodeURIComponent(track)}`, {
              track,
              releases: [{ ...release, status: "halted" }],
            });
          },
          { validateOnly: validate_only, changesNotSentForReview: changes_not_sent_for_review },
        );
        return ok({ committed, validatedOnly: !committed, track: result });
      } catch (e) {
        return err(e);
      }
    },
  );
}
