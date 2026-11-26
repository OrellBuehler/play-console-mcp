import { GooglePlayClient, PUBLISHER_BASE_URL, REPORTING_BASE_URL } from "./play/client.js";
import { createTokenProvider } from "./play/auth.js";

const serviceAccountKey = process.env.GOOGLE_SERVICE_ACCOUNT_KEY;
const serviceAccountKeyPath =
  (process.env.GOOGLE_SERVICE_ACCOUNT_KEY_PATH || "").trim() || undefined;
const packageName = (process.env.GOOGLE_PLAY_PACKAGE_NAME || "").trim() || undefined;
const developerId = (process.env.GOOGLE_PLAY_DEVELOPER_ID || "").trim() || undefined;
const isEnabled = (value?: string) => /^(1|true|yes)$/i.test((value || "").trim());
const allowWrites = isEnabled(process.env.GOOGLE_PLAY_ALLOW_WRITES);
const allowDestructive = isEnabled(process.env.GOOGLE_PLAY_ALLOW_DESTRUCTIVE);

if (!serviceAccountKey?.trim() && !serviceAccountKeyPath) {
  console.error(
    "One of GOOGLE_SERVICE_ACCOUNT_KEY / GOOGLE_SERVICE_ACCOUNT_KEY_PATH is required. " +
      "Create a service account under Google Play Console > Setup > API access, grant it app " +
      "permissions, and download its JSON key.",
  );
  process.exit(1);
}

if (allowDestructive && !allowWrites) {
  console.error(
    "GOOGLE_PLAY_ALLOW_DESTRUCTIVE has no effect without GOOGLE_PLAY_ALLOW_WRITES: the server " +
      "is running read-only.",
  );
}

export const config = {
  packageName,
  developerId,
  allowWrites,
  allowDestructive,
  transport: "stdio" as const,
};

const tokenProvider = createTokenProvider({ serviceAccountKey, serviceAccountKeyPath });

export const client = new GooglePlayClient(tokenProvider, PUBLISHER_BASE_URL);
export const reportingClient = new GooglePlayClient(tokenProvider, REPORTING_BASE_URL);
