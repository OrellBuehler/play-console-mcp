import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { GooglePlayClient } from "../play/client.js";
import { registerReleaseTools } from "../tools/releases.js";

type Handler = (args: any) => Promise<{ content: { text?: string }[]; isError?: boolean }>;

function collect(defaultPackage?: string) {
  const tools = new Map<string, Handler>();
  registerReleaseTools(
    { tool: (n: string, _d: string, _s: unknown, h: Handler) => tools.set(n, h) } as any,
    new GooglePlayClient(async () => "tok"),
    defaultPackage,
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

describe("release tools", () => {
  let mockFetch: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    mockFetch = vi.fn();
    vi.stubGlobal("fetch", mockFetch);
  });
  afterEach(() => vi.restoreAllMocks());

  it("list_tracks opens an edit, reads tracks and cleans the edit up", async () => {
    mockFetch
      .mockResolvedValueOnce(resp({ id: "edit-1" }))
      .mockResolvedValueOnce(resp({ tracks: [{ track: "production", releases: [] }] }))
      .mockResolvedValueOnce(resp(""));

    const res = await tools.get("list_tracks")!({});
    expect(calls(mockFetch)).toEqual([
      "POST /androidpublisher/v3/applications/com.acme.app/edits",
      "GET /androidpublisher/v3/applications/com.acme.app/edits/edit-1/tracks",
      "DELETE /androidpublisher/v3/applications/com.acme.app/edits/edit-1",
    ]);
    const payload = JSON.parse(res.content[0].text!);
    expect(payload.count).toBe(1);
    expect(payload.tracks[0].track).toBe("production");
  });

  it("get_track reads a single track inside an edit", async () => {
    mockFetch
      .mockResolvedValueOnce(resp({ id: "e2" }))
      .mockResolvedValueOnce(resp({ track: "beta", releases: [] }))
      .mockResolvedValueOnce(resp(""));

    await tools.get("get_track")!({ track: "beta" });
    expect(calls(mockFetch)[1]).toBe(
      "GET /androidpublisher/v3/applications/com.acme.app/edits/e2/tracks/beta",
    );
  });

  it("promote_release copies version codes and commits a full rollout", async () => {
    mockFetch
      .mockResolvedValueOnce(resp({ id: "e3" }))
      .mockResolvedValueOnce(
        resp({
          track: "beta",
          releases: [
            {
              name: "1.4.0",
              versionCodes: ["415"],
              status: "completed",
              releaseNotes: [{ language: "en-US", text: "Fixes" }],
            },
          ],
        }),
      )
      .mockResolvedValueOnce(resp({ track: "production" }))
      .mockResolvedValueOnce(resp(""));

    const res = await tools.get("promote_release")!({
      from_track: "beta",
      to_track: "production",
    });

    expect(calls(mockFetch)).toEqual([
      "POST /androidpublisher/v3/applications/com.acme.app/edits",
      "GET /androidpublisher/v3/applications/com.acme.app/edits/e3/tracks/beta",
      "PUT /androidpublisher/v3/applications/com.acme.app/edits/e3/tracks/production",
      "POST /androidpublisher/v3/applications/com.acme.app/edits/e3:commit",
    ]);
    const body = JSON.parse(mockFetch.mock.calls[2][1].body);
    expect(body).toEqual({
      track: "production",
      releases: [
        {
          name: "1.4.0",
          versionCodes: ["415"],
          releaseNotes: [{ language: "en-US", text: "Fixes" }],
          status: "completed",
        },
      ],
    });
    expect(JSON.parse(res.content[0].text!).committed).toBe(true);
  });

  it("promote_release with user_fraction creates a staged rollout", async () => {
    mockFetch
      .mockResolvedValueOnce(resp({ id: "e4" }))
      .mockResolvedValueOnce(
        resp({
          track: "beta",
          releases: [{ name: "1.5", versionCodes: ["9"], status: "completed" }],
        }),
      )
      .mockResolvedValueOnce(resp({}))
      .mockResolvedValueOnce(resp(""));

    await tools.get("promote_release")!({
      from_track: "beta",
      to_track: "production",
      user_fraction: 0.1,
    });

    const body = JSON.parse(mockFetch.mock.calls[2][1].body);
    expect(body.releases[0]).toMatchObject({ status: "inProgress", userFraction: 0.1 });
  });

  it("promote_release validate_only validates and discards instead of committing", async () => {
    mockFetch
      .mockResolvedValueOnce(resp({ id: "e5" }))
      .mockResolvedValueOnce(
        resp({
          track: "beta",
          releases: [{ name: "1", versionCodes: ["1"], status: "completed" }],
        }),
      )
      .mockResolvedValueOnce(resp({}))
      .mockResolvedValueOnce(resp({}))
      .mockResolvedValueOnce(resp(""));

    const res = await tools.get("promote_release")!({
      from_track: "beta",
      to_track: "production",
      validate_only: true,
    });

    const paths = calls(mockFetch);
    expect(paths[3]).toBe("POST /androidpublisher/v3/applications/com.acme.app/edits/e5:validate");
    expect(paths[4]).toBe("DELETE /androidpublisher/v3/applications/com.acme.app/edits/e5");
    expect(paths).not.toContain(
      "POST /androidpublisher/v3/applications/com.acme.app/edits/e5:commit",
    );
    const payload = JSON.parse(res.content[0].text!);
    expect(payload).toMatchObject({ committed: false, validatedOnly: true });
  });

  it("promote_release passes changesNotSentForReview to the commit", async () => {
    mockFetch
      .mockResolvedValueOnce(resp({ id: "e6" }))
      .mockResolvedValueOnce(
        resp({
          track: "beta",
          releases: [{ name: "1", versionCodes: ["1"], status: "completed" }],
        }),
      )
      .mockResolvedValueOnce(resp({}))
      .mockResolvedValueOnce(resp({}));

    await tools.get("promote_release")!({
      from_track: "beta",
      to_track: "production",
      changes_not_sent_for_review: true,
    });

    expect(new URL(mockFetch.mock.calls[3][0]).searchParams.get("changesNotSentForReview")).toBe(
      "true",
    );
  });

  it("promote_release errors and deletes the edit when the source track has no active release", async () => {
    mockFetch
      .mockResolvedValueOnce(resp({ id: "e7" }))
      .mockResolvedValueOnce(resp({ track: "beta", releases: [{ name: "d", status: "draft" }] }))
      .mockResolvedValueOnce(resp(""));

    const res = await tools.get("promote_release")!({ from_track: "beta", to_track: "production" });
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain("No active release on track 'beta'");
    expect(calls(mockFetch)[2]).toBe(
      "DELETE /androidpublisher/v3/applications/com.acme.app/edits/e7",
    );
  });

  it("update_rollout changes the fraction of the in-progress release", async () => {
    mockFetch
      .mockResolvedValueOnce(resp({ id: "e8" }))
      .mockResolvedValueOnce(
        resp({
          track: "production",
          releases: [
            { name: "1.4", versionCodes: ["415"], status: "inProgress", userFraction: 0.1 },
          ],
        }),
      )
      .mockResolvedValueOnce(resp({}))
      .mockResolvedValueOnce(resp({}));

    await tools.get("update_rollout")!({ track: "production", user_fraction: 0.5 });
    const body = JSON.parse(mockFetch.mock.calls[2][1].body);
    expect(body.releases[0]).toMatchObject({ status: "inProgress", userFraction: 0.5 });
  });

  it("update_rollout with fraction 1 completes the rollout and drops userFraction", async () => {
    mockFetch
      .mockResolvedValueOnce(resp({ id: "e9" }))
      .mockResolvedValueOnce(
        resp({
          track: "production",
          releases: [
            { name: "1.4", versionCodes: ["415"], status: "inProgress", userFraction: 0.5 },
          ],
        }),
      )
      .mockResolvedValueOnce(resp({}))
      .mockResolvedValueOnce(resp({}));

    await tools.get("update_rollout")!({ track: "production", user_fraction: 1 });
    const release = JSON.parse(mockFetch.mock.calls[2][1].body).releases[0];
    expect(release.status).toBe("completed");
    expect(release.userFraction).toBeUndefined();
  });

  it("update_rollout resumes a halted release", async () => {
    mockFetch
      .mockResolvedValueOnce(resp({ id: "e10" }))
      .mockResolvedValueOnce(
        resp({
          track: "production",
          releases: [{ name: "1.4", versionCodes: ["415"], status: "halted", userFraction: 0.2 }],
        }),
      )
      .mockResolvedValueOnce(resp({}))
      .mockResolvedValueOnce(resp({}));

    await tools.get("update_rollout")!({ track: "production", user_fraction: 0.3 });
    expect(JSON.parse(mockFetch.mock.calls[2][1].body).releases[0].status).toBe("inProgress");
  });

  it("halt_rollout halts the in-progress release keeping its fraction", async () => {
    mockFetch
      .mockResolvedValueOnce(resp({ id: "e11" }))
      .mockResolvedValueOnce(
        resp({
          track: "production",
          releases: [
            { name: "1.4", versionCodes: ["415"], status: "inProgress", userFraction: 0.2 },
          ],
        }),
      )
      .mockResolvedValueOnce(resp({}))
      .mockResolvedValueOnce(resp({}));

    await tools.get("halt_rollout")!({ track: "production" });
    expect(JSON.parse(mockFetch.mock.calls[2][1].body).releases[0]).toMatchObject({
      status: "halted",
      userFraction: 0.2,
    });
  });

  it("halt_rollout errors when nothing is rolling out", async () => {
    mockFetch
      .mockResolvedValueOnce(resp({ id: "e12" }))
      .mockResolvedValueOnce(
        resp({ track: "production", releases: [{ name: "1.4", status: "completed" }] }),
      )
      .mockResolvedValueOnce(resp(""));

    const res = await tools.get("halt_rollout")!({ track: "production" });
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain("No in-progress rollout");
  });

  it("errors when no package name is available", async () => {
    const bare = collect();
    const res = await bare.get("list_tracks")!({});
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain("No package name given");
    expect(mockFetch).not.toHaveBeenCalled();
  });
});
