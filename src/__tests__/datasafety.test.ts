import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { readFile } from "node:fs/promises";
import { GooglePlayClient } from "../play/client.js";
import { registerDataSafetyTools } from "../tools/datasafety.js";

vi.mock("node:fs/promises", () => ({ readFile: vi.fn() }));

type Handler = (args: any) => Promise<{ content: { text?: string }[]; isError?: boolean }>;

function collect(defaultPackage?: string, allowWrites = true, allowDestructive = true) {
  const tools = new Map<string, Handler>();
  registerDataSafetyTools(
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

describe("data safety tools", () => {
  let mockFetch: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    mockFetch = vi.fn();
    vi.stubGlobal("fetch", mockFetch);
    vi.mocked(readFile).mockReset();
  });
  afterEach(() => vi.restoreAllMocks());

  it("update_data_safety posts inline csv outside the edits workflow", async () => {
    mockFetch.mockResolvedValueOnce(resp(""));

    const res = await tools.get("update_data_safety")!({ csv: "Question ID,Response\nA,true" });
    expect(mockFetch).toHaveBeenCalledTimes(1);
    const [url, init] = mockFetch.mock.calls[0];
    expect(init.method).toBe("POST");
    expect(new URL(url).pathname).toBe("/androidpublisher/v3/applications/com.acme.app/dataSafety");
    expect(JSON.parse(init.body)).toEqual({ safetyLabels: "Question ID,Response\nA,true" });
    expect(JSON.parse(res.content[0].text!)).toMatchObject({ updated: true });
  });

  it("update_data_safety reads the csv from a file", async () => {
    vi.mocked(readFile).mockResolvedValueOnce("Question ID,Response\nB,false" as any);
    mockFetch.mockResolvedValueOnce(resp({}));

    await tools.get("update_data_safety")!({ file_path: "/tmp/safety.csv" });
    expect(readFile).toHaveBeenCalledWith("/tmp/safety.csv", "utf8");
    expect(JSON.parse(mockFetch.mock.calls[0][1].body)).toEqual({
      safetyLabels: "Question ID,Response\nB,false",
    });
  });

  it("update_data_safety needs exactly one source", async () => {
    for (const args of [{}, { csv: "a", file_path: "/tmp/safety.csv" }]) {
      const res = await tools.get("update_data_safety")!(args);
      expect(res.isError).toBe(true);
      expect(res.content[0].text).toContain("exactly one of file_path or csv");
    }
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("update_data_safety rejects an empty csv", async () => {
    const res = await tools.get("update_data_safety")!({ csv: "  \n" });
    expect(res.isError).toBe(true);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("registers nothing unless both writes and destructive tools are allowed", () => {
    expect([...collect("com.acme.app", false, false).keys()]).toEqual([]);
    expect([...collect("com.acme.app", true, false).keys()]).toEqual([]);
    expect([...collect("com.acme.app", false, true).keys()]).toEqual([]);
    expect([...collect("com.acme.app", true, true).keys()]).toEqual(["update_data_safety"]);
  });
});
