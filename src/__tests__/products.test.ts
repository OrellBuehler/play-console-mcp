import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { GooglePlayClient } from "../play/client.js";
import { registerProductTools } from "../tools/products.js";

type Handler = (args: any) => Promise<{ content: { text?: string }[]; isError?: boolean }>;

function collect(defaultPackage?: string, allowWrites = true, allowDestructive = true) {
  const tools = new Map<string, Handler>();
  registerProductTools(
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
  "list_one_time_products",
  "get_one_time_product",
  "list_one_time_product_offers",
  "convert_region_prices",
];
const WRITE = [
  "update_one_time_product",
  "set_purchase_option_state",
  "update_one_time_product_offer",
  "set_one_time_product_offer_state",
];
const DESTRUCTIVE = [
  "delete_one_time_product",
  "delete_purchase_option",
  "delete_one_time_product_offer",
];

describe("one-time product tools", () => {
  let mockFetch: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    mockFetch = vi.fn();
    vi.stubGlobal("fetch", mockFetch);
  });
  afterEach(() => vi.restoreAllMocks());

  it("list_one_time_products passes paging through", async () => {
    mockFetch.mockResolvedValueOnce(resp({ oneTimeProducts: [{ productId: "coins" }] }));
    const res = await tools.get("list_one_time_products")!({ page_size: 5 });
    expect(calls(mockFetch)).toEqual([`GET ${APP}/oneTimeProducts`]);
    expect(query(mockFetch)).toEqual({ pageSize: "5" });
    expect(JSON.parse(res.content[0].text!).oneTimeProducts[0].productId).toBe("coins");
  });

  it("get_one_time_product reads one product", async () => {
    mockFetch.mockResolvedValueOnce(resp({ productId: "coins" }));
    await tools.get("get_one_time_product")!({ product_id: "coins" });
    expect(calls(mockFetch)).toEqual([`GET ${APP}/oneTimeProducts/coins`]);
  });

  it("list_one_time_product_offers uses '-' wildcards for omitted ids", async () => {
    mockFetch.mockResolvedValue(resp({ oneTimeProductOffers: [] }));
    await tools.get("list_one_time_product_offers")!({});
    await tools.get("list_one_time_product_offers")!({
      product_id: "coins",
      purchase_option_id: "buy",
    });
    expect(calls(mockFetch)).toEqual([
      `GET ${APP}/oneTimeProducts/-/purchaseOptions/-/offers`,
      `GET ${APP}/oneTimeProducts/coins/purchaseOptions/buy/offers`,
    ]);
  });

  it("list_one_time_product_offers rejects a purchase option without a product", async () => {
    const res = await tools.get("list_one_time_product_offers")!({ purchase_option_id: "buy" });
    expect(res.isError).toBe(true);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("convert_region_prices turns the decimal amount into units and nanos", async () => {
    mockFetch.mockResolvedValue(resp({ regionVersion: { version: "2022/02" } }));
    await tools.get("convert_region_prices")!({ amount: "4.99", currency_code: "usd" });
    await tools.get("convert_region_prices")!({
      amount: "12",
      currency_code: "CHF",
      product_tax_category_code: "eeaqkz",
    });
    expect(calls(mockFetch)).toEqual([
      `POST ${APP}/pricing:convertRegionPrices`,
      `POST ${APP}/pricing:convertRegionPrices`,
    ]);
    expect(body(mockFetch)).toEqual({
      price: { currencyCode: "USD", units: "4", nanos: 990000000 },
    });
    expect(body(mockFetch, 1)).toEqual({
      price: { currencyCode: "CHF", units: "12", nanos: 0 },
      productTaxCategoryCode: "eeaqkz",
    });
  });

  it("convert_region_prices rejects a malformed amount", async () => {
    const res = await tools.get("convert_region_prices")!({
      amount: "$4,99",
      currency_code: "USD",
    });
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain("Invalid amount");
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("update_one_time_product patches the lowercase onetimeproducts path", async () => {
    mockFetch.mockResolvedValueOnce(resp({ productId: "coins" }));
    await tools.get("update_one_time_product")!({
      product_id: "coins",
      product: { listings: [{ languageCode: "en-US", title: "Coins" }] },
      update_mask: "listings",
      regions_version: "2022/02",
      allow_missing: true,
    });
    expect(calls(mockFetch)).toEqual([`PATCH ${APP}/onetimeproducts/coins`]);
    expect(query(mockFetch)).toEqual({
      updateMask: "listings",
      "regionsVersion.version": "2022/02",
      allowMissing: "true",
    });
    expect(body(mockFetch)).toEqual({
      listings: [{ languageCode: "en-US", title: "Coins" }],
      packageName: "com.acme.app",
      productId: "coins",
    });
  });

  it("set_purchase_option_state sends one batch state request and unwraps the product", async () => {
    mockFetch.mockResolvedValue(resp({ oneTimeProducts: [{ productId: "coins" }] }));
    const args = { product_id: "coins", purchase_option_id: "buy" };
    const res = await tools.get("set_purchase_option_state")!({ ...args, state: "activate" });
    await tools.get("set_purchase_option_state")!({ ...args, state: "deactivate" });
    expect(calls(mockFetch)).toEqual([
      `POST ${APP}/oneTimeProducts/coins/purchaseOptions:batchUpdateStates`,
      `POST ${APP}/oneTimeProducts/coins/purchaseOptions:batchUpdateStates`,
    ]);
    const request = { packageName: "com.acme.app", productId: "coins", purchaseOptionId: "buy" };
    expect(body(mockFetch)).toEqual({ requests: [{ activatePurchaseOptionRequest: request }] });
    expect(body(mockFetch, 1)).toEqual({
      requests: [{ deactivatePurchaseOptionRequest: request }],
    });
    expect(JSON.parse(res.content[0].text!)).toEqual({ productId: "coins" });
  });

  it("update_one_time_product_offer sends one batch update and unwraps the offer", async () => {
    mockFetch.mockResolvedValueOnce(resp({ oneTimeProductOffers: [{ offerId: "sale" }] }));
    const res = await tools.get("update_one_time_product_offer")!({
      product_id: "coins",
      purchase_option_id: "buy",
      offer_id: "sale",
      offer: { discountedOffer: { redemptionLimit: "1" } },
      update_mask: "discountedOffer",
      regions_version: "2022/02",
      allow_missing: true,
    });
    expect(calls(mockFetch)).toEqual([
      `POST ${APP}/oneTimeProducts/coins/purchaseOptions/buy/offers:batchUpdate`,
    ]);
    expect(body(mockFetch)).toEqual({
      requests: [
        {
          oneTimeProductOffer: {
            discountedOffer: { redemptionLimit: "1" },
            packageName: "com.acme.app",
            productId: "coins",
            purchaseOptionId: "buy",
            offerId: "sale",
          },
          updateMask: "discountedOffer",
          regionsVersion: { version: "2022/02" },
          allowMissing: true,
        },
      ],
    });
    expect(JSON.parse(res.content[0].text!)).toEqual({ offerId: "sale" });
  });

  it("set_one_time_product_offer_state posts to the state verb", async () => {
    mockFetch.mockResolvedValueOnce(resp({ offerId: "sale" }));
    await tools.get("set_one_time_product_offer_state")!({
      product_id: "coins",
      purchase_option_id: "buy",
      offer_id: "sale",
      state: "cancel",
    });
    expect(calls(mockFetch)).toEqual([
      `POST ${APP}/oneTimeProducts/coins/purchaseOptions/buy/offers/sale:cancel`,
    ]);
    expect(body(mockFetch)).toEqual({
      packageName: "com.acme.app",
      productId: "coins",
      purchaseOptionId: "buy",
      offerId: "sale",
    });
  });

  it("delete_one_time_product sends DELETE", async () => {
    mockFetch.mockResolvedValueOnce(resp(""));
    const res = await tools.get("delete_one_time_product")!({ product_id: "coins" });
    expect(calls(mockFetch)).toEqual([`DELETE ${APP}/oneTimeProducts/coins`]);
    expect(JSON.parse(res.content[0].text!).deletedProduct).toBe("coins");
  });

  it("delete_purchase_option sends one batch delete with force", async () => {
    mockFetch.mockResolvedValueOnce(resp(""));
    await tools.get("delete_purchase_option")!({
      product_id: "coins",
      purchase_option_id: "buy",
      force: true,
    });
    expect(calls(mockFetch)).toEqual([
      `POST ${APP}/oneTimeProducts/coins/purchaseOptions:batchDelete`,
    ]);
    expect(body(mockFetch)).toEqual({
      requests: [
        { packageName: "com.acme.app", productId: "coins", purchaseOptionId: "buy", force: true },
      ],
    });
  });

  it("delete_one_time_product_offer sends one batch delete", async () => {
    mockFetch.mockResolvedValueOnce(resp(""));
    await tools.get("delete_one_time_product_offer")!({
      product_id: "coins",
      purchase_option_id: "buy",
      offer_id: "sale",
    });
    expect(calls(mockFetch)).toEqual([
      `POST ${APP}/oneTimeProducts/coins/purchaseOptions/buy/offers:batchDelete`,
    ]);
    expect(body(mockFetch)).toEqual({
      requests: [
        {
          packageName: "com.acme.app",
          productId: "coins",
          purchaseOptionId: "buy",
          offerId: "sale",
        },
      ],
    });
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
    const res = await collect().get("list_one_time_products")!({});
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain("No package name given");
  });
});
