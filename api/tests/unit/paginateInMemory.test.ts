import { describe, expect, it } from 'vitest';
import { decodeCursor, paginateInMemory } from '../../src/lib/pagination';
import { AppError } from '../../src/lib/errors';

interface Row {
  id: string;
  n: number;
}

function rows(count: number): Row[] {
  return Array.from({ length: count }, (_, i) => ({ id: `id-${i}`, n: i }));
}

describe('paginateInMemory', () => {
  it('returns the first page and a nextCursor when more rows remain', () => {
    const page = paginateInMemory(rows(5), { limit: 2 });
    expect(page.data.map((r) => r.id)).toEqual(['id-0', 'id-1']);
    expect(page.pagination.nextCursor).not.toBeNull();
  });

  it('walks through every row exactly once across successive pages', () => {
    const all = rows(7);
    let cursor: string | undefined;
    const seen: string[] = [];
    for (let i = 0; i < 10; i++) {
      const page = paginateInMemory(all, { limit: 3, cursor });
      seen.push(...page.data.map((r) => r.id));
      if (!page.pagination.nextCursor) break;
      cursor = page.pagination.nextCursor;
    }
    expect(seen).toEqual(all.map((r) => r.id));
  });

  it('returns null nextCursor on the last page', () => {
    const page = paginateInMemory(rows(3), { limit: 10 });
    expect(page.pagination.nextCursor).toBeNull();
    expect(page.data).toHaveLength(3);
  });

  it('rejects a cursor pointing at a row that no longer exists', () => {
    const badCursor = Buffer.from(JSON.stringify({ id: 'not-a-real-id' })).toString('base64url');
    expect(() => paginateInMemory(rows(3), { limit: 2, cursor: badCursor })).toThrow(AppError);
  });

  it('rejects a structurally malformed cursor', () => {
    expect(() => paginateInMemory(rows(3), { limit: 2, cursor: 'garbage-not-base64-json' })).toThrow(AppError);
    expect(decodeCursor('garbage-not-base64-json')).toBeNull();
  });
});
