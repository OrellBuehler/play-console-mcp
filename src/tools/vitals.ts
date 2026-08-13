import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { GooglePlayClient } from "../play/client.js";
import { ok, err, resolvePackage } from "../play/format.js";

interface DateParts {
  year: number;
  month: number;
  day: number;
}

interface MetricsQueryResponse {
  rows?: unknown[];
  nextPageToken?: string;
}

const DIMENSIONS = [
  "apiLevel",
  "versionCode",
  "countryCode",
  "reportType",
  "issueId",
  "isUserPerceived",
  "deviceModel",
  "deviceBrand",
  "deviceType",
  "deviceRamBucket",
  "deviceSocMake",
  "deviceSocModel",
  "deviceCpuMake",
  "deviceCpuModel",
  "deviceGpuMake",
  "deviceGpuModel",
  "deviceGpuVersion",
  "deviceVulkanVersion",
  "deviceGlEsVersion",
  "deviceScreenSize",
  "deviceScreenDpi",
] as const;

export function parseDate(value: string): DateParts {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!m) throw new Error(`Invalid date '${value}', expected YYYY-MM-DD`);
  return { year: Number(m[1]), month: Number(m[2]), day: Number(m[3]) };
}

function timeZoneFor(aggregationPeriod: string): string {
  return aggregationPeriod === "HOURLY" ? "UTC" : "America/Los_Angeles";
}

// The :query metric endpoints accept America/Los_Angeles in timelineSpec, but the :search
// endpoints reject it with "Unsupported timezone" and only accept UTC (or no timeZone at all).
// Do not unify this with timeZoneFor above.
const SEARCH_TIME_ZONE = "UTC";

const metricShape = {
  package_name: z
    .string()
    .optional()
    .describe("App package name, e.g. 'com.acme.app' (defaults to GOOGLE_PLAY_PACKAGE_NAME)"),
  start_date: z.string().describe("Start date (inclusive) as YYYY-MM-DD, e.g. '2026-08-01'"),
  end_date: z.string().describe("End date (inclusive) as YYYY-MM-DD, e.g. '2026-08-13'"),
  aggregation_period: z
    .enum(["DAILY", "HOURLY"])
    .optional()
    .describe("Aggregation granularity (default: DAILY)"),
  dimensions: z
    .array(z.enum(DIMENSIONS))
    .optional()
    .describe("Break the metrics down by these dimensions, e.g. ['versionCode','deviceModel']"),
  filter: z
    .string()
    .optional()
    .describe('AIP-160 filter over dimensions, e.g. "versionCode = 415"'),
  limit: z.number().int().min(1).max(1000).optional().describe("Max rows to return (default: 50)"),
};

const searchShape = {
  package_name: z
    .string()
    .optional()
    .describe("App package name, e.g. 'com.acme.app' (defaults to GOOGLE_PLAY_PACKAGE_NAME)"),
  start_date: z.string().describe("Start date (inclusive) as YYYY-MM-DD"),
  end_date: z.string().describe("End date (inclusive) as YYYY-MM-DD"),
  filter: z.string().optional().describe('AIP-160 filter, e.g. "errorReportType = CRASH"'),
  limit: z.number().int().min(1).max(1000).optional().describe("Max results (default: 25)"),
};

function intervalParams(startDate: string, endDate: string) {
  const start = parseDate(startDate);
  const end = parseDate(endDate);
  return {
    "interval.startTime.year": start.year,
    "interval.startTime.month": start.month,
    "interval.startTime.day": start.day,
    "interval.startTime.timeZone.id": SEARCH_TIME_ZONE,
    "interval.endTime.year": end.year,
    "interval.endTime.month": end.month,
    "interval.endTime.day": end.day,
    "interval.endTime.timeZone.id": SEARCH_TIME_ZONE,
  };
}

