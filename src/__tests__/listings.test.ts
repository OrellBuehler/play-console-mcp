import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { readFile } from "node:fs/promises";
import { GooglePlayClient } from "../play/client.js";
import { PUBLISHER_UPLOAD_BASE_URL } from "../play/client.js";
import { registerListingTools } from "../tools/listings.js";

vi.mock("node:fs/promises", () => ({ readFile: vi.fn() }));

type Handler = (args: any) => Promise<{ content: { text?: string }[]; isError?: boolean }>;

function collect(defaultPackage?: string, allowWrites = true, allowDestructive = true) {
  const tools = new Map<string, Handler>();
  registerListingTools(
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

describe("listing tools", () => {
  let mockFetch: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    mockFetch = vi.fn();
    vi.stubGlobal("fetch", mockFetch);
  });
  afterEach(() => vi.restoreAllMocks());

  it("list_listings reads listings inside an edit and cleans up", async () => {
    mockFetch
      .mockResolvedValueOnce(resp({ id: "l1" }))
      .mockResolvedValueOnce(resp({ listings: [{ language: "en-US", title: "Acme" }] }))
      .mockResolvedValueOnce(resp(""));

    const res = await tools.get("list_listings")!({});
    expect(calls(mockFetch)).toEqual([
      "POST /androidpublisher/v3/applications/com.acme.app/edits",
      "GET /androidpublisher/v3/applications/com.acme.app/edits/l1/listings",
      "DELETE /androidpublisher/v3/applications/com.acme.app/edits/l1",
    ]);
    expect(JSON.parse(res.content[0].text!).listings[0].title).toBe("Acme");
  });

  it("get_listing reads a single locale", async () => {
    mockFetch
      .mockResolvedValueOnce(resp({ id: "l2" }))
      .mockResolvedValueOnce(resp({ language: "de-DE" }))
      .mockResolvedValueOnce(resp(""));

    await tools.get("get_listing")!({ language: "de-DE" });
    expect(calls(mockFetch)[1]).toBe(
      "GET /androidpublisher/v3/applications/com.acme.app/edits/l2/listings/de-DE",
    );
  });

  it("update_listing patches only the fields that were passed", async () => {
    mockFetch
      .mockResolvedValueOnce(resp({ id: "l3" }))
      .mockResolvedValueOnce(resp({ language: "en-US", title: "Acme" }))
      .mockResolvedValueOnce(resp({}));

    const res = await tools.get("update_listing")!({ language: "en-US", title: "Acme" });
    expect(calls(mockFetch)).toEqual([
      "POST /androidpublisher/v3/applications/com.acme.app/edits",
      "PATCH /androidpublisher/v3/applications/com.acme.app/edits/l3/listings/en-US",
      "POST /androidpublisher/v3/applications/com.acme.app/edits/l3:commit",
    ]);
    expect(JSON.parse(mockFetch.mock.calls[1][1].body)).toEqual({
      language: "en-US",
      title: "Acme",
    });
    expect(JSON.parse(res.content[0].text!).committed).toBe(true);
  });

  const notFound = {
    ok: false,
    status: 404,
    statusText: "Not Found",
    text: () => Promise.resolve("Listing for language 'en-US' not found."),
  };

  it("update_listing creates a missing locale when title and both descriptions are passed", async () => {
    mockFetch
      .mockResolvedValueOnce(resp({ id: "l9" }))
      .mockResolvedValueOnce(notFound)
      .mockResolvedValueOnce(resp({ language: "en-US", title: "Acme" }))
      .mockResolvedValueOnce(resp({}));

    const res = await tools.get("update_listing")!({
      language: "en-US",
      title: "Acme",
      short_description: "Short",
      full_description: "Long",
    });
    expect(calls(mockFetch)).toEqual([
      "POST /androidpublisher/v3/applications/com.acme.app/edits",
      "PATCH /androidpublisher/v3/applications/com.acme.app/edits/l9/listings/en-US",
      "PUT /androidpublisher/v3/applications/com.acme.app/edits/l9/listings/en-US",
      "POST /androidpublisher/v3/applications/com.acme.app/edits/l9:commit",
    ]);
    expect(JSON.parse(mockFetch.mock.calls[2][1].body)).toEqual({
      language: "en-US",
      title: "Acme",
      shortDescription: "Short",
      fullDescription: "Long",
    });
    expect(JSON.parse(res.content[0].text!).listing.language).toBe("en-US");
  });

  it("update_listing names the missing fields when a partial update targets a missing locale", async () => {
    mockFetch
      .mockResolvedValueOnce(resp({ id: "l10" }))
      .mockResolvedValueOnce(notFound)
      .mockResolvedValueOnce(resp(""));

    const res = await tools.get("update_listing")!({ language: "en-US", title: "Acme" });
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain("short_description, full_description");
    expect(calls(mockFetch)).toEqual([
      "POST /androidpublisher/v3/applications/com.acme.app/edits",
      "PATCH /androidpublisher/v3/applications/com.acme.app/edits/l10/listings/en-US",
      "DELETE /androidpublisher/v3/applications/com.acme.app/edits/l10",
    ]);
  });

  it("update_listing validate_only validates and discards instead of committing", async () => {
    mockFetch
      .mockResolvedValueOnce(resp({ id: "l4" }))
      .mockResolvedValueOnce(resp({}))
      .mockResolvedValueOnce(resp({}))
      .mockResolvedValueOnce(resp(""));

    const res = await tools.get("update_listing")!({
      language: "en-US",
      full_description: "Long text",
      validate_only: true,
    });

    const paths = calls(mockFetch);
    expect(paths[2]).toBe("POST /androidpublisher/v3/applications/com.acme.app/edits/l4:validate");
    expect(paths[3]).toBe("DELETE /androidpublisher/v3/applications/com.acme.app/edits/l4");
    expect(paths).not.toContain(
      "POST /androidpublisher/v3/applications/com.acme.app/edits/l4:commit",
    );
    expect(JSON.parse(res.content[0].text!)).toMatchObject({
      committed: false,
      validatedOnly: true,
    });
  });

  it("update_app_details patches the details resource", async () => {
    mockFetch
      .mockResolvedValueOnce(resp({ id: "l5" }))
      .mockResolvedValueOnce(resp({ contactEmail: "hi@acme.com" }))
      .mockResolvedValueOnce(resp({}));

    await tools.get("update_app_details")!({ contact_email: "hi@acme.com" });
    expect(calls(mockFetch)[1]).toBe(
      "PATCH /androidpublisher/v3/applications/com.acme.app/edits/l5/details",
    );
    expect(JSON.parse(mockFetch.mock.calls[1][1].body)).toEqual({ contactEmail: "hi@acme.com" });
  });

  it("get_app_details reads the details resource", async () => {
    mockFetch
      .mockResolvedValueOnce(resp({ id: "l6" }))
      .mockResolvedValueOnce(resp({ defaultLanguage: "en-US" }))
      .mockResolvedValueOnce(resp(""));

    const res = await tools.get("get_app_details")!({});
    expect(calls(mockFetch)[1]).toBe(
      "GET /androidpublisher/v3/applications/com.acme.app/edits/l6/details",
    );
    expect(JSON.parse(res.content[0].text!).defaultLanguage).toBe("en-US");
  });

  it("list_listing_images reads the image type path", async () => {
    mockFetch
      .mockResolvedValueOnce(resp({ id: "l7" }))
      .mockResolvedValueOnce(resp({ images: [{ id: "img-1" }] }))
      .mockResolvedValueOnce(resp(""));

    await tools.get("list_listing_images")!({ language: "en-US", image_type: "phoneScreenshots" });
    expect(calls(mockFetch)[1]).toBe(
      "GET /androidpublisher/v3/applications/com.acme.app/edits/l7/listings/en-US/phoneScreenshots",
    );
  });

  it("upload_listing_image posts the bytes to the upload host and commits", async () => {
    vi.mocked(readFile).mockResolvedValueOnce(Buffer.from([1, 2, 3]) as never);
    mockFetch
      .mockResolvedValueOnce(resp({ id: "l8" }))
      .mockResolvedValueOnce(resp({ image: { id: "img-1" } }))
      .mockResolvedValueOnce(resp({}));

    await tools.get("upload_listing_image")!({
      language: "en-US",
      image_type: "icon",
      file_path: "/tmp/icon.png",
    });

    const [url, options] = mockFetch.mock.calls[1];
    expect(new URL(url).origin + new URL(url).pathname).toBe(
      `${PUBLISHER_UPLOAD_BASE_URL}/applications/com.acme.app/edits/l8/listings/en-US/icon`,
    );
    expect(new URL(url).searchParams.get("uploadType")).toBe("media");
    expect(options.headers["Content-Type"]).toBe("image/png");
    expect(calls(mockFetch)[2]).toBe(
      "POST /androidpublisher/v3/applications/com.acme.app/edits/l8:commit",
    );
  });

  it("upload_listing_image uploads several files in order with one commit", async () => {
    vi.mocked(readFile)
      .mockResolvedValueOnce(Buffer.from([1]) as never)
      .mockResolvedValueOnce(Buffer.from([2]) as never);
    mockFetch
      .mockResolvedValueOnce(resp({ id: "m1" }))
      .mockResolvedValueOnce(resp({ image: { id: "a" } }))
      .mockResolvedValueOnce(resp({ image: { id: "b" } }))
      .mockResolvedValueOnce(resp({}));

    const res = await tools.get("upload_listing_image")!({
      language: "en-US",
      image_type: "phoneScreenshots",
      file_paths: ["/tmp/1.png", "/tmp/2.jpg"],
    });

    expect(calls(mockFetch)).toEqual([
      "POST /androidpublisher/v3/applications/com.acme.app/edits",
      "POST /upload/androidpublisher/v3/applications/com.acme.app/edits/m1/listings/en-US/phoneScreenshots",
      "POST /upload/androidpublisher/v3/applications/com.acme.app/edits/m1/listings/en-US/phoneScreenshots",
      "POST /androidpublisher/v3/applications/com.acme.app/edits/m1:commit",
    ]);
    expect(mockFetch.mock.calls[1][1].headers["Content-Type"]).toBe("image/png");
    expect(mockFetch.mock.calls[2][1].headers["Content-Type"]).toBe("image/jpeg");
    const out = JSON.parse(res.content[0].text!);
    expect(out.committed).toBe(true);
    expect(out.images).toEqual([{ image: { id: "a" } }, { image: { id: "b" } }]);
  });

  it("upload_listing_image replace_existing deletes all images first in the same edit", async () => {
    vi.mocked(readFile)
      .mockResolvedValueOnce(Buffer.from([1]) as never)
      .mockResolvedValueOnce(Buffer.from([2]) as never);
    mockFetch
      .mockResolvedValueOnce(resp({ id: "m2" }))
      .mockResolvedValueOnce(resp(""))
      .mockResolvedValueOnce(resp({ image: { id: "a" } }))
      .mockResolvedValueOnce(resp({ image: { id: "b" } }))
      .mockResolvedValueOnce(resp({}));

    await tools.get("upload_listing_image")!({
      language: "en-US",
      image_type: "phoneScreenshots",
      file_paths: ["/tmp/1.png", "/tmp/2.png"],
      replace_existing: true,
    });

    expect(
      calls(mockFetch).map((c) => c.replace("/androidpublisher/v3/applications/com.acme.app", "")),
    ).toEqual([
      "POST /edits",
      "DELETE /edits/m2/listings/en-US/phoneScreenshots",
      "POST /upload/edits/m2/listings/en-US/phoneScreenshots",
      "POST /upload/edits/m2/listings/en-US/phoneScreenshots",
      "POST /edits/m2:commit",
    ]);
  });

  it("upload_listing_image deletes the edit and names the file when an upload fails", async () => {
    vi.mocked(readFile)
      .mockResolvedValueOnce(Buffer.from([1]) as never)
      .mockResolvedValueOnce(Buffer.from([2]) as never)
      .mockResolvedValueOnce(Buffer.from([3]) as never);
    mockFetch
      .mockResolvedValueOnce(resp({ id: "m3" }))
      .mockResolvedValueOnce(resp({ image: { id: "a" } }))
      .mockResolvedValueOnce({
        ok: false,
        status: 400,
        statusText: "Bad Request",
        text: () => Promise.resolve("bad image"),
        json: () => Promise.resolve({}),
      })
      .mockResolvedValueOnce(resp(""));

    const res = await tools.get("upload_listing_image")!({
      language: "en-US",
      image_type: "phoneScreenshots",
      file_paths: ["/tmp/1.png", "/tmp/2.png", "/tmp/3.png"],
    });

    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain("/tmp/2.png");
    const c = calls(mockFetch);
    expect(c).toHaveLength(4);
    expect(c[3]).toBe("DELETE /androidpublisher/v3/applications/com.acme.app/edits/m3");
    expect(c.some((x) => x.includes(":commit"))).toBe(false);
  });

  it("upload_listing_image requires exactly one of file_path and file_paths", async () => {
    const both = await tools.get("upload_listing_image")!({
      language: "en-US",
      image_type: "phoneScreenshots",
      file_path: "/tmp/1.png",
      file_paths: ["/tmp/2.png"],
    });
    const neither = await tools.get("upload_listing_image")!({
      language: "en-US",
      image_type: "phoneScreenshots",
    });
    for (const res of [both, neither]) {
      expect(res.isError).toBe(true);
      expect(res.content[0].text).toContain("exactly one of file_path or file_paths");
    }
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("upload_listing_image rejects too many files and several files for a singular type", async () => {
    const many = await tools.get("upload_listing_image")!({
      language: "en-US",
      image_type: "phoneScreenshots",
      file_paths: Array.from({ length: 9 }, (_, i) => `/tmp/${i}.png`),
    });
    const singular = await tools.get("upload_listing_image")!({
      language: "en-US",
      image_type: "icon",
      file_paths: ["/tmp/1.png", "/tmp/2.png"],
    });
    expect(many.isError).toBe(true);
    expect(singular.isError).toBe(true);
    expect(singular.content[0].text).toContain("exactly one image");
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("upload_listing_image with file_paths and validate_only validates and discards the edit", async () => {
    vi.mocked(readFile)
      .mockResolvedValueOnce(Buffer.from([1]) as never)
      .mockResolvedValueOnce(Buffer.from([2]) as never);
    mockFetch
      .mockResolvedValueOnce(resp({ id: "m4" }))
      .mockResolvedValueOnce(resp({ image: { id: "a" } }))
      .mockResolvedValueOnce(resp({ image: { id: "b" } }))
      .mockResolvedValueOnce(resp({}))
      .mockResolvedValueOnce(resp(""));

    const res = await tools.get("upload_listing_image")!({
      language: "en-US",
      image_type: "phoneScreenshots",
      file_paths: ["/tmp/1.png", "/tmp/2.png"],
      validate_only: true,
    });

    const c = calls(mockFetch);
    expect(c[3]).toBe("POST /androidpublisher/v3/applications/com.acme.app/edits/m4:validate");
    expect(c[4]).toBe("DELETE /androidpublisher/v3/applications/com.acme.app/edits/m4");
    expect(c.some((x) => x.includes(":commit"))).toBe(false);
    expect(JSON.parse(res.content[0].text!)).toMatchObject({
      committed: false,
      validatedOnly: true,
    });
  });

  it("upload_listing_image rejects unsupported file extensions without opening an edit", async () => {
    const res = await tools.get("upload_listing_image")!({
      language: "en-US",
      image_type: "icon",
      file_path: "/tmp/icon.gif",
    });
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain("Unsupported image type '.gif'");
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("upload_listing_image rejects files over the 15 MB limit", async () => {
    vi.mocked(readFile).mockResolvedValueOnce(Buffer.alloc(15 * 1024 * 1024 + 1) as never);
    const res = await tools.get("upload_listing_image")!({
      language: "en-US",
      image_type: "icon",
      file_path: "/tmp/icon.png",
    });
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain("over the 15 MB limit");
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("delete_listing deletes one locale inside an edit", async () => {
    mockFetch
      .mockResolvedValueOnce(resp({ id: "l9" }))
      .mockResolvedValueOnce(resp(""))
      .mockResolvedValueOnce(resp({}));

    const res = await tools.get("delete_listing")!({ language: "fr-FR" });
    expect(calls(mockFetch)).toEqual([
      "POST /androidpublisher/v3/applications/com.acme.app/edits",
      "DELETE /androidpublisher/v3/applications/com.acme.app/edits/l9/listings/fr-FR",
      "POST /androidpublisher/v3/applications/com.acme.app/edits/l9:commit",
    ]);
    expect(JSON.parse(res.content[0].text!).deletedListing).toBe("fr-FR");
  });

  it("delete_all_listing_images deletes every image of one type", async () => {
    mockFetch
      .mockResolvedValueOnce(resp({ id: "l10" }))
      .mockResolvedValueOnce(resp(""))
      .mockResolvedValueOnce(resp({}));

    await tools.get("delete_all_listing_images")!({
      language: "en-US",
      image_type: "phoneScreenshots",
    });
    expect(calls(mockFetch)[1]).toBe(
      "DELETE /androidpublisher/v3/applications/com.acme.app/edits/l10/listings/en-US/phoneScreenshots",
    );
  });

  it("delete_listing_image deletes a single image by id", async () => {
    mockFetch
      .mockResolvedValueOnce(resp({ id: "l11" }))
      .mockResolvedValueOnce(resp(""))
      .mockResolvedValueOnce(resp({}));

    await tools.get("delete_listing_image")!({
      language: "en-US",
      image_type: "icon",
      image_id: "img-1",
    });
    expect(calls(mockFetch)[1]).toBe(
      "DELETE /androidpublisher/v3/applications/com.acme.app/edits/l11/listings/en-US/icon/img-1",
    );
  });

  it("registers only read tools when writes are not allowed", () => {
    const reads = ["list_listings", "get_listing", "get_app_details", "list_listing_images"];
    expect([...collect("com.acme.app", false, false).keys()]).toEqual(reads);
    expect([...collect("com.acme.app", false, true).keys()]).toEqual(reads);
  });

  it("does not register deletes or uploads when destructive tools are not allowed", () => {
    const guarded = collect("com.acme.app", true, false);
    expect([...guarded.keys()]).toEqual([
      "list_listings",
      "get_listing",
      "get_app_details",
      "list_listing_images",
      "update_listing",
      "update_app_details",
    ]);
  });

  it("registers every tool when writes and destructive tools are allowed", () => {
    expect([...collect("com.acme.app", true, true).keys()]).toEqual([
      "list_listings",
      "get_listing",
      "get_app_details",
      "list_listing_images",
      "update_listing",
      "update_app_details",
      "upload_listing_image",
      "delete_listing",
      "delete_all_listings",
      "delete_listing_image",
      "delete_all_listing_images",
    ]);
  });

  it("errors when no package name is available", async () => {
    const bare = collect();
    const res = await bare.get("list_listings")!({});
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain("No package name given");
    expect(mockFetch).not.toHaveBeenCalled();
  });
});
