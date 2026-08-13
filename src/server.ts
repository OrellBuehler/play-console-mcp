import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { GooglePlayClient } from "./play/client.js";
import { registerReviewTools } from "./tools/reviews.js";
import { registerReleaseTools } from "./tools/releases.js";
import { registerVitalsTools } from "./tools/vitals.js";

export function createServer(
  client: GooglePlayClient,
  reportingClient: GooglePlayClient,
  packageName?: string,
): McpServer {
  const server = new McpServer({ name: "play-console-mcp", version: "0.1.0" });
  registerReviewTools(server, client, packageName);
  registerReleaseTools(server, client, packageName);
  registerVitalsTools(server, reportingClient, packageName);
  return server;
}