export function registerVitalsTools(
  server: McpServer,
  client: GooglePlayClient,
  defaultPackageName?: string,
) {
  const metricTool = (
    name: string,
    description: string,
    metricSet: string,
    defaultMetrics: string[],
    extraDimensions: string[] = [],
  ) => {
    server.tool(
      name,
      description,
      {
        ...metricShape,
        metrics: z
          .array(z.string())
          .optional()
          .describe(`Metrics to fetch (default: ${defaultMetrics.join(", ")})`),
      },
      async ({
        package_name,
        start_date,
        end_date,
        aggregation_period,
        dimensions,
        metrics,
        filter,
        limit,
      }) => {
        try {
          const pkg = resolvePackage(package_name, defaultPackageName);
          const period = aggregation_period ?? "DAILY";
          const body = {
            timelineSpec: {
              aggregationPeriod: period,
              startTime: { ...parseDate(start_date), timeZone: { id: timeZoneFor(period) } },
              endTime: { ...parseDate(end_date), timeZone: { id: timeZoneFor(period) } },
            },
            dimensions: [...new Set([...(dimensions ?? []), ...extraDimensions])],
            metrics: metrics ?? defaultMetrics,
            pageSize: limit ?? 50,
            ...(filter ? { filter } : {}),
          };
          const res = await client.post<MetricsQueryResponse>(
            `/apps/${encodeURIComponent(pkg)}/${metricSet}:query`,
            body,
          );
          return ok({ packageName: pkg, count: (res.rows ?? []).length, ...res });
        } catch (e) {
          return err(e);
        }
      },
    );
  };

  metricTool(
    "query_crash_rate",
    "Query the crash rate of an app over time from Android vitals: crashRate (share of distinct users who experienced a crash) and userPerceivedCrashRate (crashes while the user was interacting). Optionally break down by version code, device model, country and more. Data is aggregated daily in America/Los_Angeles, lags about one day, and slices with too few users are omitted by Google.",
    "crashRateMetricSet",
    ["crashRate", "userPerceivedCrashRate", "distinctUsers"],
  );

  metricTool(
    "query_anr_rate",
    "Query the ANR (Application Not Responding) rate of an app over time from Android vitals: anrRate and userPerceivedAnrRate. Optionally break down by version code, device model, country and more. Data is aggregated daily in America/Los_Angeles and lags about one day.",
    "anrRateMetricSet",
    ["anrRate", "userPerceivedAnrRate", "distinctUsers"],
  );

  metricTool(
    "query_error_counts",
    "Query absolute counts of error reports (crashes and ANRs) over time: errorReportCount and distinctUsers. Rows are always broken down by reportType (CRASH/ANR/NON_FATAL), which the API requires; add issueId to see which issues drive the volume, then use search_error_issues for details.",
    "errorCountMetricSet",
    ["errorReportCount", "distinctUsers"],
    ["reportType"],
  );

  server.tool(
    "search_error_issues",
    "Search grouped crash/ANR issues for an app (deduplicated stack traces). Each issue has a name containing its issue ID, type (CRASH/ANR), cause, location, errorReportCount, distinctUsers, affected versions, and an issueUri linking to the Play Console. Use the issue name with search_error_reports to read individual stack traces.",
    {
      ...searchShape,
      order_by: z
        .string()
        .optional()
        .describe("Sort order, e.g. 'errorReportCount desc' or 'distinctUsers desc'"),
    },
    async ({ package_name, start_date, end_date, filter, order_by, limit }) => {
      try {
        const pkg = resolvePackage(package_name, defaultPackageName);
        const res = await client.get<{ errorIssues?: unknown[]; nextPageToken?: string }>(
          `/apps/${encodeURIComponent(pkg)}/errorIssues:search`,
          {
            ...intervalParams(start_date, end_date),
            pageSize: limit ?? 25,
            ...(filter ? { filter } : {}),
            ...(order_by ? { orderBy: order_by } : {}),
          },
        );
        return ok({ packageName: pkg, count: (res.errorIssues ?? []).length, ...res });
      } catch (e) {
        return err(e);
      }
    },
  );

  server.tool(
    "search_error_reports",
    "Search individual crash/ANR error reports for an app, including reportText with the raw stack trace, device info and app version. Filter to one issue with a filter like \"issue = 'apps/com.acme.app/errorIssues/<id>'\" using an issue name from search_error_issues.",
    searchShape,
    async ({ package_name, start_date, end_date, filter, limit }) => {
      try {
        const pkg = resolvePackage(package_name, defaultPackageName);
        const res = await client.get<{ errorReports?: unknown[]; nextPageToken?: string }>(
          `/apps/${encodeURIComponent(pkg)}/errorReports:search`,
          {
            ...intervalParams(start_date, end_date),
            pageSize: limit ?? 25,
            ...(filter ? { filter } : {}),
          },
        );
        return ok({ packageName: pkg, count: (res.errorReports ?? []).length, ...res });
      } catch (e) {
        return err(e);
      }
    },
  );
}
