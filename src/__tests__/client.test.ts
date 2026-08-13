import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  GooglePlayClient,
  PUBLISHER_BASE_URL,
  PUBLISHER_UPLOAD_BASE_URL,
  REPORTING_BASE_URL,
} from "../play/client.js";

function resp(body: unknown, init: { status?: number; statusText?: string } = {}) {
  const text = typeof body === "string" ? body : JSON.stringify(body);
  return {
    ok: (init.status ?? 200) < 400,
    status: init.status ?? 200,
    statusText: init.statusText ?? "OK",
    text: () => Promise.resolve(text),
    json: () => Promise.resolve(JSON.parse(text)),
  };
}

describe("GooglePlayClient", () => {
  let mockFetch: ReturnType<typeof vi.fn>;
  const client = new GooglePlayClient(async () => "tok");

  beforeEach(() => {
    mockFetch = vi.fn();
    vi.stubGlobal("fetch", mockFetch);
  });
  afterEach(() => vi.restoreAllMocks());

  it("prefixes the publisher base url and sends the bearer token", async () => {
    mockFetch.mockResolvedValueOnce(resp({ tracks: [] }));
    await client.get("/applications/com.acme.app/edits/1/tracks");

    const [url, options] = mockFetch.mock.calls[0];
    expect(url).toBe(`${PUBLISHER_BASE_URL}/applications/com.acme.app/edits/1/tracks`);
    expect(options.headers.Authorization).toBe("Bearer tok");
    expect(options.headers.Accept).toBe("application/json");
  });

  it("uses the reporting base url for a reporting client", async () => {
    const reporting = new GooglePlayClient(async () => "tok", REPORTING_BASE_URL);
    mockFetch.mockResolvedValueOnce(resp({ rows: [] }));
    await reporting.post("/apps/com.acme.app/crashRateMetricSet:query", {});
    expect(mockFetch.mock.calls[0][0]).toBe(
      `${REPORTING_BASE_URL}/apps/com.acme.app/crashRateMetricSet:query`,
    );
  });

  it("skips undefined params, joins arrays and stringifies the rest", async () => {
    mockFetch.mockResolvedValueOnce(resp({}));
    await client.get("/x", { a: undefined, b: ["p", "q"], c: 5, d: true, e: [] });

    const params = new URL(mockFetch.mock.calls[0][0]).searchParams;
    expect(params.has("a")).toBe(false);
    expect(params.get("b")).toBe("p,q");
    expect(params.get("c")).toBe("5");
    expect(params.get("d")).toBe("true");
    expect(params.has("e")).toBe(false);
  });

  it("posts a JSON body with a content-type and supports query params", async () => {
    mockFetch.mockResolvedValueOnce(resp({}));
    await client.post("/edits/1:commit", undefined, { changesNotSentForReview: true });

    const [url, options] = mockFetch.mock.calls[0];
    expect(new URL(url).searchParams.get("changesNotSentForReview")).toBe("true");
    expect(options.method).toBe("POST");
    expect(options.body).toBeUndefined();

    mockFetch.mockResolvedValueOnce(resp({}));
    await client.post("/edits", { a: 1 });
    const second = mockFetch.mock.calls[1][1];
    expect(second.body).toBe('{"a":1}');
    expect(second.headers["Content-Type"]).toBe("application/json");
  });

  it("put sends the body and returns the parsed response", async () => {
    mockFetch.mockResolvedValueOnce(resp({ track: "production" }));
    const res = await client.put<{ track: string }>("/tracks/production", { track: "production" });
    expect(mockFetch.mock.calls[0][1].method).toBe("PUT");
    expect(res.track).toBe("production");
  });

  it("patch sends the body and returns the parsed response", async () => {
    mockFetch.mockResolvedValueOnce(resp({ title: "Acme" }));
    const res = await client.patch<{ title: string }>("/listings/en-US", { title: "Acme" });
    const options = mockFetch.mock.calls[0][1];
    expect(options.method).toBe("PATCH");
    expect(options.body).toBe('{"title":"Acme"}');
    expect(res.title).toBe("Acme");
  });

  it("upload posts bytes to the upload host with uploadType=media and the given content type", async () => {
    mockFetch.mockResolvedValueOnce(resp({ image: { id: "img-1" } }));
    const bytes = new Uint8Array([1, 2, 3]);
    await client.upload(
      "/applications/com.acme.app/edits/1/listings/en-US/icon",
      bytes,
      "image/png",
    );

    const [url, options] = mockFetch.mock.calls[0];
    expect(new URL(url).origin + new URL(url).pathname).toBe(
      `${PUBLISHER_UPLOAD_BASE_URL}/applications/com.acme.app/edits/1/listings/en-US/icon`,
    );
    expect(new URL(url).searchParams.get("uploadType")).toBe("media");
    expect(options.method).toBe("POST");
    expect(options.body).toBe(bytes);
    expect(options.headers["Content-Type"]).toBe("image/png");
  });

  it("tolerates an empty response body", async () => {
    mockFetch.mockResolvedValueOnce(resp(""));
    expect(await client.post("/edits/1:validate")).toEqual({});
  });

  it("del issues a DELETE and ignores the body", async () => {
    mockFetch.mockResolvedValueOnce(resp(""));
    await client.del("/applications/com.acme.app/edits/1");
    expect(mockFetch.mock.calls[0][1].method).toBe("DELETE");
  });

  it("throws with status, status text and body on non-2xx", async () => {
    mockFetch.mockResolvedValueOnce(
      resp("The caller does not have permission", { status: 403, statusText: "Forbidden" }),
    );
    await expect(client.get("/x")).rejects.toThrow(
      "403 Forbidden: The caller does not have permission",
    );
  });

  it("rewraps fetch timeouts with a friendly message", async () => {
    mockFetch.mockRejectedValueOnce(new DOMException("timed out", "TimeoutError"));
    await expect(client.get("/x")).rejects.toThrow("Google Play request timed out after 30000ms");
  });
});
