// Layer 12A §11, §13 — the one API client.
//
// Every request: `${apiBaseUrl}/v1/...`, `Authorization: Bearer <Supabase
// access token>` read fresh from Supabase, an `X-Request-Id`, JSON in/out, a
// timeout, typed error mapping, contract validation of the body and a single
// 401 hook. The account id is never sent: the API derives it from the token.

import type { z } from 'zod';

import { ApiError, kindForStatus, type ValidationIssue } from './errors';

export type QueryValue = string | number | boolean | null | undefined;

export interface RequestOptions<T> {
  method?: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';
  query?: Record<string, QueryValue>;
  body?: unknown;
  /** Runtime contract check at the trust boundary. */
  schema: z.ZodType<T>;
  signal?: AbortSignal;
  timeoutMs?: number;
}

export interface ApiClientDeps {
  baseUrl: string;
  getAccessToken: () => Promise<string | null>;
  /** Called once per request that the API rejects with 401. */
  onUnauthorized: () => void | Promise<void>;
  fetch?: typeof fetch;
  timeoutMs?: number;
  newRequestId?: () => string;
}

export interface ApiClient {
  request<T>(path: string, options: RequestOptions<T>): Promise<T>;
}

export const DEFAULT_TIMEOUT_MS = 15_000;

/** Paths the consumer app may never call (§39, §41 E). */
const FORBIDDEN_PATH = /^\/v1\/admin(\/|$)/;

export function newRequestId(): string {
  // Opaque correlation id; matches the API's accepted pattern [A-Za-z0-9._-]{1,128}.
  const rand = () => Math.floor(Math.random() * 0x100000000).toString(16).padStart(8, '0');
  return `m-${Date.now().toString(36)}-${rand()}${rand()}`;
}

function buildUrl(baseUrl: string, path: string, query?: Record<string, QueryValue>): string {
  const params: string[] = [];
  for (const [key, value] of Object.entries(query ?? {})) {
    if (value === undefined || value === null) continue;
    params.push(`${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`);
  }
  return `${baseUrl}${path}${params.length ? `?${params.join('&')}` : ''}`;
}

/** Keeps only the field paths of a 400 (`details.issues[].path`); server wording is not shown. */
function parseIssues(details: unknown): ValidationIssue[] {
  const issues = details && typeof details === 'object' ? (details as { issues?: unknown }).issues : undefined;
  if (!Array.isArray(issues)) return [];
  return issues
    .filter((d): d is { path?: unknown } => !!d && typeof d === 'object')
    .map((d) => ({ path: typeof d.path === 'string' ? d.path : '' }));
}

export function createApiClient(deps: ApiClientDeps): ApiClient {
  const doFetch = deps.fetch ?? fetch;
  const makeId = deps.newRequestId ?? newRequestId;

  return {
    async request<T>(path: string, options: RequestOptions<T>): Promise<T> {
      if (!path.startsWith('/v1/') || FORBIDDEN_PATH.test(path)) {
        throw new Error(`Refusing to call ${path.split('?')[0]}: not a consumer /v1 path`);
      }

      const token = await deps.getAccessToken();
      if (!token) {
        throw new ApiError('unauthenticated');
      }

      const requestId = makeId();
      const headers: Record<string, string> = {
        Accept: 'application/json',
        Authorization: `Bearer ${token}`,
        'X-Request-Id': requestId,
      };
      const hasBody = options.body !== undefined;
      if (hasBody) headers['Content-Type'] = 'application/json';

      const controller = new AbortController();
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        controller.abort();
      }, options.timeoutMs ?? deps.timeoutMs ?? DEFAULT_TIMEOUT_MS);
      const onOuterAbort = () => controller.abort();
      options.signal?.addEventListener('abort', onOuterAbort);

      let response: Response;
      try {
        response = await doFetch(buildUrl(deps.baseUrl, path, options.query), {
          method: options.method ?? 'GET',
          headers,
          body: hasBody ? JSON.stringify(options.body) : undefined,
          signal: controller.signal,
        });
      } catch (error) {
        if (timedOut) throw new ApiError('timeout', { requestId });
        if (options.signal?.aborted) throw error;
        throw new ApiError('offline', { requestId });
      } finally {
        clearTimeout(timer);
        options.signal?.removeEventListener('abort', onOuterAbort);
      }

      const responseId = response.headers.get('x-request-id') ?? requestId;
      let body: unknown = null;
      const text = await response.text().catch(() => '');
      if (text) {
        try {
          body = JSON.parse(text);
        } catch {
          body = null;
        }
      }

      if (!response.ok) {
        const envelope = body && typeof body === 'object' && 'error' in body ? (body as { error?: { code?: unknown; details?: unknown; requestId?: unknown } }).error : undefined;
        const retryAfter = Number.parseInt(response.headers.get('retry-after') ?? '', 10);
        const error = new ApiError(kindForStatus(response.status), {
          status: response.status,
          code: typeof envelope?.code === 'string' ? envelope.code : null,
          requestId: typeof envelope?.requestId === 'string' ? envelope.requestId : responseId,
          retryAfterSeconds: Number.isFinite(retryAfter) ? retryAfter : null,
          issues: response.status === 400 ? parseIssues(envelope?.details) : [],
        });
        if (response.status === 401) {
          await deps.onUnauthorized();
        }
        throw error;
      }

      const parsed = options.schema.safeParse(body);
      if (!parsed.success) {
        throw new ApiError('invalid_response', { status: response.status, requestId: responseId });
      }
      return parsed.data;
    },
  };
}
