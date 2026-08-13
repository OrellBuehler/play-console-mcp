import { z } from "zod";

export const packageArg = z
  .string()
  .optional()
  .describe("App package name, e.g. 'com.acme.app' (defaults to GOOGLE_PLAY_PACKAGE_NAME)");

export const writeShape = {
  validate_only: z
    .boolean()
    .optional()
    .describe("Dry run: validate the change and discard the edit instead of committing it"),
  changes_not_sent_for_review: z
    .boolean()
    .optional()
    .describe(
      "Commit without sending the changes for review (only for apps where changes are reviewed separately)",
    ),
};

export const releaseNotesSchema = z
  .array(z.object({ language: z.string(), text: z.string() }))
  .optional()
  .describe(
    "Release notes per locale, e.g. [{language:'en-US',text:'Bug fixes'}]. Defaults to the source release's notes.",
  );
