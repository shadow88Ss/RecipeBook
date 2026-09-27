import { describe, expect, it, vi } from 'vitest';
import { requireProfileScope, resolveProfileScope } from '../../src/lib/authorize';
import { AppError } from '../../src/lib/errors';
import type { ScopedDbClient } from '../../src/lib/scopedDb';

function fakeDb(scope: string | null): ScopedDbClient {
  return {
    select: vi.fn(),
    insert: vi.fn(),
    update: vi.fn(),
    rpc: vi.fn().mockResolvedValue(scope),
  };
}

describe('resolveProfileScope', () => {
  it('returns the scope profile_access_scope() reports', async () => {
    await expect(resolveProfileScope(fakeDb('view_only'), 'p1')).resolves.toBe('view_only');
  });

  it('returns null when the caller has no access', async () => {
    await expect(resolveProfileScope(fakeDb(null), 'p1')).resolves.toBeNull();
  });
});

describe('requireProfileScope', () => {
  it('throws a non-disclosing 404 when the caller has no scope at all', async () => {
    await expect(requireProfileScope(fakeDb(null), 'p1', ['full_management'])).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
  });

  it('throws 403 FORBIDDEN when the caller has a scope, but not one the operation allows', async () => {
    await expect(requireProfileScope(fakeDb('view_only'), 'p1', ['full_management'])).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
  });

  it('resolves with the scope when it is in the allowed list', async () => {
    await expect(requireProfileScope(fakeDb('pediatric_weight_management'), 'p1', ['full_management', 'pediatric_weight_management'])).resolves.toBe(
      'pediatric_weight_management',
    );
  });

  it('never widens the allowed set implicitly — an unlisted scope is always rejected', async () => {
    const err = await requireProfileScope(fakeDb('full_management'), 'p1', ['view_only'] as never).catch((e) => e);
    expect(err).toBeInstanceOf(AppError);
    expect(err.code).toBe('FORBIDDEN');
  });
});
