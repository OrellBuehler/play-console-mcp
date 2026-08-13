import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { readFile } from "node:fs/promises";
import type { GooglePlayClient } from "../play/client.js";
import { ok, err, resolvePackage } from "../play/format.js";
import { readWithEdit, withEdit } from "../play/edits.js";
import { packageArg, writeShape } from "./shared.js";

const IMAGE_TYPES = [
  "phoneScreenshots",
  "sevenInchScreenshots",
  "tenInchScreenshots",
  "tvScreenshots",
  "wearScreenshots",
  "icon",
  "featureGraphic",
  "tvBanner",
] as const;

const MAX_IMAGE_BYTES = 15 * 1024 * 1024;

const CONTENT_TYPES: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
};

const languageArg = z
  .string()
  .describe("BCP-47 language tag of the listing, e.g. 'en-US' or 'de-DE'");

const imageTypeArg = z
  .enum(IMAGE_TYPES)
  .describe(
    "Which store asset: 'phoneScreenshots', 'sevenInchScreenshots', 'tenInchScreenshots', 'tvScreenshots', 'wearScreenshots', 'icon', 'featureGraphic' or 'tvBanner'",
  );

function contentTypeFor(filePath: string): string {
  const ext = filePath.split(".").pop()?.toLowerCase() ?? "";
  const type = CONTENT_TYPES[ext];
  if (!type) {
    throw new Error(`Unsupported image type '.${ext}'. Google Play accepts PNG and JPEG images.`);
  }
  return type;
}

