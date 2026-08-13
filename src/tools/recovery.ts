import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { GooglePlayClient } from "../play/client.js";
import { ok, err, resolvePackage } from "../play/format.js";
import { packageArg } from "./shared.js";

const targetingShape = {
  all_users: z
    .boolean()
    .optional()
    .describe("Target every user of the app. Mutually exclusive with the other targeting fields."),
  region_codes: z
    .array(z.string())
    .optional()
    .describe("Two-letter uppercase region codes to target, e.g. ['DE','CH']"),
  sdk_levels: z
    .array(z.string())
    .optional()
    .describe("Android SDK levels to target, as strings, e.g. ['33','34']"),
  version_codes: z
    .array(z.string())
    .optional()
    .describe("Specific app version codes to target, e.g. ['415']. Get them from list_bundles."),
};

interface TargetingArgs {
  all_users?: boolean;
  region_codes?: string[];
  sdk_levels?: string[];
  version_codes?: string[];
}

function buildTargeting(args: TargetingArgs): Record<string, unknown> {
  const targeting: Record<string, unknown> = {};
  if (args.all_users) targeting.allUsers = { isAllUsersRequested: true };
  if (args.region_codes?.length) targeting.regions = { regionCode: args.region_codes };
  if (args.sdk_levels?.length) targeting.androidSdks = { sdkLevels: args.sdk_levels };
  if (args.version_codes?.length) targeting.versionList = { versionCodes: args.version_codes };
  if (Object.keys(targeting).length === 0) {
    throw new Error(
      "No targeting given. Pass all_users, or one of region_codes / sdk_levels / version_codes.",
    );
  }
  return targeting;
}

function recoveryBase(pkg: string): string {
  return `/applications/${encodeURIComponent(pkg)}/appRecoveries`;
}

export function registerRecoveryTools(
  server: McpServer,
  client: GooglePlayClient,
  defaultPackageName?: string,
  allowDestructive = false,
) {
  server.tool(
    "list_recovery_actions",
    "List the app recovery actions targeting a version code, each with appRecoveryId, status (DRAFT, ACTIVE, CANCELED, GENERATION_IN_PROGRESS, GENERATION_FAILED), targeting and timestamps. Recovery actions push a remote in-app update to users stuck on a broken release — use query_crash_rate and search_error_issues first to confirm which version is broken.",
    {
      version_code: z
        .string()
        .describe("Version code the recovery actions target, e.g. '415'. Required by the API."),
      package_name: packageArg,
    },
    async ({ version_code, package_name }) => {
      try {
        const pkg = resolvePackage(package_name, defaultPackageName);
        const res = await client.get(recoveryBase(pkg), { versionCode: version_code });
        return ok(res);
      } catch (e) {
        return err(e);
      }
    },
  );

  if (!allowDestructive) return;

  server.tool(
    "create_recovery_action",
    "Create a draft app recovery action that pushes a remote in-app update to affected users. The action is created as a draft and does nothing until deploy_recovery_action is called. Recovery actions do not go through the edits workflow, so there is no validate_only dry run.",
    {
      ...targetingShape,
      package_name: packageArg,
    },
    async ({ all_users, region_codes, sdk_levels, version_codes, package_name }) => {
      try {
        const pkg = resolvePackage(package_name, defaultPackageName);
        const targeting = buildTargeting({ all_users, region_codes, sdk_levels, version_codes });
        const res = await client.post(recoveryBase(pkg), {
          targeting,
          remoteInAppUpdate: { isRemoteInAppUpdateRequested: true },
        });
        return ok(res);
      } catch (e) {
        return err(e);
      }
    },
  );

  server.tool(
    "deploy_recovery_action",
    "Deploy a draft app recovery action, starting the remote in-app update for the targeted users. This is user-visible and takes effect immediately — confirm the targeting with list_recovery_actions first. Use cancel_recovery_action to stop it afterwards.",
    {
      recovery_id: z
        .string()
        .describe("appRecoveryId of the draft action, from list_recovery_actions"),
      package_name: packageArg,
    },
    async ({ recovery_id, package_name }) => {
      try {
        const pkg = resolvePackage(package_name, defaultPackageName);
        const res = await client.post(
          `${recoveryBase(pkg)}/${encodeURIComponent(recovery_id)}:deploy`,
          {},
        );
        return ok(res);
      } catch (e) {
        return err(e);
      }
    },
  );

  server.tool(
    "add_recovery_targeting",
    "Widen the targeting of an existing app recovery action, e.g. add more regions or SDK levels. Targeting can only be added, never removed. Get the appRecoveryId from list_recovery_actions.",
    {
      recovery_id: z.string().describe("appRecoveryId of the action, from list_recovery_actions"),
      ...targetingShape,
      package_name: packageArg,
    },
    async ({ recovery_id, all_users, region_codes, sdk_levels, version_codes, package_name }) => {
      try {
        const pkg = resolvePackage(package_name, defaultPackageName);
        const targetingUpdate = buildTargeting({
          all_users,
          region_codes,
          sdk_levels,
          version_codes,
        });
        const res = await client.post(
          `${recoveryBase(pkg)}/${encodeURIComponent(recovery_id)}:addTargeting`,
          { targetingUpdate },
        );
        return ok(res);
      } catch (e) {
        return err(e);
      }
    },
  );

  server.tool(
    "cancel_recovery_action",
    "Cancel an app recovery action, stopping the remote in-app update for users who have not received it yet. Users already updated keep the update. Get the appRecoveryId from list_recovery_actions.",
    {
      recovery_id: z.string().describe("appRecoveryId of the action, from list_recovery_actions"),
      package_name: packageArg,
    },
    async ({ recovery_id, package_name }) => {
      try {
        const pkg = resolvePackage(package_name, defaultPackageName);
        const res = await client.post(
          `${recoveryBase(pkg)}/${encodeURIComponent(recovery_id)}:cancel`,
          {},
        );
        return ok(res);
      } catch (e) {
        return err(e);
      }
    },
  );
}
