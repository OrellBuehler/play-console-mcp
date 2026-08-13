import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { GooglePlayClient } from "./play/client.js";
import { registerReviewTools } from "./tools/reviews.js";
import { registerReleaseTools } from "./tools/releases.js";
import { registerListingTools } from "./tools/listings.js";
import { registerArtifactTools } from "./tools/artifacts.js";
import { registerRecoveryTools } from "./tools/recovery.js";
import { registerVitalsTools } from "./tools/vitals.js";

export function createServer(
  client: GooglePlayClient,
  reportingClient: GooglePlayClient,
  packageName?: string,
  allowDestructive = false,
): McpServer {
  const server = new McpServer({ name: "play-console-mcp", version: "0.2.0" });
  registerReviewTools(server, client, packageName);
  registerReleaseTools(server, client, packageName);
  registerListingTools(server, client, packageName, allowDestructive);
  registerArtifactTools(server, client, packageName);
  registerRecoveryTools(server, client, packageName, allowDestructive);
  registerVitalsTools(server, reportingClient, packageName);
  return server;
}
