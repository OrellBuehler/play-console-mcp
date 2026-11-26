import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { GooglePlayClient } from "../play/client.js";
import { registerUserTools } from "../tools/users.js";

type Handler = (args: any) => Promise<{ content: { text?: string }[]; isError?: boolean }>;

function collect(defaultPackage?: string, allowWrites = true, allowDestructive = true) {
  const tools = new Map<string, Handler>();
  registerUserTools(
    {
      tool: (n: string, _d: string, _s: unknown, _a: unknown, h: Handler) => tools.set(n, h),
    } as any,
    new GooglePlayClient(async () => "tok"),
    defaultPackage,
    "123",
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
const USERS = "/androidpublisher/v3/developers/123/users";

function calls(mockFetch: ReturnType<typeof vi.fn>) {
  return mockFetch.mock.calls.map((c) => `${c[1]?.method ?? "GET"} ${new URL(c[0]).pathname}`);
}

function query(mockFetch: ReturnType<typeof vi.fn>, call = 0) {
  return Object.fromEntries(new URL(mockFetch.mock.calls[call][0]).searchParams);
}

function body(mockFetch: ReturnType<typeof vi.fn>, call = 0) {
  return JSON.parse(mockFetch.mock.calls[call][1].body);
}

const DESTRUCTIVE = [
  "create_user",
  "update_user",
  "delete_user",
  "create_grant",
  "update_grant",
  "delete_grant",
];

describe("user tools", () => {
  let mockFetch: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    mockFetch = vi.fn();
    vi.stubGlobal("fetch", mockFetch);
  });
  afterEach(() => vi.restoreAllMocks());

  it("list_users disables pagination", async () => {
    mockFetch.mockResolvedValueOnce(resp({ users: [{ email: "a@acme.com" }] }));
    const res = await tools.get("list_users")!({});
    expect(calls(mockFetch)).toEqual([`GET ${USERS}`]);
    expect(query(mockFetch)).toEqual({ pageSize: "-1" });
    expect(JSON.parse(res.content[0].text!).users[0].email).toBe("a@acme.com");
  });

  it("list_users lets developer_id override the default", async () => {
    mockFetch.mockResolvedValueOnce(resp({}));
    await tools.get("list_users")!({ developer_id: "999" });
    expect(calls(mockFetch)).toEqual(["GET /androidpublisher/v3/developers/999/users"]);
  });

  it("create_user posts the user resource", async () => {
    mockFetch.mockResolvedValueOnce(resp({ email: "a@acme.com" }));
    await tools.get("create_user")!({
      email: "a@acme.com",
      developer_account_permissions: ["CAN_REPLY_TO_REVIEWS_GLOBAL"],
      expiration_time: "2027-01-01T00:00:00Z",
    });
    expect(calls(mockFetch)).toEqual([`POST ${USERS}`]);
    expect(body(mockFetch)).toEqual({
      name: "developers/123/users/a@acme.com",
      email: "a@acme.com",
      developerAccountPermissions: ["CAN_REPLY_TO_REVIEWS_GLOBAL"],
      expirationTime: "2027-01-01T00:00:00Z",
    });
  });

  it("update_user builds the update mask from the fields given", async () => {
    mockFetch.mockResolvedValueOnce(resp({}));
    await tools.get("update_user")!({
      email: "a@acme.com",
      developer_account_permissions: [],
    });
    expect(calls(mockFetch)).toEqual([`PATCH ${USERS}/a%40acme.com`]);
    expect(query(mockFetch)).toEqual({ updateMask: "developerAccountPermissions" });
    expect(body(mockFetch)).toEqual({
      name: "developers/123/users/a@acme.com",
      email: "a@acme.com",
      developerAccountPermissions: [],
    });
  });

  it("update_user rejects a call with nothing to update", async () => {
    const res = await tools.get("update_user")!({ email: "a@acme.com" });
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain("Nothing to update");
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("delete_user sends DELETE", async () => {
    mockFetch.mockResolvedValueOnce(resp(""));
    const res = await tools.get("delete_user")!({ email: "a@acme.com" });
    expect(calls(mockFetch)).toEqual([`DELETE ${USERS}/a%40acme.com`]);
    expect(JSON.parse(res.content[0].text!)).toEqual({
      developerId: "123",
      deletedUser: "a@acme.com",
    });
  });

  it("create_grant posts the grant for the app", async () => {
    mockFetch.mockResolvedValueOnce(resp({}));
    await tools.get("create_grant")!({
      email: "a@acme.com",
      app_level_permissions: ["CAN_REPLY_TO_REVIEWS"],
    });
    expect(calls(mockFetch)).toEqual([`POST ${USERS}/a%40acme.com/grants`]);
    expect(body(mockFetch)).toEqual({
      name: "developers/123/users/a@acme.com/grants/com.acme.app",
      packageName: "com.acme.app",
      appLevelPermissions: ["CAN_REPLY_TO_REVIEWS"],
    });
  });

  it("update_grant patches the app permissions", async () => {
    mockFetch.mockResolvedValueOnce(resp({}));
    await tools.get("update_grant")!({
      email: "a@acme.com",
      app_level_permissions: ["CAN_MANAGE_ORDERS"],
      package_name: "com.other.app",
    });
    expect(calls(mockFetch)).toEqual([`PATCH ${USERS}/a%40acme.com/grants/com.other.app`]);
    expect(query(mockFetch)).toEqual({ updateMask: "appLevelPermissions" });
    expect(body(mockFetch).appLevelPermissions).toEqual(["CAN_MANAGE_ORDERS"]);
  });

  it("delete_grant sends DELETE", async () => {
    mockFetch.mockResolvedValueOnce(resp(""));
    await tools.get("delete_grant")!({ email: "a@acme.com" });
    expect(calls(mockFetch)).toEqual([`DELETE ${USERS}/a%40acme.com/grants/com.acme.app`]);
  });

  it("registers the writes only when writes and destructive tools are both allowed", () => {
    expect([...collect("com.acme.app", false, false).keys()]).toEqual(["list_users"]);
    expect([...collect("com.acme.app", true, false).keys()]).toEqual(["list_users"]);
    expect([...collect("com.acme.app", false, true).keys()]).toEqual(["list_users"]);
    expect([...collect("com.acme.app", true, true).keys()]).toEqual(["list_users", ...DESTRUCTIVE]);
  });

  it("errors when no developer id is available", async () => {
    const bare = new Map<string, Handler>();
    registerUserTools(
      {
        tool: (n: string, _d: string, _s: unknown, _a: unknown, h: Handler) => bare.set(n, h),
      } as any,
      new GooglePlayClient(async () => "tok"),
    );
    const res = await bare.get("list_users")!({});
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain("No developer account ID given");
  });
});
