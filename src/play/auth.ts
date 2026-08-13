import { SignJWT, importPKCS8 } from "jose";
import { readFile } from "node:fs/promises";

export interface GoogleAuth {
  serviceAccountKey?: string;
  serviceAccountKeyPath?: string;
}

export type TokenProvider = () => Promise<string>;

export const SCOPES = [
  "https://www.googleapis.com/auth/androidpublisher",
  "https://www.googleapis.com/auth/playdeveloperreporting",
].join(" ");

export const TOKEN_URL = "https://oauth2.googleapis.com/token";

interface ServiceAccountKey {
  client_email: string;
  private_key: string;
  private_key_id?: string;
}

async function loadKey(auth: GoogleAuth): Promise<ServiceAccountKey> {
  let raw: string;
  if (auth.serviceAccountKey && auth.serviceAccountKey.trim()) {
    raw = auth.serviceAccountKey;
  } else if (auth.serviceAccountKeyPath) {
    raw = await readFile(auth.serviceAccountKeyPath, "utf-8");
  } else {
    throw new Error("No Google service account key configured");
  }

  let parsed: Partial<ServiceAccountKey>;
  try {
    parsed = JSON.parse(raw) as Partial<ServiceAccountKey>;
  } catch (e) {
    throw new Error(`Service account key is not valid JSON: ${String(e)}`, { cause: e });
  }
  if (!parsed.client_email || !parsed.private_key) {
    throw new Error("Service account key JSON is missing client_email or private_key");
  }
  return parsed as ServiceAccountKey;
}

export function createTokenProvider(
  auth: GoogleAuth,
  nowMs: () => number = Date.now,
): TokenProvider {
  let cached: { token: string; expiresAt: number } | null = null;
  let key: ServiceAccountKey | null = null;

  return async () => {
    const now = Math.floor(nowMs() / 1000);
    if (cached && cached.expiresAt > now + 60) return cached.token;

    if (key === null) key = await loadKey(auth);
    const privateKey = await importPKCS8(key.private_key, "RS256");

    const assertion = await new SignJWT({ scope: SCOPES })
      .setProtectedHeader({
        alg: "RS256",
        typ: "JWT",
        ...(key.private_key_id ? { kid: key.private_key_id } : {}),
      })
      .setIssuer(key.client_email)
      .setAudience(TOKEN_URL)
      .setIssuedAt(now)
      .setExpirationTime(now + 3600)
      .sign(privateKey);

    const res = await fetch(TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
        assertion,
      }),
      signal: AbortSignal.timeout(30000),
    });
    if (!res.ok) {
      throw new Error(
        `Google token exchange failed: ${res.status} ${res.statusText}: ${await res.text()}`,
      );
    }
    const json = (await res.json()) as { access_token?: string; expires_in?: number };
    if (!json.access_token) {
      throw new Error("Google token exchange returned no access_token");
    }

    cached = { token: json.access_token, expiresAt: now + (json.expires_in ?? 3600) };
    return cached.token;
  };
}
