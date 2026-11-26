import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { GooglePlayClient } from "../play/client.js";
import { ok, err, resolvePackage, resolveDeveloper } from "../play/format.js";
import { packageArg, readOnly, additive, destructive } from "./shared.js";

const developerArg = z
  .string()
  .optional()
  .describe(
    "Developer account ID: the number in the Play Console URL, play.google.com/console/developers/<id> (defaults to GOOGLE_PLAY_DEVELOPER_ID)",
  );
const emailArg = z.string().describe("Email address of the user. Get users from list_users.");
const accountPermissionsArg = z
  .array(z.string())
  .describe(
    "Permissions that apply to every app in the developer account, e.g. ['CAN_VIEW_NON_FINANCIAL_DATA_GLOBAL','CAN_REPLY_TO_REVIEWS_GLOBAL']. Others: CAN_VIEW_FINANCIAL_DATA_GLOBAL, CAN_VIEW_APP_QUALITY_GLOBAL, CAN_MANAGE_TRACK_APKS_GLOBAL (release to testing), CAN_MANAGE_TRACK_USERS_GLOBAL, CAN_MANAGE_PUBLIC_APKS_GLOBAL (release to production), CAN_MANAGE_PUBLIC_LISTING_GLOBAL, CAN_MANAGE_APP_CONTENT_GLOBAL, CAN_MANAGE_ORDERS_GLOBAL, CAN_MANAGE_DRAFT_APPS_GLOBAL, CAN_MANAGE_DEEPLINKS_GLOBAL, CAN_MANAGE_PERMISSIONS_GLOBAL (admin, all permissions). Pass [] for a user who only gets per-app grants.",
  );
const appPermissionsArg = z
  .array(z.string())
  .min(1)
  .describe(
    "Permissions for this one app, e.g. ['CAN_VIEW_NON_FINANCIAL_DATA','CAN_REPLY_TO_REVIEWS']. Others: CAN_VIEW_FINANCIAL_DATA, CAN_VIEW_APP_QUALITY, CAN_MANAGE_TRACK_APKS (release to testing), CAN_MANAGE_TRACK_USERS, CAN_MANAGE_PUBLIC_APKS (release to production), CAN_MANAGE_PUBLIC_LISTING, CAN_MANAGE_APP_CONTENT, CAN_MANAGE_ORDERS, CAN_MANAGE_DRAFT_APPS, CAN_MANAGE_DEEPLINKS, CAN_MANAGE_PERMISSIONS (admin, all permissions).",
  );
const expirationArg = z
  .string()
  .optional()
  .describe(
    "RFC 3339 timestamp in the future at which the user's access ends, e.g. '2027-01-01T00:00:00Z'",
  );

function usersBase(developer: string): string {
  return `/developers/${encodeURIComponent(developer)}/users`;
}

function userName(developer: string, email: string): string {
  return `developers/${developer}/users/${email}`;
}

