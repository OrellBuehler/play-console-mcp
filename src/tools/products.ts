import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { GooglePlayClient } from "../play/client.js";
import { ok, err, resolvePackage } from "../play/format.js";
import {
  packageArg,
  pageShape,
  regionsVersionArg,
  updateMaskArg,
  resourceArg,
  readOnly,
  destructive,
} from "./shared.js";

const productIdArg = z
  .string()
  .describe("One-time product ID, e.g. 'coins_100'. Get IDs from list_one_time_products.");
const purchaseOptionIdArg = z
  .string()
  .describe(
    "Purchase option ID within the product, e.g. 'buy'. Get IDs from get_one_time_product.",
  );
const offerIdArg = z
  .string()
  .describe("Offer ID within the purchase option. Get IDs from list_one_time_product_offers.");

function productsBase(pkg: string): string {
  return `/applications/${encodeURIComponent(pkg)}/oneTimeProducts`;
}

function offersBase(pkg: string, productId: string, purchaseOptionId: string): string {
  return `${productsBase(pkg)}/${encodeURIComponent(productId)}/purchaseOptions/${encodeURIComponent(purchaseOptionId)}/offers`;
}

function toMoney(amount: string, currencyCode: string) {
  const match = /^(\d+)(?:\.(\d{1,9}))?$/.exec(amount.trim());
  if (!match) {
    throw new Error(`Invalid amount '${amount}'. Use a plain decimal such as '4.99'.`);
  }
  return {
    currencyCode: currencyCode.toUpperCase(),
    units: match[1],
    nanos: Number((match[2] ?? "").padEnd(9, "0")),
  };
}

