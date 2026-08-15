import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { GooglePlayClient } from "../play/client.js";
import { ok, err, resolvePackage } from "../play/format.js";
import { packageArg } from "./shared.js";

export function registerAppsTools(
  server: McpServer,
  client: GooglePlayClient,
  defaultPackageName?: string,
) {
  server.tool(
    "list_apps",
    "List the apps this service account can access, each with packageName, displayName and a resource name. Use it to discover package names when GOOGLE_PLAY_PACKAGE_NAME is not set or when working across several apps — pass a packageName as the package_name argument of any other tool. Note displayName is the latest title set in the Play Console, which may not match the Play Store yet. Returns 50 apps by default, 1000 at most; pass page_token from nextPageToken to continue.",
    {
      limit: z.number().int().min(1).max(1000).optional().describe("Max apps (default: 50)"),
      page_token: z.string().optional().describe("nextPageToken from a previous call"),
    },
    async ({ limit, page_token }) => {
      try {
        const res = await client.get<{ apps?: unknown[]; nextPageToken?: string }>("/apps:search", {
          pageSize: limit,
          pageToken: page_token,
        });
        return ok({ count: (res.apps ?? []).length, ...res });
      } catch (e) {
        return err(e);
      }
    },
  );

  server.tool(
    "get_release_filter_options",
    'List the tracks and releases that vitals metrics can be filtered by. Returns tracks[] with displayName, type and servingReleases[] (each with displayName and the versionCodes it contains). Use those version codes to build the filter argument of query_crash_rate, query_anr_rate and the other query_* tools, e.g. "versionCode = 415". Only releases currently serving users are listed, so use list_tracks or list_releases for the full release picture.',
    {
      package_name: packageArg,
    },
    async ({ package_name }) => {
      try {
        const pkg = resolvePackage(package_name, defaultPackageName);
        const res = await client.get(`/apps/${encodeURIComponent(pkg)}:fetchReleaseFilterOptions`);
        return ok(res);
      } catch (e) {
        return err(e);
      }
    },
  );
}
