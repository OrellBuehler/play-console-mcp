export function ok(data: unknown) {
  const text = typeof data === "string" ? data : JSON.stringify(data);
  return { content: [{ type: "text" as const, text }] };
}

export function err(e: unknown) {
  return { content: [{ type: "text" as const, text: String(e) }], isError: true as const };
}

export function resolvePackage(packageName?: string, defaultPackageName?: string): string {
  const pkg = (packageName || "").trim() || (defaultPackageName || "").trim();
  if (!pkg) {
    throw new Error(
      "No package name given. Pass package_name (e.g. 'com.acme.app') or set GOOGLE_PLAY_PACKAGE_NAME.",
    );
  }
  return pkg;
}

export function resolveDeveloper(developerId?: string, defaultDeveloperId?: string): string {
  const id = (developerId || "").trim() || (defaultDeveloperId || "").trim();
  if (!id) {
    throw new Error(
      "No developer account ID given. Pass developer_id or set GOOGLE_PLAY_DEVELOPER_ID. It is the number in the Play Console URL: play.google.com/console/developers/<id>.",
    );
  }
  return id;
}
