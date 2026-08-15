import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { GooglePlayClient } from "../play/client.js";
import { ok, err, resolvePackage } from "../play/format.js";
import { packageArg } from "./shared.js";

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
  "startType",
  "processName",
  "appState",
] as const;

const METRIC_SETS = [
  "crashRateMetricSet",
  "anrRateMetricSet",
  "errorCountMetricSet",
  "slowStartRateMetricSet",
  "slowRenderingRateMetricSet",
  "excessiveWakeupRateMetricSet",
  "stuckBackgroundWakelockRateMetricSet",
  "lmkRateMetricSet",
  "bitmapMemoryUsageMetricSet",
  "anonRssAndSwapMemoryUsageMetricSet",
] as const;

const DEFAULT_FRESHNESS_SETS = ["crashRateMetricSet", "anrRateMetricSet", "errorCountMetricSet"];

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

const aggregationArg = (dailyOnly: boolean) =>
  dailyOnly
    ? z
        .enum(["DAILY"])
        .optional()
        .describe("Aggregation granularity — this metric set only supports DAILY")
    : z.enum(["DAILY", "HOURLY"]).optional().describe("Aggregation granularity (default: DAILY)");

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
    dailyOnly = false,
  ) => {
    server.tool(
      name,
      description,
      {
        ...metricShape,
        aggregation_period: aggregationArg(dailyOnly),
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

  metricTool(
    "query_slow_start_rate",
    "Query how often the app started slowly: slowStartRate (share of distinct users that had a slow Activity start) plus distinctUsers. Rows are always broken down by startType (COLD/WARM/HOT), which the API requires, since the thresholds differ per start type. Ask for slowStartRate7dUserWeighted or slowStartRate28dUserWeighted in metrics for the user-weighted rolling averages the Play Console shows. Daily aggregation only.",
    "slowStartRateMetricSet",
    ["slowStartRate", "distinctUsers"],
    ["startType"],
    true,
  );

  metricTool(
    "query_slow_rendering_rate",
    "Query the slow rendering rate of a game: slowRenderingRate20Fps and slowRenderingRate30Fps (share of distinct users whose sessions missed the target frame rate on more than 25% of frames) plus distinctUsers. Google only collects this for games — other apps get an error or empty rows. Ask for the *7dUserWeighted / *28dUserWeighted variants in metrics for rolling averages. Daily aggregation only.",
    "slowRenderingRateMetricSet",
    ["slowRenderingRate20Fps", "slowRenderingRate30Fps", "distinctUsers"],
    [],
    true,
  );

  metricTool(
    "query_excessive_wakeup_rate",
    "Query the excessive wakeup rate: excessiveWakeupRate (share of distinct users that had more than 10 AlarmManager wakeups per hour) plus distinctUsers. This is a battery-drain metric and counts users doing background work, not just foreground usage. Ask for excessiveWakeupRate7dUserWeighted or excessiveWakeupRate28dUserWeighted in metrics for rolling averages. Daily aggregation only.",
    "excessiveWakeupRateMetricSet",
    ["excessiveWakeupRate", "distinctUsers"],
    [],
    true,
  );

  metricTool(
    "query_stuck_wakelock_rate",
    "Query the stuck background wakelock rate: stuckBgWakelockRate (share of distinct users that held a PowerManager wakelock in the background for more than one hour) plus distinctUsers. Another battery-drain metric, counted over users doing any work on the device. Ask for stuckBgWakelockRate7dUserWeighted or stuckBgWakelockRate28dUserWeighted in metrics for rolling averages. Daily aggregation only.",
    "stuckBackgroundWakelockRateMetricSet",
    ["stuckBgWakelockRate", "distinctUsers"],
    [],
    true,
  );

  metricTool(
    "query_lmk_rate",
    "Query the low-memory-kill rate: userPerceivedLmkRate (share of distinct users whose app was killed by the system for memory pressure while they were actively using it) plus distinctUsers. Read it next to query_crash_rate and query_anr_rate — an LMK is a stability failure users see as the app disappearing, but it is not reported as a crash. Ask for userPerceivedLmkRate7dUserWeighted or userPerceivedLmkRate28dUserWeighted in metrics for rolling averages. Daily aggregation only.",
    "lmkRateMetricSet",
    ["userPerceivedLmkRate", "distinctUsers"],
    [],
    true,
  );

  metricTool(
    "query_bitmap_memory_usage",
    "Query bitmap memory usage percentiles: bitmapMemoryUsageP50/P90/P99 (bytes) plus distinctUsers. Also supports P75 and P95 via metrics, and the processName and appState dimensions (e.g. FOREGROUND) on top of the usual device dimensions. Pair with query_lmk_rate when investigating memory pressure. Daily aggregation only.",
    "bitmapMemoryUsageMetricSet",
    ["bitmapMemoryUsageP50", "bitmapMemoryUsageP90", "bitmapMemoryUsageP99", "distinctUsers"],
    [],
    true,
  );

  metricTool(
    "query_memory_usage",
    "Query overall app memory usage percentiles (anonymous RSS plus swap, the figure Android vitals reports as memory usage): anonRssAndSwapMemoryUsageP50/P90/P99 in bytes plus distinctUsers. Also supports P75 and P95 via metrics, and the processName and appState dimensions. Use query_bitmap_memory_usage to see how much of it is bitmaps. Daily aggregation only.",
    "anonRssAndSwapMemoryUsageMetricSet",
    [
      "anonRssAndSwapMemoryUsageP50",
      "anonRssAndSwapMemoryUsageP90",
      "anonRssAndSwapMemoryUsageP99",
      "distinctUsers",
    ],
    [],
    true,
  );

  server.tool(
    "list_anomalies",
    "List anomalies Google detected in this app's vitals metrics — datapoints that fall outside the expected range derived from historical data, flagged only when a metric got worse. Each anomaly has name, metricSet (which metric set it was found in), dimensions (the slice it applies to, e.g. a single versionCode or deviceModel), metric (the anomalous value) and timelineSpec (the period it covers). Feed those into the matching query_* tool to pull the full timeline for context. Returns 10 by default, 100 at most; pass page_token from nextPageToken for more. Start here to check whether anything is currently wrong instead of guessing date ranges.",
    {
      package_name: packageArg,
      filter: z
        .string()
        .optional()
        .describe(
          'AIP-160 filter. The one supported function is activeBetween(startTime, endTime) with RFC-3339 timestamps or the literal UNBOUNDED, e.g. activeBetween("2026-08-01T00:00:00Z", UNBOUNDED)',
        ),
      limit: z.number().int().min(1).max(100).optional().describe("Max anomalies (default: 10)"),
      page_token: z.string().optional().describe("nextPageToken from a previous call"),
    },
    async ({ package_name, filter, limit, page_token }) => {
      try {
        const pkg = resolvePackage(package_name, defaultPackageName);
        const res = await client.get<{ anomalies?: unknown[]; nextPageToken?: string }>(
          `/apps/${encodeURIComponent(pkg)}/anomalies`,
          {
            pageSize: limit,
            pageToken: page_token,
            ...(filter ? { filter } : {}),
          },
        );
        return ok({ packageName: pkg, count: (res.anomalies ?? []).length, ...res });
      } catch (e) {
        return err(e);
      }
    },
  );

  server.tool(
    "get_vitals_freshness",
    "Check how fresh Android vitals data is before querying it. Returns each requested metric set with freshnessInfo.freshnesses[], giving the latest end time available per aggregation period (DAILY, HOURLY) — use it to pick an end_date the query_* tools will actually return rows for, since vitals data typically lags about a day. Defaults to the crash, ANR and error count metric sets. A metric set with no data for this app (slowRenderingRateMetricSet is games-only, for example) comes back with an error field instead of freshnessInfo rather than failing the whole call.",
    {
      package_name: packageArg,
      metric_sets: z
        .array(z.enum(METRIC_SETS))
        .optional()
        .describe(`Metric sets to check (default: ${DEFAULT_FRESHNESS_SETS.join(", ")})`),
    },
    async ({ package_name, metric_sets }) => {
      try {
        const pkg = resolvePackage(package_name, defaultPackageName);
        const sets = metric_sets ?? DEFAULT_FRESHNESS_SETS;
        const metricSets = await Promise.all(
          sets.map((set) =>
            client
              .get(`/apps/${encodeURIComponent(pkg)}/${set}`)
              .catch((e) => ({ name: `apps/${pkg}/${set}`, error: String(e) })),
          ),
        );
        return ok({ packageName: pkg, metricSets });
      } catch (e) {
        return err(e);
      }
    },
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
