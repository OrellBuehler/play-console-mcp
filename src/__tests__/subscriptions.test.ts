import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { GooglePlayClient } from "../play/client.js";
import { registerSubscriptionTools } from "../tools/subscriptions.js";

type Handler = (args: any) => Promise<{ content: { text?: string }[]; isError?: boolean }>;

function collect(defaultPackage?: string, allowWrites = true, allowDestructive = true) {
  const tools = new Map<string, Handler>();
  registerSubscriptionTools(
    {
      tool: (n: string, _d: string, _s: unknown, _a: unknown, h: Handler) => tools.set(n, h),
    } as any,
    new GooglePlayClient(async () => "tok"),
    defaultPackage,
    allowWrites,
    allowDestructive,
  );
  return tools;
}

function resp(body: unknown) {
  const text = typeof body === "string" ? body : JSON.stringify(body);
  return {
    ok: true,
    status: 200,
    statusText: "OK",
    text: () => Promise.resolve(text),
    json: () => Promise.resolve(JSON.parse(text)),
  };
}

const tools = collect("com.acme.app");
const APP = "/androidpublisher/v3/applications/com.acme.app";

function calls(mockFetch: ReturnType<typeof vi.fn>) {
  return mockFetch.mock.calls.map((c) => `${c[1]?.method ?? "GET"} ${new URL(c[0]).pathname}`);
}

function query(mockFetch: ReturnType<typeof vi.fn>, call = 0) {
  return Object.fromEntries(new URL(mockFetch.mock.calls[call][0]).searchParams);
}

function body(mockFetch: ReturnType<typeof vi.fn>, call = 0) {
  return JSON.parse(mockFetch.mock.calls[call][1].body);
}

const READ = [
  "list_subscriptions",
  "get_subscription",
  "list_subscription_offers",
  "get_subscription_offer",
];
const WRITE = [
  "create_subscription",
  "update_subscription",
  "set_base_plan_state",
  "create_subscription_offer",
  "update_subscription_offer",
  "set_subscription_offer_state",
];
const DESTRUCTIVE = [
  "migrate_base_plan_prices",
  "delete_subscription",
  "delete_base_plan",
  "delete_subscription_offer",
];

