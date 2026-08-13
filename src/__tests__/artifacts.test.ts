import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { GooglePlayClient } from "../play/client.js";
import { registerArtifactTools } from "../tools/artifacts.js";

type Handler = (args: any) => Promise<{ content: { text?: string }[]; isError?: boolean }>;

function collect(defaultPackage?: string) {
  const tools = new Map<string, Handler>();
  registerArtifactTools(
    { tool: (n: string, _d: string, _s: unknown, h: Handler) => tools.set(n, h) } as any,
    new GooglePlayClient(async () => "tok"),
    defaultPackage,
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

  it("errors when no package name is available", async () => {
    const bare = collect();
    const res = await bare.get("list_bundles")!({});
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain("No package name given");
    expect(mockFetch).not.toHaveBeenCalled();
  });
});
