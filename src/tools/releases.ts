import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { GooglePlayClient } from "../play/client.js";
import { ok, err, resolvePackage } from "../play/format.js";
import { readWithEdit, withEdit } from "../play/edits.js";
import { packageArg, writeShape, releaseNotesSchema } from "./shared.js";

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

const countryTargetingSchema = z
  .object({
    countries: z
      .array(z.string())
      .describe("Two-letter uppercase country codes, e.g. ['DE','CH','AT']"),
    include_rest_of_world: z
      .boolean()
      .optional()
      .describe("Also release to every country not listed above"),
  })
  .optional()
  .describe("Restrict the release to specific countries. Omit to keep the source targeting.");

const inAppUpdatePrioritySchema = z
  .number()
  .int()
  .min(0)
  .max(5)
  .optional()
  .describe(
    "In-app update priority from 0 (default) to 5 (most urgent), read by the Play In-App Updates API. Omit to keep the source value.",
  );

function toCountryTargeting(
  value: { countries: string[]; include_rest_of_world?: boolean } | undefined,
): unknown {
  if (!value) return undefined;
  return {
    countries: value.countries,
    ...(value.include_rest_of_world === undefined
      ? {}
      : { includeRestOfWorld: value.include_rest_of_world }),
  };
}

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
      package_name: packageArg,
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
      package_name: packageArg,
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
    "list_releases",
    "List the releases on a track, including ones that are not live yet. Each entry has releaseName, track, activeArtifacts (version codes) and releaseLifecycleState: DRAFT, NOT_SENT_FOR_REVIEW, IN_REVIEW, APPROVED_NOT_PUBLISHED, NOT_APPROVED or PUBLISHED. This is the only tool that shows review state, so use it to check whether a submitted release is still being reviewed; get_track shows rollout details (userFraction, release notes) instead. Reads the track directly without opening an edit. Obsolete releases are excluded and Google returns at most 20.",
    {
      track: z
        .string()
        .describe("Track name: 'internal', 'alpha', 'beta', 'production' or a custom track name"),
      package_name: packageArg,
    },
    async ({ track, package_name }) => {
      try {
        const pkg = resolvePackage(package_name, defaultPackageName);
        const res = await client.get<{ releases?: unknown[] }>(
          `/applications/${encodeURIComponent(pkg)}/tracks/${encodeURIComponent(track)}/releases`,
        );
        return ok({ packageName: pkg, track, count: (res.releases ?? []).length, ...res });
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
      country_targeting: countryTargetingSchema,
      in_app_update_priority: inAppUpdatePrioritySchema,
      package_name: packageArg,
      ...writeShape,
    },
    async ({
      from_track,
      to_track,
      user_fraction,
      release_name,
      release_notes,
      country_targeting,
      in_app_update_priority,
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
            const countryTargeting =
              toCountryTargeting(country_targeting) ?? release.countryTargeting;
            const inAppUpdatePriority = in_app_update_priority ?? release.inAppUpdatePriority;
            const promoted: Release = {
              name: release_name ?? release.name,
              versionCodes: release.versionCodes,
              releaseNotes: release_notes ?? release.releaseNotes,
              status: user_fraction === undefined ? "completed" : "inProgress",
              ...(user_fraction === undefined ? {} : { userFraction: user_fraction }),
              ...(countryTargeting === undefined ? {} : { countryTargeting }),
              ...(inAppUpdatePriority === undefined ? {} : { inAppUpdatePriority }),
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
      package_name: packageArg,
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
      package_name: packageArg,
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

  server.tool(
    "create_release",
    "Create a release on a track from explicit version codes, replacing whatever releases that track currently has. Use this to ship an already-uploaded bundle: get the version codes from list_bundles or list_apks first. Use promote_release instead when moving an existing release between tracks. Use validate_only first to check the change without committing.",
    {
      track: z
        .string()
        .describe(
          "Track to release on: 'internal', 'alpha', 'beta', 'production' or a custom track",
        ),
      version_codes: z
        .array(z.string())
        .min(1)
        .describe(
          "Version codes of the bundles/APKs to release, as strings, e.g. ['415']. Get them from list_bundles or list_apks.",
        ),
      status: z
        .enum(["draft", "inProgress", "completed", "halted"])
        .optional()
        .describe(
          "Release status. Defaults to 'inProgress' when user_fraction is given, otherwise 'completed'. Use 'draft' to stage a release without publishing it.",
        ),
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
        .describe("Release name shown in the Play Console, e.g. '1.4.0 (415)'"),
      release_notes: releaseNotesSchema,
      country_targeting: countryTargetingSchema,
      in_app_update_priority: inAppUpdatePrioritySchema,
      package_name: packageArg,
      ...writeShape,
    },
    async ({
      track,
      version_codes,
      status,
      user_fraction,
      release_name,
      release_notes,
      country_targeting,
      in_app_update_priority,
      package_name,
      validate_only,
      changes_not_sent_for_review,
    }) => {
      try {
        const pkg = resolvePackage(package_name, defaultPackageName);
        const countryTargeting = toCountryTargeting(country_targeting);
        const release: Release = {
          versionCodes: version_codes,
          status: status ?? (user_fraction === undefined ? "completed" : "inProgress"),
          ...(release_name === undefined ? {} : { name: release_name }),
          ...(release_notes === undefined ? {} : { releaseNotes: release_notes }),
          ...(user_fraction === undefined ? {} : { userFraction: user_fraction }),
          ...(countryTargeting === undefined ? {} : { countryTargeting }),
          ...(in_app_update_priority === undefined
            ? {}
            : { inAppUpdatePriority: in_app_update_priority }),
        };
        const { result, committed } = await withEdit(
          client,
          pkg,
          (base) =>
            client.put<Track>(`${base}/tracks/${encodeURIComponent(track)}`, {
              track,
              releases: [release],
            }),
          { validateOnly: validate_only, changesNotSentForReview: changes_not_sent_for_review },
        );
        return ok({ committed, validatedOnly: !committed, track: result });
      } catch (e) {
        return err(e);
      }
    },
  );

  server.tool(
    "update_release_notes",
    "Replace the localized release notes ('what's new' text) of the active release on a track, leaving its version codes, status and rollout fraction untouched. Use get_track first to see the current notes and which locales exist. Notes are capped at 500 characters per locale by Google.",
    {
      track: z.string().describe("Track whose release notes to update, e.g. 'production'"),
      release_notes: z
        .array(z.object({ language: z.string(), text: z.string() }))
        .min(1)
        .describe(
          "Release notes per locale, e.g. [{language:'en-US',text:'Bug fixes'}]. This replaces the full set of notes, so include every locale you want to keep.",
        ),
      package_name: packageArg,
      ...writeShape,
    },
    async ({ track, release_notes, package_name, validate_only, changes_not_sent_for_review }) => {
      try {
        const pkg = resolvePackage(package_name, defaultPackageName);
        const { result, committed } = await withEdit(
          client,
          pkg,
          async (base) => {
            const current = await client.get<Track>(`${base}/tracks/${encodeURIComponent(track)}`);
            const release = activeRelease(current, ["completed", "inProgress", "halted", "draft"]);
            if (!release) {
              throw new Error(
                `No release on track '${track}'. Releases: ${describeReleases(current)}`,
              );
            }
            return client.put<Track>(`${base}/tracks/${encodeURIComponent(track)}`, {
              track,
              releases: [{ ...release, releaseNotes: release_notes }],
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
    "create_track",
    "Create a new custom closed testing track. The built-in tracks (internal, alpha, beta, production) already exist and do not need creating. After creating a track, use update_testers to give Google Groups access and create_release to ship to it.",
    {
      track: z
        .string()
        .describe("Name for the new track, e.g. 'qa-team'. Must be unique for the app."),
      form_factor: z
        .enum(["DEFAULT", "WEAR", "AUTOMOTIVE"])
        .optional()
        .describe("Form factor the track targets. Defaults to 'DEFAULT' (phones and tablets)."),
      package_name: packageArg,
      ...writeShape,
    },
    async ({ track, form_factor, package_name, validate_only, changes_not_sent_for_review }) => {
      try {
        const pkg = resolvePackage(package_name, defaultPackageName);
        const { result, committed } = await withEdit(
          client,
          pkg,
          (base) =>
            client.post<Track>(`${base}/tracks`, {
              track,
              type: "CLOSED_TESTING",
              formFactor: form_factor ?? "DEFAULT",
            }),
          { validateOnly: validate_only, changesNotSentForReview: changes_not_sent_for_review },
        );
        return ok({ committed, validatedOnly: !committed, track: result });
      } catch (e) {
        return err(e);
      }
    },
  );

  server.tool(
    "get_country_availability",
    "Get the countries a track is available in, including whether the app is restricted to a country list and which countries are included. Read-only; change targeting with the country_targeting argument of create_release or promote_release.",
    {
      track: z.string().describe("Track to check, e.g. 'production'"),
      package_name: packageArg,
    },
    async ({ track, package_name }) => {
      try {
        const pkg = resolvePackage(package_name, defaultPackageName);
        const res = await readWithEdit(client, pkg, (base) =>
          client.get(`${base}/countryAvailability/${encodeURIComponent(track)}`),
        );
        return ok(res);
      } catch (e) {
        return err(e);
      }
    },
  );

  server.tool(
    "get_testers",
    "Get the Google Groups that have access to a closed testing track, returned as googleGroups. Only applies to closed tracks (alpha and custom tracks), not to internal or production.",
    {
      track: z.string().describe("Closed track to read testers for, e.g. 'alpha' or 'qa-team'"),
      package_name: packageArg,
    },
    async ({ track, package_name }) => {
      try {
        const pkg = resolvePackage(package_name, defaultPackageName);
        const res = await readWithEdit(client, pkg, (base) =>
          client.get(`${base}/testers/${encodeURIComponent(track)}`),
        );
        return ok(res);
      } catch (e) {
        return err(e);
      }
    },
  );

  server.tool(
    "update_testers",
    "Set the Google Groups that have access to a closed testing track. This replaces the full list, so include every group you want to keep — use get_testers first. Only applies to closed tracks (alpha and custom tracks).",
    {
      track: z.string().describe("Closed track to update, e.g. 'alpha' or 'qa-team'"),
      google_groups: z
        .array(z.string())
        .describe(
          "Google Group email addresses allowed to test, e.g. ['qa@acme.com']. Pass an empty array to remove all groups.",
        ),
      package_name: packageArg,
      ...writeShape,
    },
    async ({ track, google_groups, package_name, validate_only, changes_not_sent_for_review }) => {
      try {
        const pkg = resolvePackage(package_name, defaultPackageName);
        const { result, committed } = await withEdit(
          client,
          pkg,
          (base) =>
            client.put(`${base}/testers/${encodeURIComponent(track)}`, {
              googleGroups: google_groups,
            }),
          { validateOnly: validate_only, changesNotSentForReview: changes_not_sent_for_review },
        );
        return ok({ committed, validatedOnly: !committed, testers: result });
      } catch (e) {
        return err(e);
      }
    },
  );
}
