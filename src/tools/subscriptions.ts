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
  additive,
  destructive,
} from "./shared.js";

const productIdArg = z
  .string()
  .describe("Subscription product ID, e.g. 'premium'. Get IDs from list_subscriptions.");
const basePlanIdArg = z
  .string()
  .describe("Base plan ID within the subscription, e.g. 'monthly'. Get IDs from get_subscription.");
const offerIdArg = z
  .string()
  .describe("Offer ID within the base plan. Get IDs from list_subscription_offers.");
const stateArg = (what: string) =>
  z
    .enum(["activate", "deactivate"])
    .describe(
      `'activate' makes the ${what} available to new subscribers, 'deactivate' hides it from new subscribers while existing subscribers keep their subscription`,
    );

function subscriptionsBase(pkg: string): string {
  return `/applications/${encodeURIComponent(pkg)}/subscriptions`;
}

function basePlanPath(pkg: string, productId: string, basePlanId: string): string {
  return `${subscriptionsBase(pkg)}/${encodeURIComponent(productId)}/basePlans/${encodeURIComponent(basePlanId)}`;
}

function offerPath(pkg: string, productId: string, basePlanId: string, offerId: string): string {
  return `${basePlanPath(pkg, productId, basePlanId)}/offers/${encodeURIComponent(offerId)}`;
}

