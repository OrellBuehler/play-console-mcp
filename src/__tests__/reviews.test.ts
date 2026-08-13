import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { GooglePlayClient } from "../play/client.js";
import { registerReviewTools } from "../tools/reviews.js";

type Handler = (args: any) => Promise<{ content: { text?: string }[]; isError?: boolean }>;

function collect(defaultPackage?: string) {
  const tools = new Map<string, Handler>();
  const schemas = new Map<string, any>();
  registerReviewTools(
    {
      tool: (n: string, _d: string, s: any, h: Handler) => {
        tools.set(n, h);
        schemas.set(n, s);
      },
    } as any,
    new GooglePlayClient(async () => "tok"),
    defaultPackage,
  );
  return { tools, schemas };
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

const { tools, schemas } = collect("com.acme.app");

describe("review tools", () => {
  let mockFetch: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    mockFetch = vi.fn();
    vi.stubGlobal("fetch", mockFetch);
  });
  afterEach(() => vi.restoreAllMocks());

  it("list_reviews hits the reviews endpoint with a page size", async () => {
    mockFetch.mockResolvedValueOnce(
      resp({
        reviews: [
          {
            reviewId: "r1",
            authorName: "Ada",
            comments: [{ userComment: { text: "Great app", starRating: 5 } }],
          },
        ],
      }),
    );

    const res = await tools.get("list_reviews")!({});
    const url = new URL(mockFetch.mock.calls[0][0]);
    expect(url.pathname).toBe("/androidpublisher/v3/applications/com.acme.app/reviews");
    expect(url.searchParams.get("maxResults")).toBe("50");

    const payload = JSON.parse(res.content[0].text!);
    expect(payload.count).toBe(1);
    expect(payload.reviews[0].comments[0].userComment.starRating).toBe(5);
  });

  it("list_reviews follows nextPageToken until the limit is reached", async () => {
    mockFetch
      .mockResolvedValueOnce(
        resp({
          reviews: [{ reviewId: "r1" }, { reviewId: "r2" }],
          tokenPagination: { nextPageToken: "page2" },
        }),
      )
      .mockResolvedValueOnce(resp({ reviews: [{ reviewId: "r3" }] }));

    const res = await tools.get("list_reviews")!({ limit: 3 });
    expect(mockFetch).toHaveBeenCalledTimes(2);
    expect(new URL(mockFetch.mock.calls[1][0]).searchParams.get("token")).toBe("page2");
    expect(JSON.parse(res.content[0].text!).count).toBe(3);
  });

  it("list_reviews passes the translation language and package override", async () => {
    mockFetch.mockResolvedValueOnce(resp({ reviews: [] }));
    await tools.get("list_reviews")!({
      package_name: "com.other.app",
      translation_language: "en",
    });
    const url = new URL(mockFetch.mock.calls[0][0]);
    expect(url.pathname).toBe("/androidpublisher/v3/applications/com.other.app/reviews");
    expect(url.searchParams.get("translationLanguage")).toBe("en");
  });

  it("get_review fetches one review by id", async () => {
    mockFetch.mockResolvedValueOnce(resp({ reviewId: "r1" }));
    await tools.get("get_review")!({ review_id: "r1" });
    expect(new URL(mockFetch.mock.calls[0][0]).pathname).toBe(
      "/androidpublisher/v3/applications/com.acme.app/reviews/r1",
    );
  });

  it("reply_to_review posts the reply text to the :reply endpoint", async () => {
    mockFetch.mockResolvedValueOnce(resp({ result: { replyText: "Thanks!" } }));
    const res = await tools.get("reply_to_review")!({ review_id: "r1", reply_text: "Thanks!" });

    const [url, options] = mockFetch.mock.calls[0];
    expect(new URL(url).pathname).toBe(
      "/androidpublisher/v3/applications/com.acme.app/reviews/r1:reply",
    );
    expect(options.method).toBe("POST");
    expect(JSON.parse(options.body)).toEqual({ replyText: "Thanks!" });
    expect(JSON.parse(res.content[0].text!).result.replyText).toBe("Thanks!");
  });

  it("reply_to_review caps the reply at 350 characters", () => {
    const schema = schemas.get("reply_to_review")!;
    expect(schema.reply_text.safeParse("x".repeat(350)).success).toBe(true);
    expect(schema.reply_text.safeParse("x".repeat(351)).success).toBe(false);
    expect(schema.reply_text.safeParse("").success).toBe(false);
  });

  it("errors when no package name is available", async () => {
    const bare = collect();
    const res = await bare.tools.get("list_reviews")!({});
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain("No package name given");
  });
});
