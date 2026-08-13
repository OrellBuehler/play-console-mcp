import { GooglePlayClient, PUBLISHER_BASE_URL, REPORTING_BASE_URL } from "./play/client.js";
import { createTokenProvider } from "./play/auth.js";

const serviceAccountKey = process.env.GOOGLE_SERVICE_ACCOUNT_KEY;
const serviceAccountKeyPath =
  (process.env.GOOGLE_SERVICE_ACCOUNT_KEY_PATH || "").trim() || undefined;
const packageName = (process.env.GOOGLE_PLAY_PACKAGE_NAME || "").trim() || undefined;
const allowDestructive = /^(1|true|yes)$/i.test(
  (process.env.GOOGLE_PLAY_ALLOW_DESTRUCTIVE || "").trim(),
);

if (!serviceAccountKey?.trim() && !serviceAccountKeyPath) {
  console.error(
    "One of GOOGLE_SERVICE_ACCOUNT_KEY / GOOGLE_SERVICE_ACCOUNT_KEY_PATH is required. " +
      "Create a service account under Google Play Console > Setup > API access, grant it app " +
      "permissions, and download its JSON key.",
  );
  process.exit(1);
}

export const config = {
  packageName,
  allowDestructive,
  transport: "stdio" as const,
};

const tokenProvider = createTokenProvider({ serviceAccountKey, serviceAccountKeyPath });

export const client = new GooglePlayClient(tokenProvider, PUBLISHER_BASE_URL);
export const reportingClient = new GooglePlayClient(tokenProvider, REPORTING_BASE_URL);
