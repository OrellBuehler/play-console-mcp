import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { GooglePlayClient } from "../play/client.js";
import { registerPurchaseTools } from "../tools/purchases.js";

type Handler = (args: any) => Promise<{ content: { text?: string }[]; isError?: boolean }>;

function collect(defaultPackage?: string, allowWrites = true, allowDestructive = true) {
  const tools = new Map<string, Handler>();
  registerPurchaseTools(
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
  "get_orders",
  "get_product_purchase",
  "get_subscription_purchase",
  "list_voided_purchases",
];
const DESTRUCTIVE = [
  "refund_order",
  "acknowledge_product_purchase",
  "consume_product_purchase",
  "acknowledge_subscription_purchase",
  "cancel_subscription_purchase",
  "revoke_subscription_purchase",
  "defer_subscription_purchase",
];

describe("purchase tools", () => {
  let mockFetch: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    mockFetch = vi.fn();
    vi.stubGlobal("fetch", mockFetch);
  });
  afterEach(() => vi.restoreAllMocks());

  it("get_orders repeats the orderIds query param", async () => {
    mockFetch.mockResolvedValueOnce(resp({ orders: [{ orderId: "GPA.1" }] }));
    const res = await tools.get("get_orders")!({ order_ids: ["GPA.1", "GPA.2"] });
    expect(calls(mockFetch)).toEqual([`GET ${APP}/orders:batchGet`]);
    expect(new URL(mockFetch.mock.calls[0][0]).searchParams.getAll("orderIds")).toEqual([
      "GPA.1",
      "GPA.2",
    ]);
    expect(JSON.parse(res.content[0].text!).orders[0].orderId).toBe("GPA.1");
  });

  it("get_product_purchase reads the v2 product purchase", async () => {
    mockFetch.mockResolvedValueOnce(resp({ orderId: "GPA.1" }));
    await tools.get("get_product_purchase")!({ token: "tok/1" });
    expect(calls(mockFetch)).toEqual([`GET ${APP}/purchases/productsv2/tokens/tok%2F1`]);
  });

  it("get_subscription_purchase reads the v2 subscription purchase", async () => {
    mockFetch.mockResolvedValueOnce(resp({ subscriptionState: "SUBSCRIPTION_STATE_ACTIVE" }));
    await tools.get("get_subscription_purchase")!({ token: "t1" });
    expect(calls(mockFetch)).toEqual([`GET ${APP}/purchases/subscriptionsv2/tokens/t1`]);
  });

  it("list_voided_purchases maps the filters to query params", async () => {
    mockFetch.mockResolvedValue(resp({ voidedPurchases: [] }));
    await tools.get("list_voided_purchases")!({});
    await tools.get("list_voided_purchases")!({
      start_time: "1",
      end_time: "2",
      include_subscriptions: true,
      include_quantity_based_partial_refund: true,
      max_results: 50,
      token: "next",
    });
    expect(calls(mockFetch)).toEqual([
      `GET ${APP}/purchases/voidedpurchases`,
      `GET ${APP}/purchases/voidedpurchases`,
    ]);
    expect(query(mockFetch)).toEqual({});
    expect(query(mockFetch, 1)).toEqual({
      startTime: "1",
      endTime: "2",
      type: "1",
      includeQuantityBasedPartialRefund: "true",
      maxResults: "50",
      token: "next",
    });
  });

  it("refund_order posts to :refund without a body", async () => {
    mockFetch.mockResolvedValue(resp(""));
    const res = await tools.get("refund_order")!({ order_id: "GPA.1" });
    await tools.get("refund_order")!({ order_id: "GPA.1", revoke: true });
    expect(calls(mockFetch)).toEqual([
      `POST ${APP}/orders/GPA.1:refund`,
      `POST ${APP}/orders/GPA.1:refund`,
    ]);
    expect(mockFetch.mock.calls[0][1].body).toBeUndefined();
    expect(query(mockFetch)).toEqual({});
    expect(query(mockFetch, 1)).toEqual({ revoke: "true" });
    expect(JSON.parse(res.content[0].text!)).toEqual({
      packageName: "com.acme.app",
      refundedOrder: "GPA.1",
      revoked: false,
    });
  });

  it("acknowledge_product_purchase and consume_product_purchase post to their verbs", async () => {
    mockFetch.mockResolvedValue(resp(""));
    const args = { product_id: "coins", token: "t1" };
    await tools.get("acknowledge_product_purchase")!({ ...args, developer_payload: "p" });
    await tools.get("consume_product_purchase")!(args);
    expect(calls(mockFetch)).toEqual([
      `POST ${APP}/purchases/products/coins/tokens/t1:acknowledge`,
      `POST ${APP}/purchases/products/coins/tokens/t1:consume`,
    ]);
    expect(body(mockFetch)).toEqual({ developerPayload: "p" });
  });

  it("acknowledge_subscription_purchase posts to the v1 acknowledge verb", async () => {
    mockFetch.mockResolvedValueOnce(resp(""));
    await tools.get("acknowledge_subscription_purchase")!({
      subscription_id: "premium",
      token: "t1",
    });
    expect(calls(mockFetch)).toEqual([
      `POST ${APP}/purchases/subscriptions/premium/tokens/t1:acknowledge`,
    ]);
    expect(body(mockFetch)).toEqual({});
  });

  it("cancel_subscription_purchase sends the cancellation type", async () => {
    mockFetch.mockResolvedValueOnce(resp({}));
    await tools.get("cancel_subscription_purchase")!({
      token: "t1",
      cancellation_type: "DEVELOPER_REQUESTED_STOP_PAYMENTS",
    });
    expect(calls(mockFetch)).toEqual([`POST ${APP}/purchases/subscriptionsv2/tokens/t1:cancel`]);
    expect(body(mockFetch)).toEqual({
      cancellationContext: { cancellationType: "DEVELOPER_REQUESTED_STOP_PAYMENTS" },
    });
  });

  it("revoke_subscription_purchase sends the refund type", async () => {
    mockFetch.mockResolvedValue(resp({}));
    await tools.get("revoke_subscription_purchase")!({ token: "t1", refund: "full" });
    await tools.get("revoke_subscription_purchase")!({ token: "t1", refund: "prorated" });
    expect(calls(mockFetch)).toEqual([
      `POST ${APP}/purchases/subscriptionsv2/tokens/t1:revoke`,
      `POST ${APP}/purchases/subscriptionsv2/tokens/t1:revoke`,
    ]);
    expect(body(mockFetch)).toEqual({ revocationContext: { fullRefund: {} } });
    expect(body(mockFetch, 1)).toEqual({ revocationContext: { proratedRefund: {} } });
  });

  it("defer_subscription_purchase sends the deferral context", async () => {
    mockFetch.mockResolvedValueOnce(resp({ itemExpiryTimeDetails: [] }));
    await tools.get("defer_subscription_purchase")!({
      token: "t1",
      defer_duration: "604800s",
      etag: "e1",
      validate_only: true,
    });
    expect(calls(mockFetch)).toEqual([`POST ${APP}/purchases/subscriptionsv2/tokens/t1:defer`]);
    expect(body(mockFetch)).toEqual({
      deferralContext: { deferDuration: "604800s", etag: "e1", validateOnly: true },
    });
  });

  it("registers the writes only when writes and destructive tools are both allowed", () => {
    expect([...collect("com.acme.app", false, false).keys()]).toEqual(READ);
    expect([...collect("com.acme.app", true, false).keys()]).toEqual(READ);
    expect([...collect("com.acme.app", false, true).keys()]).toEqual(READ);
    expect([...collect("com.acme.app", true, true).keys()]).toEqual([...READ, ...DESTRUCTIVE]);
  });

  it("errors when no package name is available", async () => {
    const res = await collect().get("get_orders")!({ order_ids: ["GPA.1"] });
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain("No package name given");
  });
});
