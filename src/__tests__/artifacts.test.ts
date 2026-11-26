import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { readFile } from "node:fs/promises";
import { GooglePlayClient, PUBLISHER_UPLOAD_BASE_URL } from "../play/client.js";
import { registerArtifactTools } from "../tools/artifacts.js";

vi.mock("node:fs/promises", () => ({ readFile: vi.fn() }));

type Handler = (args: any) => Promise<{ content: { text?: string }[]; isError?: boolean }>;

function collect(defaultPackage?: string, allowWrites = true, allowDestructive = true) {
  const tools = new Map<string, Handler>();
  registerArtifactTools(
    {
      tool: (n: string, _d: string, _s: unknown, _a: unknown, h: Handler) => tools.set(n, h),
    } as any,
    new GooglePlayClient(async () => "tok"),
    defaultPackage,
    allowWrites,
    allowDestructive,
  );
  return tools;
}

function resp(body: unknown) {
  const text = typeof body === "string" ? body : JSON.stringify(body);
  return {
    ok: true,
    status: 200,
    statusText: "OK",
    text: () => Promise.resolve(text),
    json: () => Promise.resolve(JSON.parse(text)),
  };
}

const tools = collect("com.acme.app");

function calls(mockFetch: ReturnType<typeof vi.fn>) {
  return mockFetch.mock.calls.map((c) => `${c[1]?.method ?? "GET"} ${new URL(c[0]).pathname}`);
}