export function registerProductTools(
  server: McpServer,
  client: GooglePlayClient,
  defaultPackageName?: string,
  allowWrites = false,
  allowDestructive = false,
) {
  server.tool(
    "list_one_time_products",
    "List the one-time products (in-app purchases bought once, as opposed to subscriptions) of an app. Each has productId, listings (localized title and description), taxAndComplianceSettings, offerTags and purchaseOptions — each purchase option with purchaseOptionId, state (DRAFT, ACTIVE, INACTIVE, INACTIVE_PUBLISHED), buyOption or rentOption, and regionalPricingAndAvailabilityConfigs with the price per region. Products created as legacy 'managed products' appear here too. Returns nextPageToken when there are more. For subscriptions use list_subscriptions.",
    {
      ...pageShape,
      package_name: packageArg,
    },
    readOnly,
    async ({ page_size, page_token, package_name }) => {
      try {
        const pkg = resolvePackage(package_name, defaultPackageName);
        const res = await client.get(productsBase(pkg), {
          pageSize: page_size,
          pageToken: page_token,
        });
        return ok(res);
      } catch (e) {
        return err(e);
      }
    },
  );

  server.tool(
    "get_one_time_product",
    "Get one one-time product by its productId, with listings, taxAndComplianceSettings, offerTags, regionsVersion and every purchase option (purchaseOptionId, state, buyOption or rentOption, regional prices, newRegionsConfig). Read this before update_one_time_product: the update overwrites whole top-level fields, so start from the current value.",
    {
      product_id: productIdArg,
      package_name: packageArg,
    },
    readOnly,
    async ({ product_id, package_name }) => {
      try {
        const pkg = resolvePackage(package_name, defaultPackageName);
        const res = await client.get(`${productsBase(pkg)}/${encodeURIComponent(product_id)}`);
        return ok(res);
      } catch (e) {
        return err(e);
      }
    },
  );

  server.tool(
    "list_one_time_product_offers",
    "List the offers on one-time products: discounted offers, pre-orders and game rewards. Each has offerId, purchaseOptionId, productId, state (DRAFT, ACTIVE, INACTIVE, CANCELLED), its type (discountedOffer, preOrderOffer or gameRewardOffer), regionalPricingAndAvailabilityConfigs and offerTags. Omit product_id to list the offers of every product in the app, or omit only purchase_option_id for every purchase option of one product. Returns nextPageToken when there are more.",
    {
      product_id: productIdArg.optional(),
      purchase_option_id: purchaseOptionIdArg.optional(),
      ...pageShape,
      package_name: packageArg,
    },
    readOnly,
    async ({ product_id, purchase_option_id, page_size, page_token, package_name }) => {
      try {
        const pkg = resolvePackage(package_name, defaultPackageName);
        if (product_id === undefined && purchase_option_id !== undefined) {
          throw new Error("purchase_option_id needs product_id to be set.");
        }
        const res = await client.get(
          offersBase(pkg, product_id ?? "-", purchase_option_id ?? "-"),
          {
            pageSize: page_size,
            pageToken: page_token,
          },
        );
        return ok(res);
      } catch (e) {
        return err(e);
      }
    },
  );

  server.tool(
    "convert_region_prices",
    "Convert one tax-exclusive price into local prices for every region Google Play sells in, using today's exchange rates and each country's pricing patterns (e.g. .99 endings). Calculates only, nothing is saved. Returns convertedRegionPrices (a map of region code to {price, taxAmount}), convertedOtherRegionsPrice (USD and EUR prices for regions without local currency support) and regionVersion.version, which is the regions_version that create_subscription, update_subscription, update_one_time_product and the offer tools require. Use the prices as the regional configs of those tools.",
    {
      amount: z
        .string()
        .describe("Price before tax as a plain decimal, e.g. '4.99' (up to 9 decimal places)"),
      currency_code: z.string().length(3).describe("ISO 4217 currency of amount, e.g. 'USD'"),
      product_tax_category_code: z
        .string()
        .optional()
        .describe(
          "Product tax category code, when the product has one, so the right tax rates go into the calculation",
        ),
      package_name: packageArg,
    },
    readOnly,
    async ({ amount, currency_code, product_tax_category_code, package_name }) => {
      try {
        const pkg = resolvePackage(package_name, defaultPackageName);
        const res = await client.post(
          `/applications/${encodeURIComponent(pkg)}/pricing:convertRegionPrices`,
          {
            price: toMoney(amount, currency_code),
            ...(product_tax_category_code === undefined
              ? {}
              : { productTaxCategoryCode: product_tax_category_code }),
          },
        );
        return ok(res);
      } catch (e) {
        return err(e);
      }
    },
  );

  if (!allowWrites) return;

  server.tool(
    "update_one_time_product",
    "Create or update a one-time product: its listings, tax settings, tags or purchase options (including regional prices). Only the top-level fields named in update_mask are changed, and each named field is replaced as a whole — to change a price, read the product with get_one_time_product, edit purchaseOptions and send the full purchaseOptions list back. Pass allow_missing to create a new product; its purchase options start in DRAFT and are not purchasable until set_purchase_option_state activates them. Price changes on an active purchase option reach buyers right away: catalog changes skip the edits workflow, so there is no validate_only dry run. Returns the saved product.",
    {
      product_id: z
        .string()
        .describe(
          "One-time product ID, e.g. 'coins_100'. For a new product: lowercase letters, digits, underscores and dots, starting with a letter or digit. Get existing IDs from list_one_time_products.",
        ),
      product: resourceArg(
        "The OneTimeProduct fields to write, in the format get_one_time_product returns them. A new product needs listings: [{languageCode:'en-US',title:'100 coins',description:'...'}] and purchaseOptions: [{purchaseOptionId:'buy',buyOption:{legacyCompatible:true},regionalPricingAndAvailabilityConfigs:[{regionCode:'US',availability:'AVAILABLE',price:{currencyCode:'USD',units:'0',nanos:990000000}}],newRegionsConfig}]. Get regional prices from convert_region_prices. packageName and productId are filled in for you.",
      ),
      update_mask: updateMaskArg,
      regions_version: regionsVersionArg,
      allow_missing: z
        .boolean()
        .optional()
        .describe("Create the product if no product with this ID exists yet"),
      package_name: packageArg,
    },
    destructive,
    async ({ product_id, product, update_mask, regions_version, allow_missing, package_name }) => {
      try {
        const pkg = resolvePackage(package_name, defaultPackageName);
        const res = await client.patch(
          `/applications/${encodeURIComponent(pkg)}/onetimeproducts/${encodeURIComponent(product_id)}`,
          { ...product, packageName: pkg, productId: product_id },
          {
            updateMask: update_mask,
            "regionsVersion.version": regions_version,
            allowMissing: allow_missing,
          },
        );
        return ok(res);
      } catch (e) {
        return err(e);
      }
    },
  );

  server.tool(
    "set_purchase_option_state",
    "Activate or deactivate a purchase option of a one-time product. Activating makes the product purchasable in the app right away at the prices set on the purchase option — check them with get_one_time_product first. Deactivating takes it off sale; users keep what they already bought. Returns the updated product.",
    {
      product_id: productIdArg,
      purchase_option_id: purchaseOptionIdArg,
      state: z
        .enum(["activate", "deactivate"])
        .describe("'activate' puts the purchase option on sale, 'deactivate' takes it off sale"),
      package_name: packageArg,
    },
    destructive,
    async ({ product_id, purchase_option_id, state, package_name }) => {
      try {
        const pkg = resolvePackage(package_name, defaultPackageName);
        const request = {
          packageName: pkg,
          productId: product_id,
          purchaseOptionId: purchase_option_id,
        };
        const res = await client.post<{ oneTimeProducts?: unknown[] }>(
          `${productsBase(pkg)}/${encodeURIComponent(product_id)}/purchaseOptions:batchUpdateStates`,
          {
            requests: [
              state === "activate"
                ? { activatePurchaseOptionRequest: request }
                : { deactivatePurchaseOptionRequest: request },
            ],
          },
        );
        return ok(res.oneTimeProducts?.[0] ?? res);
      } catch (e) {
        return err(e);
      }
    },
  );

  server.tool(
    "update_one_time_product_offer",
    "Create or update an offer on a purchase option of a one-time product: a discounted offer, a pre-order or a game reward. Only the top-level fields named in update_mask are changed, each replaced as a whole. Pass allow_missing to create a new offer; it starts in DRAFT until set_one_time_product_offer_state activates it. Takes effect immediately, there is no validate_only dry run. Returns the saved offer.",
    {
      product_id: productIdArg,
      purchase_option_id: purchaseOptionIdArg,
      offer_id: z
        .string()
        .describe(
          "Offer ID, unique within the purchase option. For a new offer: lowercase letters, digits and hyphens, starting with a letter or digit. Get existing IDs from list_one_time_product_offers.",
        ),
      offer: resourceArg(
        "The OneTimeProductOffer fields to write, in the format list_one_time_product_offers returns them. Exactly one offer type: discountedOffer:{startTime,endTime,redemptionLimit}, preOrderOffer or gameRewardOffer. regionalPricingAndAvailabilityConfigs has one entry per region: {regionCode:'US',availability:'AVAILABLE'} plus relativeDiscount (0.2 = 20% off), absoluteDiscount:{currencyCode,units,nanos} or noOverride:{}. The IDs and packageName are filled in for you.",
      ),
      update_mask: updateMaskArg,
      regions_version: regionsVersionArg,
      allow_missing: z
        .boolean()
        .optional()
        .describe("Create the offer if no offer with this ID exists yet"),
      package_name: packageArg,
    },
    destructive,
    async ({
      product_id,
      purchase_option_id,
      offer_id,
      offer,
      update_mask,
      regions_version,
      allow_missing,
      package_name,
    }) => {
      try {
        const pkg = resolvePackage(package_name, defaultPackageName);
        const res = await client.post<{ oneTimeProductOffers?: unknown[] }>(
          `${offersBase(pkg, product_id, purchase_option_id)}:batchUpdate`,
          {
            requests: [
              {
                oneTimeProductOffer: {
                  ...offer,
                  packageName: pkg,
                  productId: product_id,
                  purchaseOptionId: purchase_option_id,
                  offerId: offer_id,
                },
                updateMask: update_mask,
                regionsVersion: { version: regions_version },
                ...(allow_missing === undefined ? {} : { allowMissing: allow_missing }),
              },
            ],
          },
        );
        return ok(res.oneTimeProductOffers?.[0] ?? res);
      } catch (e) {
        return err(e);
      }
    },
  );

  server.tool(
    "set_one_time_product_offer_state",
    "Activate, deactivate or cancel an offer on a one-time product. 'activate' makes it available to eligible users. 'deactivate' ends a discounted or game reward offer. 'cancel' ends a pre-order offer and cancels every pending pre-order placed through it, which cannot be undone. Returns the updated offer.",
    {
      product_id: productIdArg,
      purchase_option_id: purchaseOptionIdArg,
      offer_id: offerIdArg,
      state: z
        .enum(["activate", "deactivate", "cancel"])
        .describe(
          "'activate', 'deactivate' (discounted and game reward offers) or 'cancel' (pre-order offers, also cancels pending orders)",
        ),
      package_name: packageArg,
    },
    destructive,
    async ({ product_id, purchase_option_id, offer_id, state, package_name }) => {
      try {
        const pkg = resolvePackage(package_name, defaultPackageName);
        const res = await client.post(
          `${offersBase(pkg, product_id, purchase_option_id)}/${encodeURIComponent(offer_id)}:${state}`,
          {
            packageName: pkg,
            productId: product_id,
            purchaseOptionId: purchase_option_id,
            offerId: offer_id,
          },
        );
        return ok(res);
      } catch (e) {
        return err(e);
      }
    },
  );

  if (!allowDestructive) return;

  server.tool(
    "delete_one_time_product",
    "Delete a one-time product with all its purchase options and offers. It can no longer be bought, and the app must stop offering it. Irreversible — prefer set_purchase_option_state to take a product off sale.",
    {
      product_id: productIdArg,
      package_name: packageArg,
    },
    destructive,
    async ({ product_id, package_name }) => {
      try {
        const pkg = resolvePackage(package_name, defaultPackageName);
        await client.del(`${productsBase(pkg)}/${encodeURIComponent(product_id)}`);
        return ok({ packageName: pkg, deletedProduct: product_id });
      } catch (e) {
        return err(e);
      }
    },
  );

  server.tool(
    "delete_purchase_option",
    "Delete a purchase option from a one-time product. Fails when the purchase option still has offers unless force is set, which deletes those offers too. Irreversible.",
    {
      product_id: productIdArg,
      purchase_option_id: purchaseOptionIdArg,
      force: z
        .boolean()
        .optional()
        .describe("Also delete every offer under the purchase option instead of failing"),
      package_name: packageArg,
    },
    destructive,
    async ({ product_id, purchase_option_id, force, package_name }) => {
      try {
        const pkg = resolvePackage(package_name, defaultPackageName);
        await client.post(
          `${productsBase(pkg)}/${encodeURIComponent(product_id)}/purchaseOptions:batchDelete`,
          {
            requests: [
              {
                packageName: pkg,
                productId: product_id,
                purchaseOptionId: purchase_option_id,
                ...(force === undefined ? {} : { force }),
              },
            ],
          },
        );
        return ok({
          packageName: pkg,
          productId: product_id,
          deletedPurchaseOption: purchase_option_id,
        });
      } catch (e) {
        return err(e);
      }
    },
  );

  server.tool(
    "delete_one_time_product_offer",
    "Delete an offer from a purchase option of a one-time product. Irreversible — use set_one_time_product_offer_state to end an offer while keeping its record.",
    {
      product_id: productIdArg,
      purchase_option_id: purchaseOptionIdArg,
      offer_id: offerIdArg,
      package_name: packageArg,
    },
    destructive,
    async ({ product_id, purchase_option_id, offer_id, package_name }) => {
      try {
        const pkg = resolvePackage(package_name, defaultPackageName);
        await client.post(`${offersBase(pkg, product_id, purchase_option_id)}:batchDelete`, {
          requests: [
            {
              packageName: pkg,
              productId: product_id,
              purchaseOptionId: purchase_option_id,
              offerId: offer_id,
            },
          ],
        });
        return ok({
          packageName: pkg,
          productId: product_id,
          purchaseOptionId: purchase_option_id,
          deletedOffer: offer_id,
        });
      } catch (e) {
        return err(e);
      }
    },
  );
}
