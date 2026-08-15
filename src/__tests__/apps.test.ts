import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { GooglePlayClient, REPORTING_BASE_URL } from "../play/client.js";
import { registerAppsTools } from "../tools/apps.js";

type Handler = (args: any) => Promise<{ content: { text?: string }[]; isError?: boolean }>;

function collect(defaultPackage?: string) {
  const tools = new Map<string, Handler>();
  registerAppsTools(
    { tool: (n: string, _d: string, _s: unknown, h: Handler) => tools.set(n, h) } as any,
    new GooglePlayClient(async () => "tok", REPORTING_BASE_URL),
    defaultPackage,
  );
  return tools;
}

function resp(body: unknown) {
  const text = JSON.stringify(body);
  return {
    ok: true,
    status: 200,
    statusText: "OK",
    text: () => Promise.resolve(text),
    json: () => Promise.resolve(JSON.parse(text)),
  };
}

const tools = collect("com.acme.app");

describe("app tools", () => {
  let mockFetch: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    mockFetch = vi.fn();
    vi.stubGlobal("fetch", mockFetch);
  });
  afterEach(() => vi.restoreAllMocks());

  it("list_apps searches accessible apps without a package name", async () => {
    mockFetch.mockResolvedValueOnce(
      resp({ apps: [{ packageName: "com.acme.app", displayName: "Acme" }] }),
    );

    const res = await tools.get("list_apps")!({ limit: 100, page_token: "tok-2" });
    const url = new URL(mockFetch.mock.calls[0][0]);
    expect(url.pathname).toBe("/v1beta1/apps:search");
    expect(url.searchParams.get("pageSize")).toBe("100");
    expect(url.searchParams.get("pageToken")).toBe("tok-2");
    const payload = JSON.parse(res.content[0].text!);
    expect(payload.count).toBe(1);
    expect(payload.apps[0].packageName).toBe("com.acme.app");
  });

  it("list_apps works without a default package name", async () => {
    mockFetch.mockResolvedValueOnce(resp({ apps: [] }));
    const res = await collect().get("list_apps")!({});
    expect(res.isError).toBeUndefined();
    expect(new URL(mockFetch.mock.calls[0][0]).searchParams.get("pageSize")).toBeNull();
  });

  it("get_release_filter_options fetches the filter options of an app", async () => {
    mockFetch.mockResolvedValueOnce(
      resp({ tracks: [{ displayName: "Production", servingReleases: [] }] }),
    );

    const res = await tools.get("get_release_filter_options")!({});
    expect(mockFetch.mock.calls[0][0]).toBe(
      `${REPORTING_BASE_URL}/apps/com.acme.app:fetchReleaseFilterOptions`,
    );
    expect(JSON.parse(res.content[0].text!).tracks[0].displayName).toBe("Production");
  });

  it("errors when no package name is available", async () => {
    const res = await collect().get("get_release_filter_options")!({});
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain("No package name given");
    expect(mockFetch).not.toHaveBeenCalled();
  });
});
