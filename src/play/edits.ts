import type { GooglePlayClient } from "./client.js";

export interface EditOptions {
  validateOnly?: boolean;
  changesNotSentForReview?: boolean;
}

interface AppEdit {
  id: string;
}

function editsBase(pkg: string): string {
  return `/applications/${encodeURIComponent(pkg)}/edits`;
}

export async function readWithEdit<T>(
  client: GooglePlayClient,
  pkg: string,
  fn: (base: string) => Promise<T>,
): Promise<T> {
  const base = editsBase(pkg);
  const edit = await client.post<AppEdit>(base, {});
  try {
    return await fn(`${base}/${encodeURIComponent(edit.id)}`);
  } finally {
    await client.del(`${base}/${encodeURIComponent(edit.id)}`).catch(() => {});
  }
}

export async function withEdit<T>(
  client: GooglePlayClient,
  pkg: string,
  fn: (base: string) => Promise<T>,
  options: EditOptions = {},
): Promise<{ result: T; committed: boolean }> {
  const base = editsBase(pkg);
  const edit = await client.post<AppEdit>(base, {});
  const editPath = `${base}/${encodeURIComponent(edit.id)}`;
  try {
    const result = await fn(editPath);
    if (options.validateOnly) {
      await client.post(`${editPath}:validate`);
      await client.del(editPath).catch(() => {});
      return { result, committed: false };
    }
    await client.post(
      `${editPath}:commit`,
      undefined,
      options.changesNotSentForReview ? { changesNotSentForReview: true } : undefined,
    );
    return { result, committed: true };
  } catch (e) {
    await client.del(editPath).catch(() => {});
    throw e;
  }
}
