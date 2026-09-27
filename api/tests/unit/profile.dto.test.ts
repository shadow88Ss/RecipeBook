import { describe, expect, it } from 'vitest';
import { toProfileDto } from '../../src/domain/profiles/profile.dto';
import type { ProfileWithScope } from '../../src/domain/profiles/profile.repository';

const baseRow: ProfileWithScope = {
  id: 'b0000000-0000-0000-0000-000000000003',
  account_id: 'a0000000-0000-0000-0000-000000000003',
  display_name: 'Child Profile',
  is_child: true,
  date_of_birth: '2018-06-01',
  created_at: '2026-01-01T00:00:00.000Z',
  access_scope: 'full_management',
};

describe('toProfileDto', () => {
  it('includes account_id/created_at for full_management', () => {
    const dto = toProfileDto({ ...baseRow, access_scope: 'full_management' });
    expect(dto).toMatchObject({ account_id: baseRow.account_id, created_at: baseRow.created_at });
  });

  it('includes account_id/created_at for view_only', () => {
    const dto = toProfileDto({ ...baseRow, access_scope: 'view_only' });
    expect(dto).toMatchObject({ account_id: baseRow.account_id, created_at: baseRow.created_at });
  });

  it('H/I: the pediatric_weight_management projection never exposes account_id, created_at, or deleted_at', () => {
    const dto = toProfileDto({ ...baseRow, access_scope: 'pediatric_weight_management' });
    expect(dto).not.toHaveProperty('account_id');
    expect(dto).not.toHaveProperty('created_at');
    expect(dto).not.toHaveProperty('deleted_at');
    expect(dto).toEqual({
      id: baseRow.id,
      display_name: baseRow.display_name,
      is_child: baseRow.is_child,
      date_of_birth: baseRow.date_of_birth,
      access_scope: 'pediatric_weight_management',
    });
  });

  it('serializes the pediatric projection with no leaked keys even under JSON.stringify', () => {
    const dto = toProfileDto({ ...baseRow, access_scope: 'pediatric_weight_management' });
    const serialized = JSON.stringify(dto);
    expect(serialized).not.toContain('account_id');
    expect(serialized).not.toContain(baseRow.account_id);
    expect(serialized).not.toContain('created_at');
  });
});