export function registerUserTools(
  server: McpServer,
  client: GooglePlayClient,
  defaultPackageName?: string,
  defaultDeveloperId?: string,
  allowWrites = false,
  allowDestructive = false,
) {
  server.tool(
    "list_users",
    "List every user with access to the Play Console developer account. Each has email, name (developers/<id>/users/<email>), accessState (INVITED, INVITATION_EXPIRED, ACCESS_GRANTED, ACCESS_EXPIRED), developerAccountPermissions (account-wide), grants (per-app permissions, each with packageName and appLevelPermissions), expirationTime and partial (true when the service account cannot see all of the user's permissions). The service account needs the admin permission on the account for this.",
    {
      developer_id: developerArg,
    },
    readOnly,
    async ({ developer_id }) => {
      try {
        const developer = resolveDeveloper(developer_id, defaultDeveloperId);
        const res = await client.get(usersBase(developer), { pageSize: -1 });
        return ok(res);
      } catch (e) {
        return err(e);
      }
    },
  );

  if (!allowWrites || !allowDestructive) return;

  server.tool(
    "create_user",
    "Invite a user to the Play Console developer account. Google emails them an invitation, and once accepted they hold the given account-wide permissions on every app. For access to single apps, pass an empty developer_account_permissions and add grants with create_grant. Returns the created user.",
    {
      email: z.string().describe("Email address (Google account) of the user to invite"),
      developer_account_permissions: accountPermissionsArg,
      expiration_time: expirationArg,
      developer_id: developerArg,
    },
    additive,
    async ({ email, developer_account_permissions, expiration_time, developer_id }) => {
      try {
        const developer = resolveDeveloper(developer_id, defaultDeveloperId);
        const res = await client.post(usersBase(developer), {
          name: userName(developer, email),
          email,
          developerAccountPermissions: developer_account_permissions,
          ...(expiration_time === undefined ? {} : { expirationTime: expiration_time }),
        });
        return ok(res);
      } catch (e) {
        return err(e);
      }
    },
  );

  server.tool(
    "update_user",
    "Change a user's account-wide permissions or the time their access expires. developer_account_permissions replaces the user's whole list of account-wide permissions, so include every one they should keep — see list_users. Only the fields you pass are changed; per-app grants are untouched (use update_grant). Returns the updated user.",
    {
      email: emailArg,
      developer_account_permissions: accountPermissionsArg.optional(),
      expiration_time: expirationArg,
      developer_id: developerArg,
    },
    destructive,
    async ({ email, developer_account_permissions, expiration_time, developer_id }) => {
      try {
        const developer = resolveDeveloper(developer_id, defaultDeveloperId);
        const updateMask = [
          ...(developer_account_permissions === undefined ? [] : ["developerAccountPermissions"]),
          ...(expiration_time === undefined ? [] : ["expirationTime"]),
        ];
        if (updateMask.length === 0) {
          throw new Error(
            "Nothing to update. Pass developer_account_permissions and/or expiration_time.",
          );
        }
        const res = await client.patch(
          `${usersBase(developer)}/${encodeURIComponent(email)}`,
          {
            name: userName(developer, email),
            email,
            ...(developer_account_permissions === undefined
              ? {}
              : { developerAccountPermissions: developer_account_permissions }),
            ...(expiration_time === undefined ? {} : { expirationTime: expiration_time }),
          },
          { updateMask: updateMask.join(",") },
        );
        return ok(res);
      } catch (e) {
        return err(e);
      }
    },
  );

  server.tool(
    "delete_user",
    "Remove a user from the Play Console developer account, taking away all their access including every per-app grant. To restore it they must be invited again with create_user.",
    {
      email: emailArg,
      developer_id: developerArg,
    },
    destructive,
    async ({ email, developer_id }) => {
      try {
        const developer = resolveDeveloper(developer_id, defaultDeveloperId);
        await client.del(`${usersBase(developer)}/${encodeURIComponent(email)}`);
        return ok({ developerId: developer, deletedUser: email });
      } catch (e) {
        return err(e);
      }
    },
  );

  server.tool(
    "create_grant",
    "Give an existing user permissions on one app. The user must already be in the developer account (create_user) and must not have a grant for this app yet — use update_grant to change one. Returns the created grant.",
    {
      email: emailArg,
      app_level_permissions: appPermissionsArg,
      package_name: packageArg,
      developer_id: developerArg,
    },
    additive,
    async ({ email, app_level_permissions, package_name, developer_id }) => {
      try {
        const developer = resolveDeveloper(developer_id, defaultDeveloperId);
        const pkg = resolvePackage(package_name, defaultPackageName);
        const res = await client.post(
          `${usersBase(developer)}/${encodeURIComponent(email)}/grants`,
          {
            name: `${userName(developer, email)}/grants/${pkg}`,
            packageName: pkg,
            appLevelPermissions: app_level_permissions,
          },
        );
        return ok(res);
      } catch (e) {
        return err(e);
      }
    },
  );

  server.tool(
    "update_grant",
    "Replace the permissions a user has on one app. app_level_permissions replaces the whole list, so include every permission they should keep — see the grants in list_users. Returns the updated grant.",
    {
      email: emailArg,
      app_level_permissions: appPermissionsArg,
      package_name: packageArg,
      developer_id: developerArg,
    },
    destructive,
    async ({ email, app_level_permissions, package_name, developer_id }) => {
      try {
        const developer = resolveDeveloper(developer_id, defaultDeveloperId);
        const pkg = resolvePackage(package_name, defaultPackageName);
        const res = await client.patch(
          `${usersBase(developer)}/${encodeURIComponent(email)}/grants/${encodeURIComponent(pkg)}`,
          {
            name: `${userName(developer, email)}/grants/${pkg}`,
            packageName: pkg,
            appLevelPermissions: app_level_permissions,
          },
          { updateMask: "appLevelPermissions" },
        );
        return ok(res);
      } catch (e) {
        return err(e);
      }
    },
  );

  server.tool(
    "delete_grant",
    "Remove all of a user's permissions on one app. The user stays in the developer account and keeps any account-wide permissions and grants on other apps.",
    {
      email: emailArg,
      package_name: packageArg,
      developer_id: developerArg,
    },
    destructive,
    async ({ email, package_name, developer_id }) => {
      try {
        const developer = resolveDeveloper(developer_id, defaultDeveloperId);
        const pkg = resolvePackage(package_name, defaultPackageName);
        await client.del(
          `${usersBase(developer)}/${encodeURIComponent(email)}/grants/${encodeURIComponent(pkg)}`,
        );
        return ok({ developerId: developer, email, deletedGrant: pkg });
      } catch (e) {
        return err(e);
      }
    },
  );
}