export function registerSubscriptionTools(
  server: McpServer,
  client: GooglePlayClient,
  defaultPackageName?: string,
  allowWrites = false,
  allowDestructive = false,
) {
  server.tool(
    "list_subscriptions",
    "List the subscription products of an app. Each has productId, listings (localized title, description, benefits), taxAndComplianceSettings and basePlans — each base plan with basePlanId, state (DRAFT, ACTIVE, INACTIVE), its billing period (autoRenewingBasePlanType, prepaidBasePlanType or installmentsBasePlanType) and regionalConfigs with the price per region. Returns nextPageToken when there are more. Offers (free trials, intro prices) are separate: use list_subscription_offers. For one-time purchases use list_one_time_products.",
    {
      ...pageShape,
      package_name: packageArg,
    },
    readOnly,
    async ({ page_size, page_token, package_name }) => {
      try {
        const pkg = resolvePackage(package_name, defaultPackageName);
        const res = await client.get(subscriptionsBase(pkg), {
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
    "get_subscription",
    "Get one subscription product by its productId, with listings, taxAndComplianceSettings and every base plan (basePlanId, state, billing period, regionalConfigs with prices, otherRegionsConfig, offerTags). Read this before update_subscription: the update overwrites whole top-level fields, so start from the current value.",
    {
      product_id: productIdArg,
      package_name: packageArg,
    },
    readOnly,
    async ({ product_id, package_name }) => {
      try {
        const pkg = resolvePackage(package_name, defaultPackageName);
        const res = await client.get(`${subscriptionsBase(pkg)}/${encodeURIComponent(product_id)}`);
        return ok(res);
      } catch (e) {
        return err(e);
      }
    },
  );

  server.tool(
    "list_subscription_offers",
    "List subscription offers (free trials, introductory prices, upgrade and win-back offers). Each has offerId, basePlanId, productId, state (DRAFT, ACTIVE, INACTIVE), phases (duration, recurrenceCount and regional prices per phase), targeting, regionalConfigs and offerTags. Omit product_id to list the offers of every subscription in the app, or omit only base_plan_id for every base plan of one subscription. Returns nextPageToken when there are more.",
    {
      product_id: productIdArg.optional(),
      base_plan_id: basePlanIdArg.optional(),
      ...pageShape,
      package_name: packageArg,
    },
    readOnly,
    async ({ product_id, base_plan_id, page_size, page_token, package_name }) => {
      try {
        const pkg = resolvePackage(package_name, defaultPackageName);
        if (product_id === undefined && base_plan_id !== undefined) {
          throw new Error("base_plan_id needs product_id to be set.");
        }
        const res = await client.get(
          `${basePlanPath(pkg, product_id ?? "-", base_plan_id ?? "-")}/offers`,
          { pageSize: page_size, pageToken: page_token },
        );
        return ok(res);
      } catch (e) {
        return err(e);
      }
    },
  );

  server.tool(
    "get_subscription_offer",
    "Get one subscription offer with its phases, targeting, regionalConfigs, offerTags and state. Read this before update_subscription_offer. Get the IDs from list_subscription_offers.",
    {
      product_id: productIdArg,
      base_plan_id: basePlanIdArg,
      offer_id: offerIdArg,
      package_name: packageArg,
    },
    readOnly,
    async ({ product_id, base_plan_id, offer_id, package_name }) => {
      try {
        const pkg = resolvePackage(package_name, defaultPackageName);
        const res = await client.get(offerPath(pkg, product_id, base_plan_id, offer_id));
        return ok(res);
      } catch (e) {
        return err(e);
      }
    },
  );

  if (!allowWrites) return;

  server.tool(
    "create_subscription",
    "Create a new subscription product. Its base plans start in DRAFT and are not purchasable until set_base_plan_state activates them. The product ID is permanent: a subscription that ever had an active base plan cannot be deleted and its ID cannot be reused. Catalog changes take effect immediately, without the edits workflow, so there is no validate_only dry run. Returns the created subscription.",
    {
      product_id: z
        .string()
        .describe(
          "ID for the new subscription: lowercase letters, digits, underscores and dots, starting with a letter or digit, e.g. 'premium'",
        ),
      subscription: resourceArg(
        "The Subscription resource in Google's format. listings is required and needs an entry for the app's default language: [{languageCode:'en-US',title:'Premium',benefits:['No ads'],description:'...'}]. basePlans is a list of {basePlanId, autoRenewingBasePlanType:{billingPeriodDuration:'P1M'} (or prepaidBasePlanType / installmentsBasePlanType), regionalConfigs:[{regionCode:'US',newSubscriberAvailability:true,price:{currencyCode:'USD',units:'4',nanos:990000000}}], otherRegionsConfig}. Get regional prices from convert_region_prices. packageName and productId are filled in for you.",
      ),
      regions_version: regionsVersionArg,
      package_name: packageArg,
    },
    additive,
    async ({ product_id, subscription, regions_version, package_name }) => {
      try {
        const pkg = resolvePackage(package_name, defaultPackageName);
        const res = await client.post(
          subscriptionsBase(pkg),
          { ...subscription, packageName: pkg, productId: product_id },
          { productId: product_id, "regionsVersion.version": regions_version },
        );
        return ok(res);
      } catch (e) {
        return err(e);
      }
    },
  );

  server.tool(
    "update_subscription",
    "Update a subscription product: its listings, tax settings or base plans (including regional prices and adding a new base plan). Only the top-level fields named in update_mask are changed, and each named field is replaced as a whole — to change one base plan's price, read the subscription with get_subscription, edit basePlans and send the full basePlans list back. Changing a base plan's price applies to new subscribers; existing subscribers stay on their old price until migrate_base_plan_prices moves them. Takes effect immediately, there is no validate_only dry run. Returns the updated subscription.",
    {
      product_id: productIdArg,
      subscription: resourceArg(
        "The Subscription fields to write, in the same format get_subscription returns them, e.g. {listings:[...]} or {basePlans:[...]}. packageName and productId are filled in for you.",
      ),
      update_mask: updateMaskArg,
      regions_version: regionsVersionArg,
      allow_missing: z
        .boolean()
        .optional()
        .describe("Create the subscription if no product with this ID exists yet"),
      package_name: packageArg,
    },
    destructive,
    async ({
      product_id,
      subscription,
      update_mask,
      regions_version,
      allow_missing,
      package_name,
    }) => {
      try {
        const pkg = resolvePackage(package_name, defaultPackageName);
        const res = await client.patch(
          `${subscriptionsBase(pkg)}/${encodeURIComponent(product_id)}`,
          { ...subscription, packageName: pkg, productId: product_id },
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
    "set_base_plan_state",
    "Activate or deactivate a base plan of a subscription. Activating makes it purchasable in the app right away; a base plan that was ever active can no longer be deleted, only deactivated. Check the prices with get_subscription before activating. Returns the updated subscription.",
    {
      product_id: productIdArg,
      base_plan_id: basePlanIdArg,
      state: stateArg("base plan"),
      package_name: packageArg,
    },
    destructive,
    async ({ product_id, base_plan_id, state, package_name }) => {
      try {
        const pkg = resolvePackage(package_name, defaultPackageName);
        const res = await client.post(`${basePlanPath(pkg, product_id, base_plan_id)}:${state}`, {
          packageName: pkg,
          productId: product_id,
          basePlanId: base_plan_id,
        });
        return ok(res);
      } catch (e) {
        return err(e);
      }
    },
  );

  server.tool(
    "create_subscription_offer",
    "Create an offer on an auto-renewing base plan: a free trial, an introductory price or an upgrade / win-back offer. The offer starts in DRAFT and is not shown to users until set_subscription_offer_state activates it. Takes effect immediately, there is no validate_only dry run. Returns the created offer.",
    {
      product_id: productIdArg,
      base_plan_id: basePlanIdArg,
      offer_id: z
        .string()
        .describe(
          "ID for the new offer, unique within the base plan: lowercase letters, digits and hyphens, e.g. 'free-trial-7d'",
        ),
      offer: resourceArg(
        "The SubscriptionOffer resource in Google's format. phases is required, one or two entries in order: [{duration:'P7D',recurrenceCount:1,regionalConfigs:[{regionCode:'US',free:{}}]}] for a free trial, or price:{currencyCode,units,nanos} / relativeDiscount / absoluteDiscount instead of free for an intro price. regionalConfigs is required: [{regionCode:'US',newSubscriberAvailability:true}]. targeting sets eligibility, e.g. {acquisitionRule:{scope:{anySubscriptionInApp:{}}}}. Each phase needs one regionalConfigs entry per region the offer is available in. The IDs and packageName are filled in for you.",
      ),
      regions_version: regionsVersionArg,
      package_name: packageArg,
    },
    additive,
    async ({ product_id, base_plan_id, offer_id, offer, regions_version, package_name }) => {
      try {
        const pkg = resolvePackage(package_name, defaultPackageName);
        const res = await client.post(
          `${basePlanPath(pkg, product_id, base_plan_id)}/offers`,
          {
            ...offer,
            packageName: pkg,
            productId: product_id,
            basePlanId: base_plan_id,
            offerId: offer_id,
          },
          { offerId: offer_id, "regionsVersion.version": regions_version },
        );
        return ok(res);
      } catch (e) {
        return err(e);
      }
    },
  );

  server.tool(
    "update_subscription_offer",
    "Update a subscription offer's phases, targeting, regional availability or tags. Only the top-level fields named in update_mask are changed, and each is replaced as a whole — read the offer with get_subscription_offer first and send the full edited field back. Changes apply to new subscribers; users already in the offer keep its old terms. Takes effect immediately, there is no validate_only dry run. Returns the updated offer.",
    {
      product_id: productIdArg,
      base_plan_id: basePlanIdArg,
      offer_id: offerIdArg,
      offer: resourceArg(
        "The SubscriptionOffer fields to write, in the same format get_subscription_offer returns them, e.g. {phases:[...]}. The IDs and packageName are filled in for you.",
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
      base_plan_id,
      offer_id,
      offer,
      update_mask,
      regions_version,
      allow_missing,
      package_name,
    }) => {
      try {
        const pkg = resolvePackage(package_name, defaultPackageName);
        const res = await client.patch(
          offerPath(pkg, product_id, base_plan_id, offer_id),
          {
            ...offer,
            packageName: pkg,
            productId: product_id,
            basePlanId: base_plan_id,
            offerId: offer_id,
          },
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
    "set_subscription_offer_state",
    "Activate or deactivate a subscription offer. An active offer is only shown while its base plan is active too. An offer that was ever active can no longer be deleted, only deactivated. Returns the updated offer.",
    {
      product_id: productIdArg,
      base_plan_id: basePlanIdArg,
      offer_id: offerIdArg,
      state: stateArg("offer"),
      package_name: packageArg,
    },
    destructive,
    async ({ product_id, base_plan_id, offer_id, state, package_name }) => {
      try {
        const pkg = resolvePackage(package_name, defaultPackageName);
        const res = await client.post(
          `${offerPath(pkg, product_id, base_plan_id, offer_id)}:${state}`,
          {
            packageName: pkg,
            productId: product_id,
            basePlanId: base_plan_id,
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
    "migrate_base_plan_prices",
    "Move existing subscribers of a base plan from their old (legacy) price to the base plan's current price, per region. Google Play emails every affected subscriber and, for an opt-in increase, cancels those who do not accept — this cannot be undone. Set the new price with update_subscription first; only subscribers who joined before oldestAllowedPriceVersionTime are moved. Returns an empty object on success.",
    {
      product_id: productIdArg,
      base_plan_id: basePlanIdArg,
      regional_price_migrations: z
        .array(
          z.object({
            regionCode: z.string().describe("ISO 3166-1 alpha-2 region code, e.g. 'US'"),
            oldestAllowedPriceVersionTime: z
              .string()
              .describe(
                "RFC 3339 timestamp, e.g. '2026-01-01T00:00:00Z'. Subscribers on price cohorts older than this are migrated to the current price; newer cohorts are left alone.",
              ),
            priceIncreaseType: z
              .enum(["PRICE_INCREASE_TYPE_OPT_IN", "PRICE_INCREASE_TYPE_OPT_OUT"])
              .optional()
              .describe(
                "For a price increase: OPT_IN (default) cancels subscribers who do not accept, OPT_OUT applies it unless they cancel (only allowed in some regions and within Google's limits)",
              ),
          }),
        )
        .min(1)
        .describe("One entry per region whose legacy subscribers should be migrated"),
      regions_version: regionsVersionArg,
      package_name: packageArg,
    },
    destructive,
    async ({
      product_id,
      base_plan_id,
      regional_price_migrations,
      regions_version,
      package_name,
    }) => {
      try {
        const pkg = resolvePackage(package_name, defaultPackageName);
        const res = await client.post(
          `${basePlanPath(pkg, product_id, base_plan_id)}:migratePrices`,
          {
            packageName: pkg,
            productId: product_id,
            basePlanId: base_plan_id,
            regionalPriceMigrations: regional_price_migrations,
            regionsVersion: { version: regions_version },
          },
        );
        return ok(res);
      } catch (e) {
        return err(e);
      }
    },
  );

  server.tool(
    "delete_subscription",
    "Delete a subscription product. Google only allows this while the subscription has never had an active base plan; after that it can only be taken off sale with set_base_plan_state. Irreversible.",
    {
      product_id: productIdArg,
      package_name: packageArg,
    },
    destructive,
    async ({ product_id, package_name }) => {
      try {
        const pkg = resolvePackage(package_name, defaultPackageName);
        await client.del(`${subscriptionsBase(pkg)}/${encodeURIComponent(product_id)}`);
        return ok({ packageName: pkg, deletedSubscription: product_id });
      } catch (e) {
        return err(e);
      }
    },
  );

  server.tool(
    "delete_base_plan",
    "Delete a base plan from a subscription. Only DRAFT base plans can be deleted; one that was ever active can only be deactivated with set_base_plan_state. Irreversible.",
    {
      product_id: productIdArg,
      base_plan_id: basePlanIdArg,
      package_name: packageArg,
    },
    destructive,
    async ({ product_id, base_plan_id, package_name }) => {
      try {
        const pkg = resolvePackage(package_name, defaultPackageName);
        await client.del(basePlanPath(pkg, product_id, base_plan_id));
        return ok({ packageName: pkg, productId: product_id, deletedBasePlan: base_plan_id });
      } catch (e) {
        return err(e);
      }
    },
  );

  server.tool(
    "delete_subscription_offer",
    "Delete a subscription offer. Only DRAFT offers can be deleted; one that was ever active can only be deactivated with set_subscription_offer_state. Irreversible.",
    {
      product_id: productIdArg,
      base_plan_id: basePlanIdArg,
      offer_id: offerIdArg,
      package_name: packageArg,
    },
    destructive,
    async ({ product_id, base_plan_id, offer_id, package_name }) => {
      try {
        const pkg = resolvePackage(package_name, defaultPackageName);
        await client.del(offerPath(pkg, product_id, base_plan_id, offer_id));
        return ok({
          packageName: pkg,
          productId: product_id,
          basePlanId: base_plan_id,
          deletedOffer: offer_id,
        });
      } catch (e) {
        return err(e);
      }
    },
  );
}
