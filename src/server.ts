import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { GooglePlayClient } from "./play/client.js";
import { registerReviewTools } from "./tools/reviews.js";
import { registerReleaseTools } from "./tools/releases.js";
import { registerListingTools } from "./tools/listings.js";
import { registerArtifactTools } from "./tools/artifacts.js";
import { registerRecoveryTools } from "./tools/recovery.js";
import { registerVitalsTools } from "./tools/vitals.js";
import { registerAppsTools } from "./tools/apps.js";
import { registerDataSafetyTools } from "./tools/datasafety.js";
import { registerSubscriptionTools } from "./tools/subscriptions.js";
import { registerProductTools } from "./tools/products.js";
import { registerPurchaseTools } from "./tools/purchases.js";
import { registerUserTools } from "./tools/users.js";

export function createServer(
  client: GooglePlayClient,
  reportingClient: GooglePlayClient,
  packageName?: string,
  allowWrites = false,
  allowDestructive = false,
  developerId?: string,
): McpServer {
  const server = new McpServer({ name: "play-console-mcp", version: "0.6.0" });
  registerReviewTools(server, client, packageName, allowWrites);
  registerReleaseTools(server, client, packageName, allowWrites);
  registerListingTools(server, client, packageName, allowWrites, allowDestructive);
  registerArtifactTools(server, client, packageName, allowWrites, allowDestructive);
  registerRecoveryTools(server, client, packageName, allowWrites, allowDestructive);
  registerDataSafetyTools(server, client, packageName, allowWrites, allowDestructive);
  registerSubscriptionTools(server, client, packageName, allowWrites, allowDestructive);
  registerProductTools(server, client, packageName, allowWrites, allowDestructive);
  registerPurchaseTools(server, client, packageName, allowWrites, allowDestructive);
  registerUserTools(server, client, packageName, developerId, allowWrites, allowDestructive);
  registerVitalsTools(server, reportingClient, packageName);
  registerAppsTools(server, reportingClient, packageName);
  return server;
}
