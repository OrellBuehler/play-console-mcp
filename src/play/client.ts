import type { TokenProvider } from "./auth.js";

export const PUBLISHER_BASE_URL = "https://androidpublisher.googleapis.com/androidpublisher/v3";
export const REPORTING_BASE_URL = "https://playdeveloperreporting.googleapis.com/v1beta1";

export type QueryParams = Record<string, string | number | boolean | string[] | undefined>;

export class GooglePlayClient {
  readonly baseUrl: string;
  readonly timeoutMs: number;

  constructor(
    private tokenProvider: TokenProvider,
    baseUrl: string = PUBLISHER_BASE_URL,
    timeoutMs = 30000,
  ) {
    this.baseUrl = baseUrl;
    this.timeoutMs = timeoutMs;
  }

  private buildUrl(path: string, params?: QueryParams): string {
    const url = new URL(path.startsWith("http") ? path : `${this.baseUrl}${path}`);
    if (params) {
      for (const [k, v] of Object.entries(params)) {
        if (v === undefined || v === null) continue;
        if (Array.isArray(v)) {
          if (v.length === 0) continue;
          url.searchParams.set(k, v.join(","));
        } else {
          url.searchParams.set(k, String(v));
        }
      }
    }
    return url.toString();
  }

  private async request(url: string, options: RequestInit = {}): Promise<Response> {
    const token = await this.tokenProvider();
    let res: Response;
    try {
      res = await fetch(url, {
        ...options,
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/json",
          ...(typeof options.body === "string" ? { "Content-Type": "application/json" } : {}),
          ...((options.headers as Record<string, string>) ?? {}),
        },
        signal: options.signal ?? AbortSignal.timeout(this.timeoutMs),
      });
    } catch (e) {
      if (e instanceof DOMException && e.name === "TimeoutError") {
        throw new Error(`Google Play request timed out after ${this.timeoutMs}ms`, { cause: e });
      }
      throw e;
    }
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`${res.status} ${res.statusText}: ${body}`);
    }
    return res;
  }

  async get<T>(path: string, params?: QueryParams): Promise<T> {
    const res = await this.request(this.buildUrl(path, params));
    return res.json() as Promise<T>;
  }

  async post<T>(path: string, body?: unknown, params?: QueryParams): Promise<T> {
    const res = await this.request(this.buildUrl(path, params), {
      method: "POST",
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return this.parseMaybeEmpty<T>(res);
  }

  async put<T>(path: string, body: unknown, params?: QueryParams): Promise<T> {
    const res = await this.request(this.buildUrl(path, params), {
      method: "PUT",
      body: JSON.stringify(body),
    });
    return this.parseMaybeEmpty<T>(res);
  }

  async del(path: string, params?: QueryParams): Promise<void> {
    await this.request(this.buildUrl(path, params), { method: "DELETE" });
  }

  private async parseMaybeEmpty<T>(res: Response): Promise<T> {
    const text = await res.text();
    if (!text) return {} as T;
    return JSON.parse(text) as T;
  }
}
