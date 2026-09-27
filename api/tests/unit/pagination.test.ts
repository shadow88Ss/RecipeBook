import { describe, expect, it } from 'vitest';
import { buildPage, decodeCursor, encodeCursor, paginationQuerySchema } from '../../src/lib/pagination';

describe('pagination', () => {
  it('round-trips a cursor', () => {
    const cursor = encodeCursor({ id: 'abc-123' });
    expect(decodeCursor(cursor)).toEqual({ id: 'abc-123' });
  });

  it('returns null for a malformed cursor rather than throwing', () => {
    expect(decodeCursor('not-base64url-json')).toBeNull();
    expect(decodeCursor(Buffer.from('"just a string"').toString('base64url'))).toBeNull();
  });

  it('applies default limit and bounds', () => {
    expect(paginationQuerySchema.parse({})).toEqual({ limit: 20 });
    expect(paginationQuerySchema.safeParse({ limit: 0 }).success).toBe(false);
    expect(paginationQuerySchema.safeParse({ limit: 101 }).success).toBe(false);
    expect(paginationQuerySchema.parse({ limit: '50' })).toEqual({ limit: 50 });
  });

  it('builds the fixed page envelope shape', () => {
    expect(buildPage([1, 2], 'next-token', 20)).toEqual({
      data: [1, 2],
      pagination: { nextCursor: 'next-token', limit: 20 },
    });
  });
});
