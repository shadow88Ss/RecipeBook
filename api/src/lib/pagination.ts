// Layer 4A §11 — one reusable pagination convention for future list
// endpoints (30_API.md §8 leaves cursor-vs-offset to be fixed per resource;
// this foundation fixes **cursor-based** pagination as the one shared
// convention, so future list endpoints do not each invent their own).
//
// The cursor is an opaque, base64url-encoded token carrying only a sort key
// (never a raw database offset, and never anything sensitive) — clients
// must treat it as opaque and must not decode or construct it themselves.

import { z } from 'zod';
import { AppError } from './errors';

const MIN_LIMIT = 1;
const MAX_LIMIT = 100;
const DEFAULT_LIMIT = 20;

export const paginationQuerySchema = z.object({
  cursor: z.string().min(1).max(2048).optional(),
  limit: z.coerce.number().int().min(MIN_LIMIT).max(MAX_LIMIT).default(DEFAULT_LIMIT),
});

export type PaginationQuery = z.infer<typeof paginationQuerySchema>;

export interface Page<T> {
  data: T[];
  pagination: {
    nextCursor: string | null;
    limit: number;
  };
}

export function encodeCursor(key: Record<string, string | number>): string {
  return Buffer.from(JSON.stringify(key), 'utf8').toString('base64url');
}

/** Returns null for a missing/malformed cursor rather than throwing — an
 * invalid cursor is a validation error the caller (route/service) turns
 * into AppError.validation, not a crash. */
export function decodeCursor(cursor: string): Record<string, string | number> | null {
  try {
    const decoded = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
    if (decoded !== null && typeof decoded === 'object' && !Array.isArray(decoded)) {
      return decoded as Record<string, string | number>;
    }
    return null;
  } catch {
    return null;
  }
}

export function buildPage<T>(data: T[], nextCursor: string | null, limit: number): Page<T> {
  return { data, pagination: { nextCursor, limit } };
}

/** Upper bound on rows fetched before in-memory pagination is applied
 * (paginateInMemory below). Not true database-pushed keyset pagination —
 * documented, bounded soft ceiling for Phase 1 (Layer 4B), same
 * transparently-disclosed tradeoff as Layer 4A's Profile listing. A
 * genuinely unbounded history (years of daily weight measurements) is a
 * candidate for real keyset pagination in a future layer; this keeps
 * today's query cost capped rather than silently unbounded. */
export const IN_MEMORY_PAGE_FETCH_CAP = 1000;

/** Layer 4B §15 — reuses the Layer 4A cursor contract (paginationQuerySchema
 * + Page<T>) over a list already fetched in a stable order, for every new
 * list endpoint, rather than each domain reimplementing cursor slicing. */
export function paginateInMemory<T extends { id: string }>(rows: T[], pagination: PaginationQuery): Page<T> {
  let startIndex = 0;
  if (pagination.cursor) {
    const decoded = decodeCursor(pagination.cursor);
    const cursorId = decoded?.id;
    if (typeof cursorId !== 'string') {
      throw AppError.validation('Invalid pagination cursor.');
    }
    const cursorIndex = rows.findIndex((row) => row.id === cursorId);
    if (cursorIndex === -1) {
      throw AppError.validation('Invalid pagination cursor.');
    }
    startIndex = cursorIndex + 1;
  }

  const page = rows.slice(startIndex, startIndex + pagination.limit);
  const hasMore = startIndex + pagination.limit < rows.length;
  const lastRow = page[page.length - 1];
  const nextCursor = hasMore && lastRow ? encodeCursor({ id: lastRow.id }) : null;

  return buildPage(page, nextCursor, pagination.limit);
}
