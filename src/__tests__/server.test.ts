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
  "list_subscriptions",
  "get_subscription",
  "list_subscription_offers",
  "get_subscription_offer",
  "list_one_time_products",
  "get_one_time_product",
  "list_one_time_product_offers",
  "convert_region_prices",
  "get_orders",
  "get_product_purchase",
  "get_subscription_purchase",
  "list_voided_purchases",
  "list_users",
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
  "create_device_tier_config",
  "create_subscription",
  "update_subscription",
  "set_base_plan_state",
  "create_subscription_offer",
  "update_subscription_offer",
  "set_subscription_offer_state",
  "update_one_time_product",
  "set_purchase_option_state",
  "update_one_time_product_offer",
  "set_one_time_product_offer_state",
];

const DESTRUCTIVE_TOOLS = [
  "upload_listing_image",
  "delete_listing",
  "delete_all_listings",
  "delete_listing_image",
  "delete_all_listing_images",
  "upload_bundle",
  "create_recovery_action",
  "deploy_recovery_action",
  "add_recovery_targeting",
  "cancel_recovery_action",
  "update_data_safety",
  "migrate_base_plan_prices",
  "delete_subscription",
  "delete_base_plan",
  "delete_subscription_offer",
  "delete_one_time_product",
  "delete_purchase_option",
  "delete_one_time_product_offer",
  "refund_order",
  "acknowledge_product_purchase",
  "consume_product_purchase",
  "acknowledge_subscription_purchase",
  "cancel_subscription_purchase",
  "revoke_subscription_purchase",
  "defer_subscription_purchase",
  "create_user",
  "update_user",
  "delete_user",
  "create_grant",
  "update_grant",
  "delete_grant",
];

const UNTRUSTED_TOOLS = [
  "list_reviews",
  "get_review",
  "get_subscription_purchase",
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
      "create_device_tier_config",
      "create_grant",
      "create_recovery_action",
      "create_subscription",
      "create_subscription_offer",
      "create_track",
      "create_user",
      "upload_listing_image",
    ]);
  });

  it("flags tools returning third-party text as untrusted", async () => {
    const tools = await listTools(true, true);
    const flagged = tools.filter((t) => t.description?.includes("untrusted content"));
    expect(names(flagged)).toEqual([...UNTRUSTED_TOOLS].sort());
  });
});