describe("artifact tools", () => {
  let mockFetch: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    mockFetch = vi.fn();
    vi.stubGlobal("fetch", mockFetch);
    vi.mocked(readFile).mockReset();
  });
  afterEach(() => vi.restoreAllMocks());

  it("list_bundles reads bundles inside an edit and cleans up", async () => {
    mockFetch
      .mockResolvedValueOnce(resp({ id: "a1" }))
      .mockResolvedValueOnce(resp({ bundles: [{ versionCode: 415, sha256: "abc" }] }))
      .mockResolvedValueOnce(resp(""));

    const res = await tools.get("list_bundles")!({});
    expect(calls(mockFetch)).toEqual([
      "POST /androidpublisher/v3/applications/com.acme.app/edits",
      "GET /androidpublisher/v3/applications/com.acme.app/edits/a1/bundles",
      "DELETE /androidpublisher/v3/applications/com.acme.app/edits/a1",
    ]);
    expect(JSON.parse(res.content[0].text!).bundles[0].versionCode).toBe(415);
  });

  it("list_apks reads apks inside an edit", async () => {
    mockFetch
      .mockResolvedValueOnce(resp({ id: "a2" }))
      .mockResolvedValueOnce(resp({ apks: [] }))
      .mockResolvedValueOnce(resp(""));

    await tools.get("list_apks")!({});
    expect(calls(mockFetch)[1]).toBe(
      "GET /androidpublisher/v3/applications/com.acme.app/edits/a2/apks",
    );
  });

  it("list_generated_apks reads outside the edits workflow", async () => {
    mockFetch.mockResolvedValueOnce(resp({ generatedApks: [] }));

    await tools.get("list_generated_apks")!({ version_code: "415" });
    expect(calls(mockFetch)).toEqual([
      "GET /androidpublisher/v3/applications/com.acme.app/generatedApks/415",
    ]);
  });

  it("get_expansion_file reads the expansion file of an apk version code", async () => {
    mockFetch
      .mockResolvedValueOnce(resp({ id: "a3" }))
      .mockResolvedValueOnce(resp({ fileSize: "100" }))
      .mockResolvedValueOnce(resp(""));

    await tools.get("get_expansion_file")!({
      apk_version_code: "415",
      expansion_file_type: "main",
    });
    expect(calls(mockFetch)[1]).toBe(
      "GET /androidpublisher/v3/applications/com.acme.app/edits/a3/apks/415/expansionFiles/main",
    );
  });

  it("list_device_tier_configs passes pagination through as query params", async () => {
    mockFetch.mockResolvedValueOnce(resp({ deviceTierConfigs: [{ deviceTierConfigId: "7" }] }));

    const res = await tools.get("list_device_tier_configs")!({ limit: 25, page_token: "tok-2" });
    const url = new URL(mockFetch.mock.calls[0][0]);
    expect(url.pathname).toBe("/androidpublisher/v3/applications/com.acme.app/deviceTierConfigs");
    expect(url.searchParams.get("pageSize")).toBe("25");
    expect(url.searchParams.get("pageToken")).toBe("tok-2");
    expect(JSON.parse(res.content[0].text!).count).toBe(1);
  });

  it("get_device_tier_config reads a single config by id", async () => {
    mockFetch.mockResolvedValueOnce(resp({ deviceTierConfigId: "7", deviceGroups: [] }));

    await tools.get("get_device_tier_config")!({ device_tier_config_id: "7" });
    expect(calls(mockFetch)).toEqual([
      "GET /androidpublisher/v3/applications/com.acme.app/deviceTierConfigs/7",
    ]);
  });

  it("upload_bundle posts the bytes to the upload host and commits", async () => {
    const bytes = Buffer.from([1, 2, 3]);
    vi.mocked(readFile).mockResolvedValueOnce(bytes as never);
    mockFetch
      .mockResolvedValueOnce(resp({ id: "b1" }))
      .mockResolvedValueOnce(resp({ versionCode: 416, sha256: "def" }))
      .mockResolvedValueOnce(resp({}));

    const res = await tools.get("upload_bundle")!({
      file_path: "/tmp/app-release.aab",
      ack_bundle_installation_warning: true,
      device_tier_config_id: "LATEST",
      changes_in_review_behavior: "ERROR_IF_IN_REVIEW",
    });

    expect(readFile).toHaveBeenCalledWith("/tmp/app-release.aab");
    const [url, options] = mockFetch.mock.calls[1];
    expect(new URL(url).origin + new URL(url).pathname).toBe(
      `${PUBLISHER_UPLOAD_BASE_URL}/applications/com.acme.app/edits/b1/bundles`,
    );
    expect(new URL(url).searchParams.get("uploadType")).toBe("media");
    expect(new URL(url).searchParams.get("ackBundleInstallationWarning")).toBe("true");
    expect(new URL(url).searchParams.get("deviceTierConfigId")).toBe("LATEST");
    expect(options.method).toBe("POST");
    expect(options.body).toBe(bytes);
    expect(options.headers["Content-Type"]).toBe("application/octet-stream");
    expect(calls(mockFetch)).toEqual([
      "POST /androidpublisher/v3/applications/com.acme.app/edits",
      "POST /upload/androidpublisher/v3/applications/com.acme.app/edits/b1/bundles",
      "POST /androidpublisher/v3/applications/com.acme.app/edits/b1:commit",
    ]);
    expect(new URL(mockFetch.mock.calls[2][0]).searchParams.get("changesInReviewBehavior")).toBe(
      "ERROR_IF_IN_REVIEW",
    );
    expect(JSON.parse(res.content[0].text!)).toEqual({
      committed: true,
      validatedOnly: false,
      bundle: { versionCode: 416, sha256: "def" },
    });
  });

  it("upload_bundle with a track releases the new version code in the same edit", async () => {
    vi.mocked(readFile).mockResolvedValueOnce(Buffer.from([1]) as never);
    mockFetch
      .mockResolvedValueOnce(resp({ id: "b2" }))
      .mockResolvedValueOnce(resp({ versionCode: 416 }))
      .mockResolvedValueOnce(resp({ track: "internal" }))
      .mockResolvedValueOnce(resp({}));

    const res = await tools.get("upload_bundle")!({
      file_path: "/tmp/app-release.AAB",
      track: "internal",
      release_name: "1.4.0 (416)",
      release_notes: [{ language: "en-US", text: "Bug fixes" }],
    });

    expect(calls(mockFetch)).toEqual([
      "POST /androidpublisher/v3/applications/com.acme.app/edits",
      "POST /upload/androidpublisher/v3/applications/com.acme.app/edits/b2/bundles",
      "PUT /androidpublisher/v3/applications/com.acme.app/edits/b2/tracks/internal",
      "POST /androidpublisher/v3/applications/com.acme.app/edits/b2:commit",
    ]);
    expect(JSON.parse(mockFetch.mock.calls[2][1].body)).toEqual({
      track: "internal",
      releases: [
        {
          versionCodes: ["416"],
          status: "draft",
          name: "1.4.0 (416)",
          releaseNotes: [{ language: "en-US", text: "Bug fixes" }],
        },
      ],
    });
    expect(JSON.parse(res.content[0].text!).track).toEqual({ track: "internal" });
  });

  it("upload_bundle validates and discards the edit on a dry run", async () => {
    vi.mocked(readFile).mockResolvedValueOnce(Buffer.from([1]) as never);
    mockFetch
      .mockResolvedValueOnce(resp({ id: "b3" }))
      .mockResolvedValueOnce(resp({ versionCode: 416 }))
      .mockResolvedValueOnce(resp({}))
      .mockResolvedValueOnce(resp(""));

    const res = await tools.get("upload_bundle")!({
      file_path: "/tmp/app-release.aab",
      validate_only: true,
    });
    expect(calls(mockFetch)).toEqual([
      "POST /androidpublisher/v3/applications/com.acme.app/edits",
      "POST /upload/androidpublisher/v3/applications/com.acme.app/edits/b3/bundles",
      "POST /androidpublisher/v3/applications/com.acme.app/edits/b3:validate",
      "DELETE /androidpublisher/v3/applications/com.acme.app/edits/b3",
    ]);
    expect(JSON.parse(res.content[0].text!).committed).toBe(false);
  });

  it("upload_bundle deletes the edit when the upload fails", async () => {
    vi.mocked(readFile).mockResolvedValueOnce(Buffer.from([1]) as never);
    mockFetch
      .mockResolvedValueOnce(resp({ id: "b4" }))
      .mockResolvedValueOnce({
        ok: false,
        status: 403,
        statusText: "Forbidden",
        text: () => Promise.resolve("Version code 416 has already been used."),
      })
      .mockResolvedValueOnce(resp(""));

    const res = await tools.get("upload_bundle")!({ file_path: "/tmp/app-release.aab" });
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain("Version code 416 has already been used.");
    expect(calls(mockFetch)[2]).toBe(
      "DELETE /androidpublisher/v3/applications/com.acme.app/edits/b4",
    );
  });

  it("upload_bundle rejects anything but an .aab without opening an edit", async () => {
    const res = await tools.get("upload_bundle")!({ file_path: "/tmp/app-release.apk" });
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain("Unsupported file type '.apk'");
    expect(readFile).not.toHaveBeenCalled();
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("upload_bundle rejects release options without a track", async () => {
    const res = await tools.get("upload_bundle")!({
      file_path: "/tmp/app-release.aab",
      status: "completed",
    });
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain("need track to be set");
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("registers upload_bundle only when writes and destructive tools are both allowed", () => {
    const read = [
      "list_bundles",
      "list_apks",
      "list_generated_apks",
      "get_expansion_file",
      "list_device_tier_configs",
      "get_device_tier_config",
    ];
    expect([...collect("com.acme.app", false, false).keys()]).toEqual(read);
    expect([...collect("com.acme.app", true, false).keys()]).toEqual([
      ...read,
      "create_device_tier_config",
    ]);
    expect([...collect("com.acme.app", false, true).keys()]).toEqual(read);
    expect([...collect("com.acme.app", true, true).keys()]).toEqual([
      ...read,
      "create_device_tier_config",
      "upload_bundle",
    ]);
  });

  it("create_device_tier_config posts the config as given", async () => {
    mockFetch.mockResolvedValueOnce(resp({ deviceTierConfigId: "9" }));
    const config = { deviceGroups: [{ name: "high_ram", deviceSelectors: [] }] };
    const res = await tools.get("create_device_tier_config")!({
      config,
      allow_unknown_devices: true,
    });
    expect(calls(mockFetch)).toEqual([
      "POST /androidpublisher/v3/applications/com.acme.app/deviceTierConfigs",
    ]);
    expect(new URL(mockFetch.mock.calls[0][0]).searchParams.get("allowUnknownDevices")).toBe(
      "true",
    );
    expect(JSON.parse(mockFetch.mock.calls[0][1].body)).toEqual(config);
    expect(JSON.parse(res.content[0].text!).deviceTierConfigId).toBe("9");
  });

  it("errors when no package name is available", async () => {
    const bare = collect();
    const res = await bare.get("list_bundles")!({});
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain("No package name given");
    expect(mockFetch).not.toHaveBeenCalled();
  });
});
