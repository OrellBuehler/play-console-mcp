import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { GooglePlayClient, REPORTING_BASE_URL } from "../play/client.js";
import { registerVitalsTools, parseDate } from "../tools/vitals.js";

type Handler = (args: any) => Promise<{ content: { text?: string }[]; isError?: boolean }>;

function collect(defaultPackage?: string) {
  const tools = new Map<string, Handler>();
  registerVitalsTools(
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
const range = { start_date: "2026-08-01", end_date: "2026-08-13" };

describe("vitals tools", () => {
  let mockFetch: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    mockFetch = vi.fn();
    vi.stubGlobal("fetch", mockFetch);
  });
  afterEach(() => vi.restoreAllMocks());

  it("parseDate splits an ISO date and rejects other formats", () => {
    expect(parseDate("2026-08-01")).toEqual({ year: 2026, month: 8, day: 1 });
    expect(() => parseDate("01.08.2026")).toThrow("expected YYYY-MM-DD");
  });

  it("query_crash_rate posts a timeline spec with default metrics", async () => {
    mockFetch.mockResolvedValueOnce(resp({ rows: [{ startTime: {} }] }));
    const res = await tools.get("query_crash_rate")!({ ...range });

    const [url, options] = mockFetch.mock.calls[0];
    expect(url).toBe(`${REPORTING_BASE_URL}/apps/com.acme.app/crashRateMetricSet:query`);
    const body = JSON.parse(options.body);
    expect(body.timelineSpec).toEqual({
      aggregationPeriod: "DAILY",
      startTime: { year: 2026, month: 8, day: 1, timeZone: { id: "America/Los_Angeles" } },
      endTime: { year: 2026, month: 8, day: 13, timeZone: { id: "America/Los_Angeles" } },
    });
    expect(body.metrics).toEqual(["crashRate", "userPerceivedCrashRate", "distinctUsers"]);
    expect(body.pageSize).toBe(50);
    expect(JSON.parse(res.content[0].text!).count).toBe(1);
  });

  it("uses UTC for hourly aggregation and passes dimensions, filter and limit", async () => {
    mockFetch.mockResolvedValueOnce(resp({ rows: [] }));
    await tools.get("query_crash_rate")!({
      ...range,
      aggregation_period: "HOURLY",
      dimensions: ["versionCode"],
      filter: "versionCode = 415",
      limit: 200,
    });

    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.timelineSpec.aggregationPeriod).toBe("HOURLY");
    expect(body.timelineSpec.startTime.timeZone).toEqual({ id: "UTC" });
    expect(body.dimensions).toEqual(["versionCode"]);
    expect(body.filter).toBe("versionCode = 415");
    expect(body.pageSize).toBe(200);
  });

  it("query_anr_rate targets the ANR metric set", async () => {
    mockFetch.mockResolvedValueOnce(resp({ rows: [] }));
    await tools.get("query_anr_rate")!({ ...range });
    expect(mockFetch.mock.calls[0][0]).toContain("/anrRateMetricSet:query");
    expect(JSON.parse(mockFetch.mock.calls[0][1].body).metrics).toEqual([
      "anrRate",
      "userPerceivedAnrRate",
      "distinctUsers",
    ]);
  });

  it("query_error_counts targets the error count metric set", async () => {
    mockFetch.mockResolvedValueOnce(resp({ rows: [] }));
    await tools.get("query_error_counts")!({ ...range, metrics: ["errorReportCount"] });
    expect(mockFetch.mock.calls[0][0]).toContain("/errorCountMetricSet:query");
    expect(JSON.parse(mockFetch.mock.calls[0][1].body).metrics).toEqual(["errorReportCount"]);
  });

  it("query_error_counts always sends the required reportType dimension", async () => {
    mockFetch.mockResolvedValueOnce(resp({ rows: [] }));
    await tools.get("query_error_counts")!({ ...range });
    expect(JSON.parse(mockFetch.mock.calls[0][1].body).dimensions).toEqual(["reportType"]);

    mockFetch.mockResolvedValueOnce(resp({ rows: [] }));
    await tools.get("query_error_counts")!({ ...range, dimensions: ["versionCode"] });
    expect(JSON.parse(mockFetch.mock.calls[1][1].body).dimensions).toEqual([
      "versionCode",
      "reportType",
    ]);
  });

  it("query_error_counts does not duplicate reportType when the caller passes it", async () => {
    mockFetch.mockResolvedValueOnce(resp({ rows: [] }));
    await tools.get("query_error_counts")!({ ...range, dimensions: ["reportType", "issueId"] });
    expect(JSON.parse(mockFetch.mock.calls[0][1].body).dimensions).toEqual([
      "reportType",
      "issueId",
    ]);
  });

  it("search_error_issues flattens the interval into query params", async () => {
    mockFetch.mockResolvedValueOnce(resp({ errorIssues: [{ name: "i1" }] }));
    const res = await tools.get("search_error_issues")!({
      ...range,
      filter: "errorReportType = CRASH",
      order_by: "errorReportCount desc",
      limit: 10,
    });

    const url = new URL(mockFetch.mock.calls[0][0]);
    expect(url.pathname).toBe("/v1beta1/apps/com.acme.app/errorIssues:search");
    expect(url.searchParams.get("interval.startTime.year")).toBe("2026");
    expect(url.searchParams.get("interval.startTime.month")).toBe("8");
    expect(url.searchParams.get("interval.startTime.day")).toBe("1");
    expect(url.searchParams.get("interval.endTime.day")).toBe("13");
    expect(url.searchParams.get("filter")).toBe("errorReportType = CRASH");
    expect(url.searchParams.get("orderBy")).toBe("errorReportCount desc");
    expect(url.searchParams.get("pageSize")).toBe("10");
    expect(JSON.parse(res.content[0].text!).count).toBe(1);
  });

  it("search endpoints send UTC, while metric endpoints send America/Los_Angeles", async () => {
    mockFetch.mockResolvedValueOnce(resp({ errorIssues: [] }));
    await tools.get("search_error_issues")!({ ...range });
    const search = new URL(mockFetch.mock.calls[0][0]).searchParams;
    expect(search.get("interval.startTime.timeZone.id")).toBe("UTC");
    expect(search.get("interval.endTime.timeZone.id")).toBe("UTC");

    mockFetch.mockResolvedValueOnce(resp({ errorReports: [] }));
    await tools.get("search_error_reports")!({ ...range });
    expect(
      new URL(mockFetch.mock.calls[1][0]).searchParams.get("interval.startTime.timeZone.id"),
    ).toBe("UTC");

    mockFetch.mockResolvedValueOnce(resp({ rows: [] }));
    await tools.get("query_crash_rate")!({ ...range });
    expect(JSON.parse(mockFetch.mock.calls[2][1].body).timelineSpec.startTime.timeZone).toEqual({
      id: "America/Los_Angeles",
    });
  });

  it("search_error_reports searches individual reports", async () => {
    mockFetch.mockResolvedValueOnce(resp({ errorReports: [] }));
    await tools.get("search_error_reports")!({
      ...range,
      filter: "issue = 'apps/com.acme.app/errorIssues/abc'",
    });
    const url = new URL(mockFetch.mock.calls[0][0]);
    expect(url.pathname).toBe("/v1beta1/apps/com.acme.app/errorReports:search");
    expect(url.searchParams.get("filter")).toBe("issue = 'apps/com.acme.app/errorIssues/abc'");
  });

  it("surfaces invalid dates as tool errors", async () => {
    const res = await tools.get("query_crash_rate")!({
      start_date: "yesterday",
      end_date: "2026-08-13",
    });
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain("expected YYYY-MM-DD");
  });

  it("errors when no package name is available", async () => {
    const bare = collect();
    const res = await bare.get("query_crash_rate")!({ ...range });
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain("No package name given");
  });
});
