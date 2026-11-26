import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { GooglePlayClient } from "../play/client.js";
import { ok, err, resolvePackage } from "../play/format.js";
import { packageArg, readOnly, destructive, UNTRUSTED_NOTE } from "./shared.js";

const tokenArg = z
  .string()
  .describe(
    "Purchase token of the purchase, as issued to the user's device by Google Play Billing. Also returned as purchaseToken by get_orders and list_voided_purchases.",
  );

function purchasesBase(pkg: string): string {
  return `/applications/${encodeURIComponent(pkg)}/purchases`;
}

function subscriptionV2Path(pkg: string, token: string): string {
  return `${purchasesBase(pkg)}/subscriptionsv2/tokens/${encodeURIComponent(token)}`;
}

export function registerPurchaseTools(
  server: McpServer,
  client: GooglePlayClient,
  defaultPackageName?: string,
  allowWrites = false,
  allowDestructive = false,
) {
  server.tool(
    "get_orders",
    "Look up one or more orders by order ID (the 'GPA.1234-5678-9012-34567' number on the buyer's receipt and in Play Console > Order management). Each order has orderId, state (PENDING, PROCESSED, CANCELED, PENDING_REFUND, PARTIALLY_REFUNDED, REFUNDED), purchaseToken, lineItems (productId, productTitle, listingPrice, total, tax and subscription or one-time purchase details), total, tax, developerRevenueInBuyerCurrency, buyerAddress (country), createTime, lastEventTime and orderHistory with refund and cancellation events. The API cannot list or search orders: you need the IDs, e.g. from a customer's receipt or list_voided_purchases. Orders that are not found are left out of the result.",
    {
      order_ids: z
        .array(z.string())
        .min(1)
        .max(1000)
        .describe("Order IDs to look up, e.g. ['GPA.3345-1234-5678-90123'] (1 to 1000)"),
      package_name: packageArg,
    },
    readOnly,
    async ({ order_ids, package_name }) => {
      try {
        const pkg = resolvePackage(package_name, defaultPackageName);
        const query = new URLSearchParams(order_ids.map((id) => ["orderIds", id]));
        const res = await client.get(
          `/applications/${encodeURIComponent(pkg)}/orders:batchGet?${query.toString()}`,
        );
        return ok(res);
      } catch (e) {
        return err(e);
      }
    },
  );

  server.tool(
    "get_product_purchase",
    "Get the status of a one-time product purchase by its purchase token: productLineItem (productId and productOfferDetails), purchaseStateContext (PURCHASED, CANCELLED or PENDING), acknowledgementState, orderId, purchaseCompletionTime, regionCode, the app's obfuscated account/profile ids and testPurchaseContext for test purchases. Use it to check whether a customer really owns an item before refund_order, acknowledge_product_purchase or consume_product_purchase.",
    {
      token: tokenArg,
      package_name: packageArg,
    },
    readOnly,
    async ({ token, package_name }) => {
      try {
        const pkg = resolvePackage(package_name, defaultPackageName);
        const res = await client.get(
          `${purchasesBase(pkg)}/productsv2/tokens/${encodeURIComponent(token)}`,
        );
        return ok(res);
      } catch (e) {
        return err(e);
      }
    },
  );

  server.tool(
    "get_subscription_purchase",
    `Get the status of a subscription purchase by its purchase token: subscriptionState (ACTIVE, CANCELED, IN_GRACE_PERIOD, ON_HOLD, PAUSED, EXPIRED, PENDING), lineItems (productId, expiryTime, autoRenewingPlan or prepaidPlan, offerDetails with basePlanId and offerId, latestSuccessfulOrderId), startTime, acknowledgementState, regionCode, linkedPurchaseToken, canceledStateContext (who cancelled and the user's cancel survey answer) and etag. The etag is required by defer_subscription_purchase. Use it before cancel_subscription_purchase or revoke_subscription_purchase to confirm what the customer has. ${UNTRUSTED_NOTE}`,
    {
      token: tokenArg,
      package_name: packageArg,
    },
    readOnly,
    async ({ token, package_name }) => {
      try {
        const pkg = resolvePackage(package_name, defaultPackageName);
        const res = await client.get(subscriptionV2Path(pkg, token));
        return ok(res);
      } catch (e) {
        return err(e);
      }
    },
  );

  server.tool(
    "list_voided_purchases",
    "List purchases that were cancelled, refunded or charged back in the last 30 days. Each has orderId, purchaseToken, purchaseTimeMillis, voidedTimeMillis, voidedSource (0 user, 1 developer, 2 Google) and voidedReason (0 other, 1 remorse, 2 not received, 3 defective, 4 accidental purchase, 5 fraud, 6 friendly fraud, 7 chargeback, 8 unacknowledged purchase). By default only one-time product purchases are returned: pass include_subscriptions for subscriptions too. Returns tokenPagination.nextPageToken when there are more; pass it as token. Feed the orderIds to get_orders for details.",
    {
      start_time: z
        .string()
        .optional()
        .describe(
          "Oldest voided time to include, in milliseconds since the Unix epoch, e.g. '1764115200000'. At most 30 days back (the default).",
        ),
      end_time: z
        .string()
        .optional()
        .describe(
          "Newest voided time to include, in milliseconds since the Unix epoch (default: now)",
        ),
      include_subscriptions: z
        .boolean()
        .optional()
        .describe("Also return voided subscription purchases, not only one-time products"),
      include_quantity_based_partial_refund: z
        .boolean()
        .optional()
        .describe(
          "Also return partial refunds of multi-quantity purchases, with their voidedQuantity",
        ),
      max_results: z.number().int().min(1).max(1000).optional().describe("Max results per page"),
      token: z
        .string()
        .optional()
        .describe("tokenPagination.nextPageToken from a previous call, to fetch the next page"),
      package_name: packageArg,
    },
    readOnly,
    async ({
      start_time,
      end_time,
      include_subscriptions,
      include_quantity_based_partial_refund,
      max_results,
      token,
      package_name,
    }) => {
      try {
        const pkg = resolvePackage(package_name, defaultPackageName);
        const res = await client.get(`${purchasesBase(pkg)}/voidedpurchases`, {
          startTime: start_time,
          endTime: end_time,
          type: include_subscriptions ? 1 : undefined,
          includeQuantityBasedPartialRefund: include_quantity_based_partial_refund,
          maxResults: max_results,
          token,
        });
        return ok(res);
      } catch (e) {
        return err(e);
      }
    },
  );

  if (!allowWrites || !allowDestructive) return;

  server.tool(
    "refund_order",
    "Refund an order to the buyer in full. Money goes back to the customer and cannot be reclaimed. Without revoke the customer keeps the item or subscription; with revoke access ends immediately and a recurring subscription stops renewing. Orders older than 3 years cannot be refunded. Look the order up with get_orders first to confirm the amount and buyer. Returns an empty object on success.",
    {
      order_id: z
        .string()
        .describe("Order ID to refund, e.g. 'GPA.3345-1234-5678-90123'. Check it with get_orders."),
      revoke: z
        .boolean()
        .optional()
        .describe(
          "Also take the purchased item or subscription away from the customer immediately (default: false, they keep it)",
        ),
      package_name: packageArg,
    },
    destructive,
    async ({ order_id, revoke, package_name }) => {
      try {
        const pkg = resolvePackage(package_name, defaultPackageName);
        await client.post(
          `/applications/${encodeURIComponent(pkg)}/orders/${encodeURIComponent(order_id)}:refund`,
          undefined,
          { revoke },
        );
        return ok({ packageName: pkg, refundedOrder: order_id, revoked: revoke ?? false });
      } catch (e) {
        return err(e);
      }
    },
  );

  server.tool(
    "acknowledge_product_purchase",
    "Acknowledge a one-time product purchase, confirming the app has granted the item. Google automatically refunds purchases left unacknowledged for 3 days, so this is normally done by the app or its backend — use it to rescue a stuck purchase. Cannot be undone. Check acknowledgementState with get_product_purchase first.",
    {
      product_id: z.string().describe("Product ID of the purchased item, e.g. 'coins_100'"),
      token: tokenArg,
      developer_payload: z
        .string()
        .optional()
        .describe("Optional payload string to attach to the purchase"),
      package_name: packageArg,
    },
    destructive,
    async ({ product_id, token, developer_payload, package_name }) => {
      try {
        const pkg = resolvePackage(package_name, defaultPackageName);
        await client.post(
          `${purchasesBase(pkg)}/products/${encodeURIComponent(product_id)}/tokens/${encodeURIComponent(token)}:acknowledge`,
          developer_payload === undefined ? {} : { developerPayload: developer_payload },
        );
        return ok({ packageName: pkg, productId: product_id, acknowledged: true });
      } catch (e) {
        return err(e);
      }
    },
  );

  server.tool(
    "consume_product_purchase",
    "Consume a one-time product purchase, so the user no longer owns the item and can buy it again. Meant for consumables (coins, credits) the app has already delivered, and for resetting a test purchase; consuming a permanent unlock takes it away from the user. Cannot be undone.",
    {
      product_id: z.string().describe("Product ID of the purchased item, e.g. 'coins_100'"),
      token: tokenArg,
      package_name: packageArg,
    },
    destructive,
    async ({ product_id, token, package_name }) => {
      try {
        const pkg = resolvePackage(package_name, defaultPackageName);
        await client.post(
          `${purchasesBase(pkg)}/products/${encodeURIComponent(product_id)}/tokens/${encodeURIComponent(token)}:consume`,
        );
        return ok({ packageName: pkg, productId: product_id, consumed: true });
      } catch (e) {
        return err(e);
      }
    },
  );

  server.tool(
    "acknowledge_subscription_purchase",
    "Acknowledge a subscription purchase, confirming the app has granted access. Google automatically refunds and revokes subscriptions left unacknowledged for 3 days, so this is normally done by the app or its backend — use it to rescue a stuck purchase. Cannot be undone. Check acknowledgementState with get_subscription_purchase first.",
    {
      subscription_id: z
        .string()
        .describe("Subscription product ID that was purchased, e.g. 'premium'"),
      token: tokenArg,
      developer_payload: z
        .string()
        .optional()
        .describe("Optional payload string to attach to the purchase"),
      package_name: packageArg,
    },
    destructive,
    async ({ subscription_id, token, developer_payload, package_name }) => {
      try {
        const pkg = resolvePackage(package_name, defaultPackageName);
        await client.post(
          `${purchasesBase(pkg)}/subscriptions/${encodeURIComponent(subscription_id)}/tokens/${encodeURIComponent(token)}:acknowledge`,
          developer_payload === undefined ? {} : { developerPayload: developer_payload },
        );
        return ok({ packageName: pkg, subscriptionId: subscription_id, acknowledged: true });
      } catch (e) {
        return err(e);
      }
    },
  );

  server.tool(
    "cancel_subscription_purchase",
    "Cancel a user's subscription so it stops renewing. The user keeps access until the end of the period already paid for and gets no refund — use revoke_subscription_purchase to end access and refund instead. Check the subscription with get_subscription_purchase first.",
    {
      token: tokenArg,
      cancellation_type: z
        .enum(["USER_REQUESTED_STOP_RENEWALS", "DEVELOPER_REQUESTED_STOP_PAYMENTS"])
        .describe(
          "'USER_REQUESTED_STOP_RENEWALS' stops the next renewal on the user's request and can be restored by the user, 'DEVELOPER_REQUESTED_STOP_PAYMENTS' stops the next payment for good and cannot be restored",
        ),
      package_name: packageArg,
    },
    destructive,
    async ({ token, cancellation_type, package_name }) => {
      try {
        const pkg = resolvePackage(package_name, defaultPackageName);
        const res = await client.post(`${subscriptionV2Path(pkg, token)}:cancel`, {
          cancellationContext: { cancellationType: cancellation_type },
        });
        return ok({ packageName: pkg, cancelled: true, response: res });
      } catch (e) {
        return err(e);
      }
    },
  );

  server.tool(
    "revoke_subscription_purchase",
    "Revoke a user's subscription: access ends immediately, renewal stops and the user is refunded. Money goes back to the customer and cannot be reclaimed. 'full' refunds the latest charge completely, 'prorated' refunds the unused remainder of the current period. Check the subscription with get_subscription_purchase first.",
    {
      token: tokenArg,
      refund: z
        .enum(["full", "prorated"])
        .describe(
          "'full' refunds the whole latest charge, 'prorated' refunds the time remaining in the current period",
        ),
      package_name: packageArg,
    },
    destructive,
    async ({ token, refund, package_name }) => {
      try {
        const pkg = resolvePackage(package_name, defaultPackageName);
        const res = await client.post(`${subscriptionV2Path(pkg, token)}:revoke`, {
          revocationContext: refund === "full" ? { fullRefund: {} } : { proratedRefund: {} },
        });
        return ok({ packageName: pkg, revoked: true, refund, response: res });
      } catch (e) {
        return err(e);
      }
    },
  );

  server.tool(
    "defer_subscription_purchase",
    "Push back a user's next subscription renewal, giving them free extra time: the user keeps access and is not charged during the deferral. Pass validate_only to preview the new expiry times without changing anything. Returns itemExpiryTimeDetails with the new expiry per subscription item.",
    {
      token: tokenArg,
      defer_duration: z
        .string()
        .describe(
          "How long to defer the renewal, as a duration in seconds with an 's' suffix, e.g. '604800s' for 7 days",
        ),
      etag: z
        .string()
        .describe(
          "etag of the subscription's current state, from get_subscription_purchase. The call fails if the subscription changed since.",
        ),
      validate_only: z
        .boolean()
        .optional()
        .describe("Dry run: return the resulting expiry times without deferring the subscription"),
      package_name: packageArg,
    },
    destructive,
    async ({ token, defer_duration, etag, validate_only, package_name }) => {
      try {
        const pkg = resolvePackage(package_name, defaultPackageName);
        const res = await client.post(`${subscriptionV2Path(pkg, token)}:defer`, {
          deferralContext: {
            deferDuration: defer_duration,
            etag,
            ...(validate_only === undefined ? {} : { validateOnly: validate_only }),
          },
        });
        return ok(res);
      } catch (e) {
        return err(e);
      }
    },
  );
}
