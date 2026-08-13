import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { GooglePlayClient } from "../play/client.js";
import { registerRecoveryTools } from "../tools/recovery.js";

type Handler = (args: any) => Promise<{ content: { text?: string }[]; isError?: boolean }>;

function collect(defaultPackage?: string, allowDestructive = true) {
  const tools = new Map<string, Handler>();
  registerRecoveryTools(
    { tool: (n: string, _d: string, _s: unknown, h: Handler) => tools.set(n, h) } as any,
    new GooglePlayClient(async () => "tok"),
    defaultPackage,
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

describe("recovery tools", () => {
  let mockFetch: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    mockFetch = vi.fn();
    vi.stubGlobal("fetch", mockFetch);
  });
  afterEach(() => vi.restoreAllMocks());

  it("list_recovery_actions sends the required versionCode query param", async () => {
    mockFetch.mockResolvedValueOnce(resp({ recoveryActions: [{ appRecoveryId: "r1" }] }));

    const res = await tools.get("list_recovery_actions")!({ version_code: "415" });
    expect(calls(mockFetch)).toEqual([
      "GET /androidpublisher/v3/applications/com.acme.app/appRecoveries",
    ]);
    expect(new URL(mockFetch.mock.calls[0][0]).searchParams.get("versionCode")).toBe("415");
    expect(JSON.parse(res.content[0].text!).recoveryActions[0].appRecoveryId).toBe("r1");
  });

  it("create_recovery_action posts targeting and requests a remote in-app update", async () => {
    mockFetch.mockResolvedValueOnce(resp({ appRecoveryId: "r2" }));

    await tools.get("create_recovery_action")!({ version_codes: ["415"], region_codes: ["CH"] });
    expect(calls(mockFetch)).toEqual([
      "POST /androidpublisher/v3/applications/com.acme.app/appRecoveries",
    ]);
    expect(JSON.parse(mockFetch.mock.calls[0][1].body)).toEqual({
      targeting: {
        regions: { regionCode: ["CH"] },
        versionList: { versionCodes: ["415"] },
      },
      remoteInAppUpdate: { isRemoteInAppUpdateRequested: true },
    });
  });

  it("create_recovery_action supports all_users targeting", async () => {
    mockFetch.mockResolvedValueOnce(resp({}));
    await tools.get("create_recovery_action")!({ all_users: true });
    expect(JSON.parse(mockFetch.mock.calls[0][1].body).targeting).toEqual({
      allUsers: { isAllUsersRequested: true },
    });
  });

  it("create_recovery_action errors when no targeting is given", async () => {
    const res = await tools.get("create_recovery_action")!({});
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain("No targeting given");
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("deploy_recovery_action posts to the :deploy verb", async () => {
    mockFetch.mockResolvedValueOnce(resp({}));
    await tools.get("deploy_recovery_action")!({ recovery_id: "r3" });
    expect(calls(mockFetch)).toEqual([
      "POST /androidpublisher/v3/applications/com.acme.app/appRecoveries/r3:deploy",
    ]);
  });

  it("cancel_recovery_action posts to the :cancel verb", async () => {
    mockFetch.mockResolvedValueOnce(resp({}));
    await tools.get("cancel_recovery_action")!({ recovery_id: "r4" });
    expect(calls(mockFetch)).toEqual([
      "POST /androidpublisher/v3/applications/com.acme.app/appRecoveries/r4:cancel",
    ]);
  });

  it("add_recovery_targeting posts a targetingUpdate to the :addTargeting verb", async () => {
    mockFetch.mockResolvedValueOnce(resp({}));
    await tools.get("add_recovery_targeting")!({ recovery_id: "r5", sdk_levels: ["33", "34"] });
    expect(calls(mockFetch)).toEqual([
      "POST /androidpublisher/v3/applications/com.acme.app/appRecoveries/r5:addTargeting",
    ]);
    expect(JSON.parse(mockFetch.mock.calls[0][1].body)).toEqual({
      targetingUpdate: { androidSdks: { sdkLevels: ["33", "34"] } },
    });
  });

  it("registers only the read tool when destructive tools are not allowed", () => {
    const guarded = collect("com.acme.app", false);
    expect([...guarded.keys()]).toEqual(["list_recovery_actions"]);
  });

  it("errors when no package name is available", async () => {
    const bare = collect();
    const res = await bare.get("list_recovery_actions")!({ version_code: "415" });
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain("No package name given");
    expect(mockFetch).not.toHaveBeenCalled();
  });
});
