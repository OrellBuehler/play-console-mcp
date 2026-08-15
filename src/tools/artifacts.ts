import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { GooglePlayClient } from "../play/client.js";
import { ok, err, resolvePackage } from "../play/format.js";
import { readWithEdit } from "../play/edits.js";
import { packageArg } from "./shared.js";

export function registerArtifactTools(
  server: McpServer,
  client: GooglePlayClient,
  defaultPackageName?: string,
) {
  server.tool(
    "list_bundles",
    "List the app bundles (AABs) uploaded for an app, each with versionCode, sha1 and sha256. Use the versionCode values with create_release to ship a bundle to a track. This server does not upload bundles — upload them from CI or the Play Console first.",
    {
      package_name: packageArg,
    },
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
}
