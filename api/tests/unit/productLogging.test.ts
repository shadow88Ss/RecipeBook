// Layer 11B — deterministic ProductLabelVersion selection (approved G1/G2)
// and Product actuals in plan fulfillment. Pure; no database.

import { describe, expect, it } from 'vitest';
import { labelInEffect, labelReplacedBefore, selectLabelVersion } from '../../src/domain/meals/meal.product';
import { sameIdentity } from '../../src/domain/mealPlans/planFulfillment';
import type { LabelVersionRow } from '../../src/domain/products/product.service';

const label = (id: string, version: number, published: string, extra: Partial<LabelVersionRow> = {}): LabelVersionRow => ({
  id,
  product_id: 'p',
  version_number: version,
  status: 'superseded',
  nutrition_source: 'manufacturer_label',
  provenance_reference: null,
  effective_from: null,
  superseded_at: null,
  superseded_by_label_version_id: null,
  created_at: published,
  ...extra,
});

const v1 = label('v1', 1, '2026-01-01T00:00:00Z', { superseded_at: '2026-06-01T00:00:00Z', superseded_by_label_version_id: 'v2' });
const v2 = label('v2', 2, '2026-06-01T00:00:00Z', { status: 'current' });
const history = [v1, v2];
const select = (consumedAt: string, extra: { requested?: string; original?: string; labels?: LabelVersionRow[] } = {}) =>
  selectLabelVersion({
    labels: extra.labels ?? history,
    currentLabelId: 'v2',
    consumedAt,
    consumedLocalDate: consumedAt.slice(0, 10),
    ...(extra.requested ? { requestedLabelId: extra.requested } : {}),
    ...(extra.original ? { originalLabelId: extra.original } : {}),
  });

describe('selectLabelVersion', () => {
  it('uses the current label when it was already published and in effect at consumption', () => {
    expect(select('2026-07-01T12:00:00Z')).toMatchObject({ kind: 'selected', label: { id: 'v2' }, basis: 'current_label' });
    expect(select('2026-07-01T12:00:00Z', { requested: 'v2' })).toMatchObject({ kind: 'selected', basis: 'current_label' });
  });

  it('refuses a requested old label when nothing is ambiguous', () => {
    expect(select('2026-07-01T12:00:00Z', { requested: 'v1' })).toMatchObject({ kind: 'invalid' });
  });

  it('never assumes today\'s label for a meal before it was published: confirmation with candidates', () => {
    const result = select('2026-03-01T12:00:00Z');
    expect(result).toMatchObject({ kind: 'confirmation_required', suggested: { id: 'v1' } });
    if (result.kind === 'confirmation_required') expect(result.candidates.map((l) => l.id)).toEqual(['v1', 'v2']);
    expect(select('2026-03-01T12:00:00Z', { requested: 'v1' })).toMatchObject({ kind: 'selected', label: { id: 'v1' }, basis: 'user_confirmed_backdated' });
    expect(select('2026-03-01T12:00:00Z', { requested: 'v2' })).toMatchObject({ kind: 'selected', label: { id: 'v2' }, basis: 'user_confirmed_backdated' });
    expect(select('2026-03-01T12:00:00Z', { requested: 'other' })).toMatchObject({ kind: 'invalid' });
  });

  it('a meal before any label was published has no suggestion', () => {
    expect(select('2025-12-01T12:00:00Z')).toMatchObject({ kind: 'confirmation_required', suggested: null });
  });

  it('a label replaced before the meal is not a candidate', () => {
    const v3 = label('v3', 3, '2026-09-01T00:00:00Z', { status: 'current' });
    const labels = [v1, { ...v2, status: 'superseded' as const, superseded_at: '2026-09-01T00:00:00Z' }, v3];
    const result = selectLabelVersion({ labels, currentLabelId: 'v3', consumedAt: '2026-07-01T12:00:00Z', consumedLocalDate: '2026-07-01' });
    expect(result.kind).toBe('confirmation_required');
    if (result.kind === 'confirmation_required') {
      expect(result.candidates.map((l) => l.id)).toEqual(['v2', 'v3']);
      expect(result.suggested?.id).toBe('v2');
    }
    expect(labelReplacedBefore(v1, labels, '2026-07-01T12:00:00Z', '2026-07-01')).toBe(true);
  });

  it('effective_from later than the meal keeps a published label out of effect', () => {
    const future = { ...v2, effective_from: '2026-08-01' };
    expect(labelInEffect(future, '2026-07-01T12:00:00Z', '2026-07-01')).toBe(false);
    const result = select('2026-07-01T12:00:00Z', { labels: [v1, future] });
    expect(result).toMatchObject({ kind: 'confirmation_required', suggested: { id: 'v1' } });
    expect(select('2026-08-02T12:00:00Z', { labels: [v1, future] })).toMatchObject({ kind: 'selected', label: { id: 'v2' } });
  });

  it('a Product with a single label is deterministic, whenever consumed', () => {
    const only = label('only', 1, '2026-06-01T00:00:00Z', { status: 'current' });
    expect(selectLabelVersion({ labels: [only], currentLabelId: 'only', consumedAt: '2026-01-01T00:00:00Z', consumedLocalDate: '2026-01-01' })).toMatchObject({
      kind: 'selected',
      label: { id: 'only' },
      basis: 'current_label',
    });
  });

  it('G2: a same-Product correction keeps the original label unless another is explicitly confirmed', () => {
    expect(select('2026-07-01T12:00:00Z', { original: 'v1' })).toMatchObject({ kind: 'selected', label: { id: 'v1' }, basis: 'correction_original_label' });
    expect(select('2026-07-01T12:00:00Z', { original: 'v1', requested: 'v1' })).toMatchObject({ basis: 'correction_original_label' });
    expect(select('2026-07-01T12:00:00Z', { original: 'v1', requested: 'v2' })).toMatchObject({ kind: 'selected', label: { id: 'v2' }, basis: 'current_label' });
  });

  it('no current label: cannot be logged', () => {
    expect(selectLabelVersion({ labels: [], currentLabelId: null, consumedAt: '2026-07-01T12:00:00Z', consumedLocalDate: '2026-07-01' })).toEqual({ kind: 'no_label' });
  });
});

describe('plan fulfillment identity with Product actuals', () => {
  it('a Product actual is never the same item as a planned Food or Recipe (substitution only)', () => {
    expect(sameIdentity({ food_id: 'f', recipe_version_id: null }, { food_id: null, recipe_version_id: null })).toBe(false);
    expect(sameIdentity({ food_id: null, recipe_version_id: 'r' }, { food_id: null, recipe_version_id: null })).toBe(false);
  });
});
