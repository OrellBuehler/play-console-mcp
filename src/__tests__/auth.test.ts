import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { generateKeyPairSync } from "node:crypto";
import { createTokenProvider, SCOPES, TOKEN_URL } from "../play/auth.js";

const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const pem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();

const serviceAccountKey = JSON.stringify({
  type: "service_account",
  client_email: "bot@example.iam.gserviceaccount.com",
  private_key: pem,
  private_key_id: "key-1",
});

function tokenResponse(token: string, expiresIn = 3600) {
  return {
    ok: true,
    status: 200,
    statusText: "OK",
    json: () => Promise.resolve({ access_token: token, expires_in: expiresIn }),
  };
}

function decode(part: string) {
  return JSON.parse(Buffer.from(part, "base64url").toString("utf-8"));
}

describe("createTokenProvider", () => {
  let mockFetch: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    mockFetch = vi.fn();
    vi.stubGlobal("fetch", mockFetch);
  });
  afterEach(() => vi.restoreAllMocks());

  it("signs an RS256 assertion and exchanges it for an access token", async () => {
    mockFetch.mockResolvedValueOnce(tokenResponse("ya29.token"));
    const provider = createTokenProvider({ serviceAccountKey });

    expect(await provider()).toBe("ya29.token");

    const [url, options] = mockFetch.mock.calls[0];
    expect(url).toBe(TOKEN_URL);
    const body = new URLSearchParams(options.body as URLSearchParams);
    expect(body.get("grant_type")).toBe("urn:ietf:params:oauth:grant-type:jwt-bearer");

    const [header, payload] = body.get("assertion")!.split(".");
    expect(decode(header)).toMatchObject({ alg: "RS256", typ: "JWT", kid: "key-1" });
    const claims = decode(payload);
    expect(claims.iss).toBe("bot@example.iam.gserviceaccount.com");
    expect(claims.aud).toBe(TOKEN_URL);
    expect(claims.scope).toBe(SCOPES);
    expect(claims.scope).toContain("androidpublisher");
    expect(claims.scope).toContain("playdeveloperreporting");
    expect(claims.exp - claims.iat).toBe(3600);
  });

  it("caches the token until it is close to expiry", async () => {
    mockFetch.mockResolvedValue(tokenResponse("first"));
    let now = 1_000_000_000_000;
    const provider = createTokenProvider({ serviceAccountKey }, () => now);

    expect(await provider()).toBe("first");
    expect(await provider()).toBe("first");
    expect(mockFetch).toHaveBeenCalledTimes(1);

    mockFetch.mockResolvedValue(tokenResponse("second"));
    now += 3600 * 1000;
    expect(await provider()).toBe("second");
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it("reads the key from a file path when no inline key is given", async () => {
    const { writeFileSync, mkdtempSync } = await import("node:fs");
    const { join } = await import("node:path");
    const { tmpdir } = await import("node:os");
    const dir = mkdtempSync(join(tmpdir(), "play-mcp-"));
    const file = join(dir, "service-account.json");
    writeFileSync(file, serviceAccountKey);

    mockFetch.mockResolvedValueOnce(tokenResponse("from-file"));
    const provider = createTokenProvider({ serviceAccountKeyPath: file });
    expect(await provider()).toBe("from-file");
  });

  it("throws when no key is configured", async () => {
    await expect(createTokenProvider({})()).rejects.toThrow("No Google service account key");
  });

  it("throws on malformed key JSON", async () => {
    await expect(createTokenProvider({ serviceAccountKey: "not json" })()).rejects.toThrow(
      "not valid JSON",
    );
  });

  it("throws when the key JSON lacks client_email or private_key", async () => {
    await expect(
      createTokenProvider({ serviceAccountKey: JSON.stringify({ client_email: "a@b.c" }) })(),
    ).rejects.toThrow("missing client_email or private_key");
  });

  it("surfaces token exchange failures", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 400,
      statusText: "Bad Request",
      text: () => Promise.resolve("invalid_grant"),
    });
    await expect(createTokenProvider({ serviceAccountKey })()).rejects.toThrow(
      "Google token exchange failed: 400 Bad Request: invalid_grant",
    );
  });
});
