import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

describe("config", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.stubEnv("GOOGLE_SERVICE_ACCOUNT_KEY", "");
    vi.stubEnv("GOOGLE_SERVICE_ACCOUNT_KEY_PATH", "");
    vi.stubEnv("GOOGLE_PLAY_PACKAGE_NAME", "");
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it("exits when no service account key is configured", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(process, "exit").mockImplementation(() => {
      throw new Error("exit:1");
    });
    await expect(import("../config.js")).rejects.toThrow("exit:1");
  });

  it("accepts an inline service account key", async () => {
    vi.stubEnv("GOOGLE_SERVICE_ACCOUNT_KEY", '{"client_email":"a@b.c","private_key":"k"}');
    const { client, reportingClient } = await import("../config.js");
    expect(client.baseUrl).toContain("androidpublisher.googleapis.com");
    expect(reportingClient.baseUrl).toContain("playdeveloperreporting.googleapis.com");
  });

  it("accepts a key path and an optional default package name", async () => {
    vi.stubEnv("GOOGLE_SERVICE_ACCOUNT_KEY_PATH", "/tmp/service-account.json");
    vi.stubEnv("GOOGLE_PLAY_PACKAGE_NAME", "com.acme.app");
    const { config } = await import("../config.js");
    expect(config.packageName).toBe("com.acme.app");
    expect(config.transport).toBe("stdio");
  });

  it("leaves the package name undefined when unset", async () => {
    vi.stubEnv("GOOGLE_SERVICE_ACCOUNT_KEY_PATH", "/tmp/service-account.json");
    const { config } = await import("../config.js");
    expect(config.packageName).toBeUndefined();
  });
});