export function registerListingTools(
  server: McpServer,
  client: GooglePlayClient,
  defaultPackageName?: string,
  allowDestructive = false,
) {
  server.tool(
    "list_listings",
    "List every localized store listing for an app, each with language, title, shortDescription, fullDescription and video. Start here to see which locales the app is published in before using update_listing.",
    {
      package_name: packageArg,
    },
    async ({ package_name }) => {
      try {
        const pkg = resolvePackage(package_name, defaultPackageName);
        const res = await readWithEdit(client, pkg, (base) => client.get(`${base}/listings`));
        return ok(res);
      } catch (e) {
        return err(e);
      }
    },
  );

  server.tool(
    "get_listing",
    "Get the store listing for one locale: title, shortDescription, fullDescription and video. Use list_listings first if you do not know which locales exist.",
    {
      language: languageArg,
      package_name: packageArg,
    },
    async ({ language, package_name }) => {
      try {
        const pkg = resolvePackage(package_name, defaultPackageName);
        const res = await readWithEdit(client, pkg, (base) =>
          client.get(`${base}/listings/${encodeURIComponent(language)}`),
        );
        return ok(res);
      } catch (e) {
        return err(e);
      }
    },
  );

  server.tool(
    "update_listing",
    "Update the store listing text for one locale. Only the fields you pass are changed, so you can edit just the title without touching the description. Creates the listing if that locale does not exist yet. Google's limits: title 30 characters, short description 80, full description 4000. Use validate_only first to check the change without committing.",
    {
      language: languageArg,
      title: z
        .string()
        .max(30)
        .optional()
        .describe("App name shown on the store, max 30 characters"),
      short_description: z
        .string()
        .max(80)
        .optional()
        .describe("Tagline shown above the fold, max 80 characters"),
      full_description: z
        .string()
        .max(4000)
        .optional()
        .describe("Full store description, max 4000 characters"),
      video: z
        .string()
        .optional()
        .describe("YouTube URL of the promo video. Pass an empty string to remove it."),
      package_name: packageArg,
      ...writeShape,
    },
    async ({
      language,
      title,
      short_description,
      full_description,
      video,
      package_name,
      validate_only,
      changes_not_sent_for_review,
    }) => {
      try {
        const pkg = resolvePackage(package_name, defaultPackageName);
        const body = {
          language,
          ...(title === undefined ? {} : { title }),
          ...(short_description === undefined ? {} : { shortDescription: short_description }),
          ...(full_description === undefined ? {} : { fullDescription: full_description }),
          ...(video === undefined ? {} : { video }),
        };
        const { result, committed } = await withEdit(
          client,
          pkg,
          (base) => client.patch(`${base}/listings/${encodeURIComponent(language)}`, body),
          { validateOnly: validate_only, changesNotSentForReview: changes_not_sent_for_review },
        );
        return ok({ committed, validatedOnly: !committed, listing: result });
      } catch (e) {
        return err(e);
      }
    },
  );

  server.tool(
    "get_app_details",
    "Get app-level details that are not per-locale: contactEmail, contactPhone, contactWebsite and defaultLanguage.",
    {
      package_name: packageArg,
    },
    async ({ package_name }) => {
      try {
        const pkg = resolvePackage(package_name, defaultPackageName);
        const res = await readWithEdit(client, pkg, (base) => client.get(`${base}/details`));
        return ok(res);
      } catch (e) {
        return err(e);
      }
    },
  );

  server.tool(
    "update_app_details",
    "Update app-level contact details and default language. Only the fields you pass are changed. Use validate_only first to check the change without committing.",
    {
      contact_email: z.string().optional().describe("Developer contact email shown on the store"),
      contact_phone: z
        .string()
        .optional()
        .describe("Developer contact phone number in E.164 format, e.g. '+41791234567'"),
      contact_website: z.string().optional().describe("Developer website URL shown on the store"),
      default_language: z
        .string()
        .optional()
        .describe(
          "BCP-47 tag of the listing used when a user's locale has no listing, e.g. 'en-US'",
        ),
      package_name: packageArg,
      ...writeShape,
    },
    async ({
      contact_email,
      contact_phone,
      contact_website,
      default_language,
      package_name,
      validate_only,
      changes_not_sent_for_review,
    }) => {
      try {
        const pkg = resolvePackage(package_name, defaultPackageName);
        const body = {
          ...(contact_email === undefined ? {} : { contactEmail: contact_email }),
          ...(contact_phone === undefined ? {} : { contactPhone: contact_phone }),
          ...(contact_website === undefined ? {} : { contactWebsite: contact_website }),
          ...(default_language === undefined ? {} : { defaultLanguage: default_language }),
        };
        const { result, committed } = await withEdit(
          client,
          pkg,
          (base) => client.patch(`${base}/details`, body),
          { validateOnly: validate_only, changesNotSentForReview: changes_not_sent_for_review },
        );
        return ok({ committed, validatedOnly: !committed, details: result });
      } catch (e) {
        return err(e);
      }
    },
  );

  server.tool(
    "list_listing_images",
    "List the store images of one type for one locale, each with id, url, sha1 and sha256. Use the returned ids with delete_listing_image.",
    {
      language: languageArg,
      image_type: imageTypeArg,
      package_name: packageArg,
    },
    async ({ language, image_type, package_name }) => {
      try {
        const pkg = resolvePackage(package_name, defaultPackageName);
        const res = await readWithEdit(client, pkg, (base) =>
          client.get(`${base}/listings/${encodeURIComponent(language)}/${image_type}`),
        );
        return ok(res);
      } catch (e) {
        return err(e);
      }
    },
  );

  if (!allowDestructive) return;

  server.tool(
    "upload_listing_image",
    "Upload a store image (screenshot, icon, feature graphic or TV banner) from a local file for one locale. Adds to the existing images of that type rather than replacing them — use delete_all_listing_images first to replace a full screenshot set. PNG and JPEG only, max 15 MB. Use validate_only first to check the change without committing.",
    {
      language: languageArg,
      image_type: imageTypeArg,
      file_path: z
        .string()
        .describe("Absolute path to a local .png or .jpg file to upload, max 15 MB"),
      package_name: packageArg,
      ...writeShape,
    },
    async ({
      language,
      image_type,
      file_path,
      package_name,
      validate_only,
      changes_not_sent_for_review,
    }) => {
      try {
        const pkg = resolvePackage(package_name, defaultPackageName);
        const contentType = contentTypeFor(file_path);
        const bytes = await readFile(file_path);
        if (bytes.byteLength > MAX_IMAGE_BYTES) {
          throw new Error(
            `Image is ${bytes.byteLength} bytes, over the 15 MB limit Google Play accepts.`,
          );
        }
        const { result, committed } = await withEdit(
          client,
          pkg,
          (base) =>
            client.upload(
              `${base}/listings/${encodeURIComponent(language)}/${image_type}`,
              bytes,
              contentType,
            ),
          { validateOnly: validate_only, changesNotSentForReview: changes_not_sent_for_review },
        );
        return ok({ committed, validatedOnly: !committed, image: result });
      } catch (e) {
        return err(e);
      }
    },
  );

  server.tool(
    "delete_listing",
    "Delete the store listing for one locale, removing that language from the store. Use validate_only first to check the change without committing.",
    {
      language: languageArg,
      package_name: packageArg,
      ...writeShape,
    },
    async ({ language, package_name, validate_only, changes_not_sent_for_review }) => {
      try {
        const pkg = resolvePackage(package_name, defaultPackageName);
        const { committed } = await withEdit(
          client,
          pkg,
          (base) => client.del(`${base}/listings/${encodeURIComponent(language)}`),
          { validateOnly: validate_only, changesNotSentForReview: changes_not_sent_for_review },
        );
        return ok({ committed, validatedOnly: !committed, deletedListing: language });
      } catch (e) {
        return err(e);
      }
    },
  );

  server.tool(
    "delete_all_listings",
    "Delete every localized store listing for the app. This removes all store text in all languages — use validate_only first and prefer delete_listing for a single locale.",
    {
      package_name: packageArg,
      ...writeShape,
    },
    async ({ package_name, validate_only, changes_not_sent_for_review }) => {
      try {
        const pkg = resolvePackage(package_name, defaultPackageName);
        const { committed } = await withEdit(
          client,
          pkg,
          (base) => client.del(`${base}/listings`),
          {
            validateOnly: validate_only,
            changesNotSentForReview: changes_not_sent_for_review,
          },
        );
        return ok({ committed, validatedOnly: !committed, deletedAllListings: true });
      } catch (e) {
        return err(e);
      }
    },
  );

  server.tool(
    "delete_listing_image",
    "Delete one store image by its id. Get image ids from list_listing_images. Use validate_only first to check the change without committing.",
    {
      language: languageArg,
      image_type: imageTypeArg,
      image_id: z.string().describe("Image id from list_listing_images"),
      package_name: packageArg,
      ...writeShape,
    },
    async ({
      language,
      image_type,
      image_id,
      package_name,
      validate_only,
      changes_not_sent_for_review,
    }) => {
      try {
        const pkg = resolvePackage(package_name, defaultPackageName);
        const { committed } = await withEdit(
          client,
          pkg,
          (base) =>
            client.del(
              `${base}/listings/${encodeURIComponent(language)}/${image_type}/${encodeURIComponent(image_id)}`,
            ),
          { validateOnly: validate_only, changesNotSentForReview: changes_not_sent_for_review },
        );
        return ok({ committed, validatedOnly: !committed, deletedImage: image_id });
      } catch (e) {
        return err(e);
      }
    },
  );

  server.tool(
    "delete_all_listing_images",
    "Delete every image of one type for one locale, e.g. all phone screenshots for 'en-US'. Pair with upload_listing_image to replace a full screenshot set. Use validate_only first to check the change without committing.",
    {
      language: languageArg,
      image_type: imageTypeArg,
      package_name: packageArg,
      ...writeShape,
    },
    async ({ language, image_type, package_name, validate_only, changes_not_sent_for_review }) => {
      try {
        const pkg = resolvePackage(package_name, defaultPackageName);
        const { committed } = await withEdit(
          client,
          pkg,
          (base) => client.del(`${base}/listings/${encodeURIComponent(language)}/${image_type}`),
          { validateOnly: validate_only, changesNotSentForReview: changes_not_sent_for_review },
        );
        return ok({ committed, validatedOnly: !committed, deletedAllImages: image_type });
      } catch (e) {
        return err(e);
      }
    },
  );
}
