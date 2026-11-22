import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { readFile } from "node:fs/promises";
import { extname } from "node:path";
import type { GooglePlayClient } from "../play/client.js";
import { ok, err, resolvePackage } from "../play/format.js";
import { readWithEdit, withEdit } from "../play/edits.js";
import { packageArg, writeShape, releaseNotesSchema, readOnly, destructive } from "./shared.js";

const BUNDLE_UPLOAD_TIMEOUT_MS = 10 * 60 * 1000;

export function registerArtifactTools(
  server: McpServer,
  client: GooglePlayClient,
  defaultPackageName?: string,
  allowWrites = false,
  allowDestructive = false,
) {
  server.tool(
    "list_bundles",
    "List the app bundles (AABs) uploaded for an app, each with versionCode, sha1 and sha256. Use the versionCode values with create_release to ship a bundle to a track. Upload a new bundle with upload_bundle (needs the write and destructive opt-ins), from CI or in the Play Console.",
    {
      package_name: packageArg,
    },
    readOnly,
    async ({ package_name }) => {
      try {
        const pkg = resolvePackage(package_name, defaultPackageName);
        const res = await readWithEdit(client, pkg, (base) => client.get(`${base}/bundles`));
        return ok(res);
      } catch (e) {
        return err(e);
      }
    },
  );

  server.tool(
    "list_apks",
    "List the APKs uploaded for an app, each with versionCode and binary hashes. Most apps ship bundles instead — use list_bundles for those. Use the versionCode values with create_release.",
    {
      package_name: packageArg,
    },
    readOnly,
    async ({ package_name }) => {
      try {
        const pkg = resolvePackage(package_name, defaultPackageName);
        const res = await readWithEdit(client, pkg, (base) => client.get(`${base}/apks`));
        return ok(res);
      } catch (e) {
        return err(e);
      }
    },
  );

  server.tool(
    "list_generated_apks",
    "List the APKs Google Play generated from an uploaded bundle for a given version code, grouped by signing key, including split, standalone and universal APKs with their download ids. Use list_bundles to find version codes.",
    {
      version_code: z
        .string()
        .describe("Version code of the uploaded bundle, e.g. '415'. Get it from list_bundles."),
      package_name: packageArg,
    },
    readOnly,
    async ({ version_code, package_name }) => {
      try {
        const pkg = resolvePackage(package_name, defaultPackageName);
        const res = await client.get(
          `/applications/${encodeURIComponent(pkg)}/generatedApks/${encodeURIComponent(version_code)}`,
        );
        return ok(res);
      } catch (e) {
        return err(e);
      }
    },
  );

  server.tool(
    "get_expansion_file",
    "Get the OBB expansion file attached to an APK version code, returning fileSize and referencesVersion. Legacy APK-only feature: apps shipping app bundles use asset packs instead and will get an error here.",
    {
      apk_version_code: z.string().describe("Version code of the APK, e.g. '415'"),
      expansion_file_type: z
        .enum(["main", "patch"])
        .describe("Which expansion file to read: 'main' or 'patch'"),
      package_name: packageArg,
    },
    readOnly,
    async ({ apk_version_code, expansion_file_type, package_name }) => {
      try {
        const pkg = resolvePackage(package_name, defaultPackageName);
        const res = await readWithEdit(client, pkg, (base) =>
          client.get(
            `${base}/apks/${encodeURIComponent(apk_version_code)}/expansionFiles/${expansion_file_type}`,
          ),
        );
        return ok(res);
      } catch (e) {
        return err(e);
      }
    },
  );

  server.tool(
    "list_device_tier_configs",
    "List the device tier configs of an app, newest first. A device tier config groups devices into tiers by RAM, system-on-chip and other selectors so one app bundle can serve different assets per tier. Each entry has a deviceTierConfigId plus its deviceGroups, deviceTierSet and userCountrySets; pass an id to get_device_tier_config for the full definition. Returns 10 by default, 100 at most; pass page_token from nextPageToken to continue. Device tier configs are read-only here — create them in the Play Console or with bundletool.",
    {
      limit: z
        .number()
        .int()
        .min(1)
        .max(100)
        .optional()
        .describe("Max device tier configs (default: 10)"),
      page_token: z.string().optional().describe("nextPageToken from a previous call"),
      package_name: packageArg,
    },
    readOnly,
    async ({ limit, page_token, package_name }) => {
      try {
        const pkg = resolvePackage(package_name, defaultPackageName);
        const res = await client.get<{ deviceTierConfigs?: unknown[]; nextPageToken?: string }>(
          `/applications/${encodeURIComponent(pkg)}/deviceTierConfigs`,
          { pageSize: limit, pageToken: page_token },
        );
        return ok({ packageName: pkg, count: (res.deviceTierConfigs ?? []).length, ...res });
      } catch (e) {
        return err(e);
      }
    },
  );

  server.tool(
    "get_device_tier_config",
    "Get one device tier config by id, with its deviceGroups (each a named set of device selectors — a device belongs to the group if it matches any selector), deviceTierSet and userCountrySets. Get ids from list_device_tier_configs. Bundles using Play Asset Delivery target these groups and tiers.",
    {
      device_tier_config_id: z
        .string()
        .describe("Id of the device tier config. Get it from list_device_tier_configs."),
      package_name: packageArg,
    },
    readOnly,
    async ({ device_tier_config_id, package_name }) => {
      try {
        const pkg = resolvePackage(package_name, defaultPackageName);
        const res = await client.get(
          `/applications/${encodeURIComponent(pkg)}/deviceTierConfigs/${encodeURIComponent(device_tier_config_id)}`,
        );
        return ok(res);
      } catch (e) {
        return err(e);
      }
    },
  );

  if (!allowWrites || !allowDestructive) return;

  server.tool(
    "upload_bundle",
    "Upload an Android App Bundle (.aab) from a local file and return its versionCode, sha1 and sha256. Without track the bundle is only added to the app's artifacts: pass the returned versionCode to create_release to ship it. With track the same edit also creates a release of the new bundle on that track, replacing whatever releases that track currently has — as a 'draft' unless status says otherwise; use create_release instead for staged rollouts or country targeting. The versionCode must be higher than every bundle already uploaded, and the bundle must be signed with the app's upload key. Large bundles take minutes: the upload times out after 10 minutes. validate_only still uploads the whole file, then validates and discards the edit, so the bundle is not kept.",
    {
      file_path: z.string().describe("Absolute path to a local .aab file to upload"),
      track: z
        .string()
        .optional()
        .describe(
          "Also release the uploaded bundle on this track: 'internal', 'alpha', 'beta', 'production' or a custom track. Omit to upload without releasing.",
        ),
      status: z
        .enum(["draft", "completed"])
        .optional()
        .describe(
          "Status of the release created on track: 'draft' (default) stages it without publishing, 'completed' releases it to all users of the track. Only with track.",
        ),
      release_name: z
        .string()
        .optional()
        .describe("Release name shown in the Play Console, e.g. '1.4.0 (415)'. Only with track."),
      release_notes: releaseNotesSchema.describe(
        "Release notes per locale, e.g. [{language:'en-US',text:'Bug fixes'}]. Only with track.",
      ),
      ack_bundle_installation_warning: z
        .boolean()
        .optional()
        .describe(
          "Acknowledge the warning that the bundle's install size may be too large for some devices; Google rejects such a bundle unless this is true",
        ),
      device_tier_config_id: z
        .string()
        .optional()
        .describe(
          "Device tier config to generate deliverables with: an id from list_device_tier_configs, or 'LATEST' for the newest one. Omit for bundles without device tier targeting.",
        ),
      package_name: packageArg,
      ...writeShape,
    },
    destructive,
    async ({
      file_path,
      track,
      status,
      release_name,
      release_notes,
      ack_bundle_installation_warning,
      device_tier_config_id,
      package_name,
      validate_only,
      changes_not_sent_for_review,
      changes_in_review_behavior,
    }) => {
      try {
        const pkg = resolvePackage(package_name, defaultPackageName);
        const ext = extname(file_path).toLowerCase();
        if (ext !== ".aab") {
          throw new Error(`Unsupported file type '${ext}'. Only .aab app bundles can be uploaded.`);
        }
        if (
          track === undefined &&
          (status !== undefined || release_name !== undefined || release_notes !== undefined)
        ) {
          throw new Error("status, release_name and release_notes need track to be set.");
        }
        const bytes = await readFile(file_path);
        const { result, committed } = await withEdit(
          client,
          pkg,
          async (base) => {
            const bundle = await client.upload<{ versionCode?: number }>(
              `${base}/bundles`,
              bytes,
              "application/octet-stream",
              {
                ackBundleInstallationWarning: ack_bundle_installation_warning,
                deviceTierConfigId: device_tier_config_id,
              },
              BUNDLE_UPLOAD_TIMEOUT_MS,
            );
            if (track === undefined) return { bundle };
            const updated = await client.put(`${base}/tracks/${encodeURIComponent(track)}`, {
              track,
              releases: [
                {
                  versionCodes: [String(bundle.versionCode)],
                  status: status ?? "draft",
                  ...(release_name === undefined ? {} : { name: release_name }),
                  ...(release_notes === undefined ? {} : { releaseNotes: release_notes }),
                },
              ],
            });
            return { bundle, track: updated };
          },
          {
            validateOnly: validate_only,
            changesNotSentForReview: changes_not_sent_for_review,
            changesInReviewBehavior: changes_in_review_behavior,
          },
        );
        return ok({ committed, validatedOnly: !committed, ...result });
      } catch (e) {
        return err(e);
      }
    },
  );
}
