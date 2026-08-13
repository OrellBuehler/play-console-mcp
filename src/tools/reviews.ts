import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { GooglePlayClient } from "../play/client.js";
import { ok, err, resolvePackage } from "../play/format.js";

export interface Review {
  reviewId?: string;
  authorName?: string;
  comments?: Array<{
    userComment?: {
      text?: string;
      lastModified?: { seconds?: string; nanos?: number };
      starRating?: number;
      reviewerLanguage?: string;
      device?: string;
      androidOsVersion?: number;
      appVersionCode?: number;
      appVersionName?: string;
      thumbsUpCount?: number;
      thumbsDownCount?: number;
    };
    developerComment?: {
      text?: string;
      lastModified?: { seconds?: string; nanos?: number };
    };
  }>;
}

interface ReviewsListResponse {
  reviews?: Review[];
  tokenPagination?: { nextPageToken?: string };
}

const MAX_PAGES = 5;
const PAGE_SIZE = 100;

export function registerReviewTools(
  server: McpServer,
  client: GooglePlayClient,
  defaultPackageName?: string,
) {
  server.tool(
    "list_reviews",
    "List recent user reviews for an app, newest first. Each review has reviewId, authorName and comments[] containing the userComment (text, starRating 1-5, device, androidOsVersion, appVersionCode/Name, thumbsUp/DownCount, lastModified) and any developerComment already posted. Note the Google Play API only returns reviews created or modified in the last 7 days, only reviews that include written text, and only for production releases. Use the returned reviewId with get_review or reply_to_review.",
    {
      package_name: z
        .string()
        .optional()
        .describe("App package name, e.g. 'com.acme.app' (defaults to GOOGLE_PLAY_PACKAGE_NAME)"),
      translation_language: z
        .string()
        .optional()
        .describe(
          "BCP-47 language code, e.g. 'en'. When set, Google returns translated review text alongside the original.",
        ),
      limit: z
        .number()
        .int()
        .min(1)
        .max(500)
        .optional()
        .describe("Max reviews to return (default: 50)"),
    },
    async ({ package_name, translation_language, limit }) => {
      try {
        const pkg = resolvePackage(package_name, defaultPackageName);
        const max = limit ?? 50;
        const path = `/applications/${encodeURIComponent(pkg)}/reviews`;
        const reviews: Review[] = [];
        let token: string | undefined;

        for (let page = 0; page < MAX_PAGES && reviews.length < max; page++) {
          const res: ReviewsListResponse = await client.get(path, {
            maxResults: Math.min(max - reviews.length, PAGE_SIZE),
            token,
            translationLanguage: translation_language,
          });
          reviews.push(...(res.reviews ?? []));
          token = res.tokenPagination?.nextPageToken;
          if (!token) break;
        }

        return ok({ packageName: pkg, count: reviews.length, reviews: reviews.slice(0, max) });
      } catch (e) {
        return err(e);
      }
    },
  );

  server.tool(
    "get_review",
    "Get a single user review by its reviewId, including the full comment thread (user comment and any developer reply). Get review IDs from list_reviews.",
    {
      review_id: z.string().describe("Review ID as returned by list_reviews"),
      package_name: z
        .string()
        .optional()
        .describe("App package name, e.g. 'com.acme.app' (defaults to GOOGLE_PLAY_PACKAGE_NAME)"),
      translation_language: z
        .string()
        .optional()
        .describe("BCP-47 language code, e.g. 'en', to also return translated review text"),
    },
    async ({ review_id, package_name, translation_language }) => {
      try {
        const pkg = resolvePackage(package_name, defaultPackageName);
        const res = await client.get<Review>(
          `/applications/${encodeURIComponent(pkg)}/reviews/${encodeURIComponent(review_id)}`,
          { translationLanguage: translation_language },
        );
        return ok(res);
      } catch (e) {
        return err(e);
      }
    },
  );

  server.tool(
    "reply_to_review",
    "Post a public developer reply to a user review. Replies are limited to 350 characters and are shown publicly on the Play Store under the review. Replying to a review that already has a reply edits the existing reply; the user is only notified about the first reply. Get review IDs from list_reviews.",
    {
      review_id: z.string().describe("Review ID as returned by list_reviews"),
      reply_text: z
        .string()
        .min(1)
        .max(350)
        .describe("Public reply text, max 350 characters (Google Play limit)"),
      package_name: z
        .string()
        .optional()
        .describe("App package name, e.g. 'com.acme.app' (defaults to GOOGLE_PLAY_PACKAGE_NAME)"),
    },
    async ({ review_id, reply_text, package_name }) => {
      try {
        const pkg = resolvePackage(package_name, defaultPackageName);
        const res = await client.post<{
          result?: { replyText?: string; lastEdited?: { seconds?: string; nanos?: number } };
        }>(
          `/applications/${encodeURIComponent(pkg)}/reviews/${encodeURIComponent(review_id)}:reply`,
          { replyText: reply_text },
        );
        return ok({ reviewId: review_id, ...res });
      } catch (e) {
        return err(e);
      }
    },
  );
}
