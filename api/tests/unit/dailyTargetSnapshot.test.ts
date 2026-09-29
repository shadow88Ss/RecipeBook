// Layer 10A unit tests — daily target snapshot request contract and DTO.
import { describe, expect, it } from 'vitest';
import { dailySnapshotCaptureSchema, dailySnapshotListQuerySchema } from '../../src/domain/effectiveTarget/effectiveTarget.schemas';
import { toDailySnapshotDto, type SnapshotRecord } from '../../src/domain/effectiveTarget/effectiveTarget.service';

describe('capture request', () => {
  it('accepts only the day context; target values, provenance, version, payload and reason are stripped', () => {
    const parsed = dailySnapshotCaptureSchema.parse({
      local_date: '2026-10-01',
      timezone: 'Asia/Dubai',
      snapshot_payload: { energy: { value: 1 } },
      resolver_version: 'x',
      unresolved_fields: [],
      snapshot_reason: 'manual_audit',
      fields: [],
    });
    expect(parsed).toEqual({ local_date: '2026-10-01', timezone: 'Asia/Dubai' });
  });

  it('requires a valid calendar date and an IANA zone', () => {
    expect(dailySnapshotCaptureSchema.safeParse({ local_date: '2026-02-30', timezone: 'UTC' }).success).toBe(false);
    expect(dailySnapshotCaptureSchema.safeParse({ local_date: '2026-10-01', timezone: 'GMT+4' }).success).toBe(false);
    expect(dailySnapshotCaptureSchema.safeParse({ local_date: '2026-10-01' }).success).toBe(false);
    expect(dailySnapshotListQuerySchema.safeParse({ from: '2026-10-02', to: '2026-10-01' }).success).toBe(false);
  });
});

describe('historical target DTO', () => {
  it('orders canonical fields, keeps field-level provenance and unresolved fields, exposes no actor', () => {
    const row = {
      id: 's',
      profile_id: 'p',
      snapshot_payload: {
        protein: { value: 120, unit: 'g', source: 'clinician_target', source_reference: 'c1' },
        energy: { value: 2000, unit: 'kcal', source: 'user_target', source_reference: 'u1' },
      },
      resolver_version: 'phase2-canonical-target-keys-v2',
      resolved_at: '2026-10-01T05:00:00.000Z',
      snapshot_reason: 'daily_tracking',
      linked_event_type: null,
      linked_event_id: null,
      created_at: '2026-10-01T05:00:01.000Z',
      local_date: '2026-10-01',
      local_timezone: 'Asia/Dubai',
      unresolved_fields: [{ field_name: 'x', source: 'user_target', source_reference: 'u2', reason: 'unknown_target_key' }],
    } as SnapshotRecord;
    const dto = toDailySnapshotDto(row);
    expect(dto.fields.map((f) => [f.field_name, f.source])).toEqual([
      ['energy', 'user_target'],
      ['protein', 'clinician_target'],
    ]);
    expect(dto).toMatchObject({ local_date: '2026-10-01', local_timezone: 'Asia/Dubai', captured_at: '2026-10-01T05:00:01.000Z', unresolved_fields: [{ field_name: 'x' }] });
    expect(dto).not.toHaveProperty('created_by_account_id');
  });
});