describe("subscription tools", () => {
  let mockFetch: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    mockFetch = vi.fn();
    vi.stubGlobal("fetch", mockFetch);
  });
  afterEach(() => vi.restoreAllMocks());

  it("list_subscriptions passes paging through", async () => {
    mockFetch.mockResolvedValueOnce(resp({ subscriptions: [{ productId: "premium" }] }));
    const res = await tools.get("list_subscriptions")!({ page_size: 10, page_token: "p2" });
    expect(calls(mockFetch)).toEqual([`GET ${APP}/subscriptions`]);
    expect(query(mockFetch)).toEqual({ pageSize: "10", pageToken: "p2" });
    expect(JSON.parse(res.content[0].text!).subscriptions[0].productId).toBe("premium");
  });

  it("get_subscription reads one product", async () => {
    mockFetch.mockResolvedValueOnce(resp({ productId: "premium" }));
    await tools.get("get_subscription")!({ product_id: "premium" });
    expect(calls(mockFetch)).toEqual([`GET ${APP}/subscriptions/premium`]);
  });

  it("list_subscription_offers uses '-' wildcards for omitted ids", async () => {
    mockFetch.mockResolvedValue(resp({ subscriptionOffers: [] }));
    await tools.get("list_subscription_offers")!({});
    await tools.get("list_subscription_offers")!({ product_id: "premium" });
    await tools.get("list_subscription_offers")!({
      product_id: "premium",
      base_plan_id: "monthly",
    });
    expect(calls(mockFetch)).toEqual([
      `GET ${APP}/subscriptions/-/basePlans/-/offers`,
      `GET ${APP}/subscriptions/premium/basePlans/-/offers`,
      `GET ${APP}/subscriptions/premium/basePlans/monthly/offers`,
    ]);
  });

  it("list_subscription_offers rejects a base plan without a product", async () => {
    const res = await tools.get("list_subscription_offers")!({ base_plan_id: "monthly" });
    expect(res.isError).toBe(true);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("get_subscription_offer reads one offer", async () => {
    mockFetch.mockResolvedValueOnce(resp({ offerId: "trial" }));
    await tools.get("get_subscription_offer")!({
      product_id: "premium",
      base_plan_id: "monthly",
      offer_id: "trial",
    });
    expect(calls(mockFetch)).toEqual([
      `GET ${APP}/subscriptions/premium/basePlans/monthly/offers/trial`,
    ]);
  });

  it("create_subscription posts the resource with ids and the regions version", async () => {
    mockFetch.mockResolvedValueOnce(resp({ productId: "premium" }));
    await tools.get("create_subscription")!({
      product_id: "premium",
      subscription: { listings: [{ languageCode: "en-US", title: "Premium" }] },
      regions_version: "2022/02",
    });
    expect(calls(mockFetch)).toEqual([`POST ${APP}/subscriptions`]);
    expect(query(mockFetch)).toEqual({ productId: "premium", "regionsVersion.version": "2022/02" });
    expect(body(mockFetch)).toEqual({
      listings: [{ languageCode: "en-US", title: "Premium" }],
      packageName: "com.acme.app",
      productId: "premium",
    });
  });

  it("update_subscription patches with the update mask", async () => {
    mockFetch.mockResolvedValueOnce(resp({ productId: "premium" }));
    await tools.get("update_subscription")!({
      product_id: "premium",
      subscription: { basePlans: [{ basePlanId: "monthly" }] },
      update_mask: "basePlans",
      regions_version: "2022/02",
      allow_missing: true,
    });
    expect(calls(mockFetch)).toEqual([`PATCH ${APP}/subscriptions/premium`]);
    expect(query(mockFetch)).toEqual({
      updateMask: "basePlans",
      "regionsVersion.version": "2022/02",
      allowMissing: "true",
    });
    expect(body(mockFetch)).toEqual({
      basePlans: [{ basePlanId: "monthly" }],
      packageName: "com.acme.app",
      productId: "premium",
    });
  });

  it("set_base_plan_state posts to the activate and deactivate verbs", async () => {
    mockFetch.mockResolvedValue(resp({ productId: "premium" }));
    const args = { product_id: "premium", base_plan_id: "monthly" };
    await tools.get("set_base_plan_state")!({ ...args, state: "activate" });
    await tools.get("set_base_plan_state")!({ ...args, state: "deactivate" });
    expect(calls(mockFetch)).toEqual([
      `POST ${APP}/subscriptions/premium/basePlans/monthly:activate`,
      `POST ${APP}/subscriptions/premium/basePlans/monthly:deactivate`,
    ]);
    expect(body(mockFetch)).toEqual({
      packageName: "com.acme.app",
      productId: "premium",
      basePlanId: "monthly",
    });
  });

  it("create_subscription_offer posts the offer with its ids", async () => {
    mockFetch.mockResolvedValueOnce(resp({ offerId: "trial" }));
    await tools.get("create_subscription_offer")!({
      product_id: "premium",
      base_plan_id: "monthly",
      offer_id: "trial",
      offer: { phases: [{ duration: "P7D", recurrenceCount: 1 }] },
      regions_version: "2022/02",
    });
    expect(calls(mockFetch)).toEqual([
      `POST ${APP}/subscriptions/premium/basePlans/monthly/offers`,
    ]);
    expect(query(mockFetch)).toEqual({ offerId: "trial", "regionsVersion.version": "2022/02" });
    expect(body(mockFetch)).toEqual({
      phases: [{ duration: "P7D", recurrenceCount: 1 }],
      packageName: "com.acme.app",
      productId: "premium",
      basePlanId: "monthly",
      offerId: "trial",
    });
  });

  it("update_subscription_offer patches with the update mask", async () => {
    mockFetch.mockResolvedValueOnce(resp({ offerId: "trial" }));
    await tools.get("update_subscription_offer")!({
      product_id: "premium",
      base_plan_id: "monthly",
      offer_id: "trial",
      offer: { offerTags: [{ tag: "promo" }] },
      update_mask: "offerTags",
      regions_version: "2022/02",
    });
    expect(calls(mockFetch)).toEqual([
      `PATCH ${APP}/subscriptions/premium/basePlans/monthly/offers/trial`,
    ]);
    expect(query(mockFetch)).toEqual({
      updateMask: "offerTags",
      "regionsVersion.version": "2022/02",
    });
    expect(body(mockFetch).offerTags).toEqual([{ tag: "promo" }]);
    expect(body(mockFetch).offerId).toBe("trial");
  });

  it("set_subscription_offer_state posts to the state verb", async () => {
    mockFetch.mockResolvedValueOnce(resp({ offerId: "trial" }));
    await tools.get("set_subscription_offer_state")!({
      product_id: "premium",
      base_plan_id: "monthly",
      offer_id: "trial",
      state: "deactivate",
    });
    expect(calls(mockFetch)).toEqual([
      `POST ${APP}/subscriptions/premium/basePlans/monthly/offers/trial:deactivate`,
    ]);
    expect(body(mockFetch)).toEqual({
      packageName: "com.acme.app",
      productId: "premium",
      basePlanId: "monthly",
      offerId: "trial",
    });
  });

  it("migrate_base_plan_prices posts the regional migrations", async () => {
    mockFetch.mockResolvedValueOnce(resp({}));
    const migrations = [
      { regionCode: "US", oldestAllowedPriceVersionTime: "2026-01-01T00:00:00Z" },
    ];
    await tools.get("migrate_base_plan_prices")!({
      product_id: "premium",
      base_plan_id: "monthly",
      regional_price_migrations: migrations,
      regions_version: "2022/02",
    });
    expect(calls(mockFetch)).toEqual([
      `POST ${APP}/subscriptions/premium/basePlans/monthly:migratePrices`,
    ]);
    expect(body(mockFetch)).toEqual({
      packageName: "com.acme.app",
      productId: "premium",
      basePlanId: "monthly",
      regionalPriceMigrations: migrations,
      regionsVersion: { version: "2022/02" },
    });
  });

  it("the delete tools send DELETE to the resource", async () => {
    mockFetch.mockResolvedValue(resp(""));
    const ids = { product_id: "premium", base_plan_id: "monthly", offer_id: "trial" };
    await tools.get("delete_subscription")!(ids);
    await tools.get("delete_base_plan")!(ids);
    const res = await tools.get("delete_subscription_offer")!(ids);
    expect(calls(mockFetch)).toEqual([
      `DELETE ${APP}/subscriptions/premium`,
      `DELETE ${APP}/subscriptions/premium/basePlans/monthly`,
      `DELETE ${APP}/subscriptions/premium/basePlans/monthly/offers/trial`,
    ]);
    expect(JSON.parse(res.content[0].text!).deletedOffer).toBe("trial");
  });

  it("registers tools per gate level", () => {
    expect([...collect("com.acme.app", false, false).keys()]).toEqual(READ);
    expect([...collect("com.acme.app", false, true).keys()]).toEqual(READ);
    expect([...collect("com.acme.app", true, false).keys()]).toEqual([...READ, ...WRITE]);
    expect([...collect("com.acme.app", true, true).keys()]).toEqual([
      ...READ,
      ...WRITE,
      ...DESTRUCTIVE,
    ]);
  });

  it("errors when no package name is available", async () => {
    const res = await collect().get("list_subscriptions")!({});
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain("No package name given");
  });
});
