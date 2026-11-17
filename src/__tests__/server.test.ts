import { describe, it, expect } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { GooglePlayClient, REPORTING_BASE_URL } from "../play/client.js";
import { createServer } from "../server.js";

const READ_TOOLS = [
  "list_reviews",
  "get_review",
  "list_tracks",
  "get_track",
  "list_releases",
  "get_country_availability",
  "get_testers",
  "list_listings",
  "get_listing",
  "get_app_details",
  "list_listing_images",
  "list_bundles",
  "list_apks",
  "list_generated_apks",
  "get_expansion_file",
  "list_device_tier_configs",
  "get_device_tier_config",
  "list_recovery_actions",
  "query_crash_rate",
  "query_anr_rate",
  "query_error_counts",
  "query_slow_start_rate",
  "query_slow_rendering_rate",
  "query_excessive_wakeup_rate",
  "query_stuck_wakelock_rate",
  "query_lmk_rate",
  "query_bitmap_memory_usage",
  "query_memory_usage",
  "list_anomalies",
  "get_vitals_freshness",
  "search_error_issues",
  "search_error_reports",
  "list_apps",
  "get_release_filter_options",
];

const WRITE_TOOLS = [
  "reply_to_review",
  "promote_release",
  "update_rollout",
  "halt_rollout",
  "create_release",
  "update_release_notes",
  "create_track",
  "update_testers",
  "update_listing",
  "update_app_details",
];

const DESTRUCTIVE_TOOLS = [
  "upload_listing_image",
  "delete_listing",
  "delete_all_listings",
  "delete_listing_image",
  "delete_all_listing_images",
  "create_recovery_action",
  "deploy_recovery_action",
  "add_recovery_targeting",
  "cancel_recovery_action",
];

const UNTRUSTED_TOOLS = [
  "list_reviews",
  "get_review",
  "search_error_issues",
  "search_error_reports",
];

async function listTools(allowWrites?: boolean, allowDestructive?: boolean) {
  const server = createServer(
    new GooglePlayClient(async () => "tok"),
    new GooglePlayClient(async () => "tok", REPORTING_BASE_URL),
    "com.acme.app",
    allowWrites,
    allowDestructive,
  );
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "0.0.0" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  const { tools } = await client.listTools();
  await client.close();
  return tools;
}

const names = (tools: { name: string }[]) => tools.map((t) => t.name).sort();

describe("server", () => {
  it("registers only read-only tools by default", async () => {
    const tools = await listTools();
    expect(names(tools)).toEqual([...READ_TOOLS].sort());
    expect(tools.every((t) => t.annotations?.readOnlyHint === true)).toBe(true);
  });

  it("stays read-only when only destructive tools are allowed", async () => {
    expect(names(await listTools(false, true))).toEqual([...READ_TOOLS].sort());
  });

  it("adds the write tools when writes are allowed", async () => {
    expect(names(await listTools(true, false))).toEqual([...READ_TOOLS, ...WRITE_TOOLS].sort());
  });

  it("adds the destructive tools when writes and destructive tools are allowed", async () => {
    expect(names(await listTools(true, true))).toEqual(
      [...READ_TOOLS, ...WRITE_TOOLS, ...DESTRUCTIVE_TOOLS].sort(),
    );
  });

  it("annotates every tool", async () => {
    for (const tool of await listTools(true, true)) {
      const readOnly = READ_TOOLS.includes(tool.name);
      expect(tool.annotations, tool.name).toBeDefined();
      expect(tool.annotations?.readOnlyHint, tool.name).toBe(readOnly);
      expect(tool.annotations?.openWorldHint, tool.name).toBe(true);
      if (!readOnly) {
        expect(typeof tool.annotations?.destructiveHint, tool.name).toBe("boolean");
        expect(typeof tool.annotations?.idempotentHint, tool.name).toBe("boolean");
      }
      expect(tool.inputSchema.type, tool.name).toBe("object");
    }
  });

  it("marks every delete and overwrite as destructive", async () => {
    const tools = await listTools(true, true);
    const additive = tools.filter((t) => t.annotations?.destructiveHint === false);
    expect(names(additive)).toEqual([
      "create_recovery_action",
      "create_track",
      "upload_listing_image",
    ]);
  });

  it("flags tools returning third-party text as untrusted", async () => {
    const tools = await listTools(true, true);
    const flagged = tools.filter((t) => t.description?.includes("untrusted content"));
    expect(names(flagged)).toEqual([...UNTRUSTED_TOOLS].sort());
  });
});
