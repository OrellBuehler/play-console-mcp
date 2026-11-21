import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { readFile } from "node:fs/promises";
import type { GooglePlayClient } from "../play/client.js";
import { ok, err, resolvePackage } from "../play/format.js";
import { packageArg, destructive } from "./shared.js";

export function registerDataSafetyTools(
  server: McpServer,
  client: GooglePlayClient,
  defaultPackageName?: string,
  allowWrites = false,
  allowDestructive = false,
) {
  if (!allowWrites || !allowDestructive) return;

  server.tool(
    "update_data_safety",
    "Replace the app's Data safety declaration (the 'Data safety' section of the store listing, required before an app can be published) with the contents of a Data safety CSV. The CSV must be in Google's format: export the current one from Play Console > App content > Data safety > Export to CSV, edit the answers, then pass it here as file_path or inline as csv (exactly one of the two). This overwrites the whole declaration, takes effect immediately without the edits workflow — there is no validate_only dry run — and the API cannot read the current declaration back, so keep the exported CSV as a backup. Returns an empty object on success; Google rejects a malformed CSV with an error naming the problem.",
    {
      file_path: z
        .string()
        .optional()
        .describe("Absolute path to a local Data safety .csv file exported from the Play Console"),
      csv: z
        .string()
        .optional()
        .describe("The Data safety CSV contents inline, as an alternative to file_path"),
      package_name: packageArg,
    },
    destructive,
    async ({ file_path, csv, package_name }) => {
      try {
        const pkg = resolvePackage(package_name, defaultPackageName);
        if ((file_path === undefined) === (csv === undefined)) {
          throw new Error("Pass exactly one of file_path or csv.");
        }
        const safetyLabels = csv ?? (await readFile(file_path!, "utf8"));
        if (!safetyLabels.trim()) {
          throw new Error("The Data safety CSV is empty.");
        }
        const res = await client.post(`/applications/${encodeURIComponent(pkg)}/dataSafety`, {
          safetyLabels,
        });
        return ok({ packageName: pkg, updated: true, response: res });
      } catch (e) {
        return err(e);
      }
    },
  );
}
