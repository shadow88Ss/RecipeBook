import { dailyTrackerSchema } from '../src/api/contracts/dailyTracker';
import { profilePageSchema, profileSchema } from '../src/api/contracts/profile';
import { progressSchema } from '../src/api/contracts/progress';
import { lookupBarcode } from '../src/barcode/barcode';
import { createApiClient } from '../src/api/client';
import { redact } from '../src/lib/logger';
import { navigationGate } from '../src/state/navigationGate';
import { addDays, localDate } from '../src/lib/dates';
import { comparisonText, formatAmount } from '../src/features/today/format';
import { noConsumptionTrackerDto, PROFILE_A, profileDto, profilePage, progressDto, trackerDto } from './helpers/fixtures';
import { fakeFetch, json } from './helpers/fakeServer';

describe('mobile DTOs (§14–15)', () => {
  it('accepts both profile projections and keeps access_scope verbatim', () => {
    const page = profilePageSchema.parse(profilePage([profileDto(PROFILE_A, 'A'), profileDto('p2', 'Kid', 'pediatric_weight_management')]));
    expect(page.data.map((p) => p.access_scope)).toEqual(['full_management', 'pediatric_weight_management']);
    // account_id is not part of the mobile DTO at all.
    expect(Object.keys(page.data[0]!)).not.toContain('account_id');
    expect(profileSchema.parse({ ...profileDto('p3', 'X'), access_scope: 'future_scope' }).access_scope).toBe('future_scope');
  });

  it('keeps unknown nutrient values as null (not 0) and known zeros as zero', () => {
    const partial = dailyTrackerSchema.parse(trackerDto());
    expect(partial.actual.summary.carbohydrate_g.value).toBeNull();
    expect(partial.actual.summary.carbohydrate_g.coverage).toBe('unavailable');
    const empty = dailyTrackerSchema.parse(noConsumptionTrackerDto());
    expect(empty.actual.summary.energy_kcal).toMatchObject({ value: 0, is_zero: true, coverage: 'complete' });
  });

  it('rejects a tracker with an undocumented target context', () => {
    const bad = trackerDto({ target: { ...trackerDto().target, context: 'guessed_target' } });
    expect(dailyTrackerSchema.safeParse(bad).success).toBe(false);
  });

  it('accepts the Progress contract and rejects a non-null combined score', () => {
    expect(progressSchema.safeParse(progressDto()).success).toBe(true);
    expect(progressSchema.safeParse(progressDto({ combined_score: 87 })).success).toBe(false);
  });
});

describe('display helpers (no arithmetic, missing is never zero)', () => {
  it('formats values', () => {
    expect(formatAmount({ value: null, is_zero: false, below_output_precision: false }, 'g')).toBe('Not available');
    expect(formatAmount({ value: 0, is_zero: true, below_output_precision: false }, 'g')).toBe('0 g');
    expect(formatAmount({ value: 0, is_zero: false, below_output_precision: true }, 'g')).toBe('less than 0.1 g');
    expect(formatAmount({ value: 0.04, is_zero: false, below_output_precision: false }, 'g')).toBe('less than 0.1 g');
    expect(formatAmount({ value: 12.345, is_zero: false, below_output_precision: false }, 'g')).toBe('12.3 g');
  });

  it('words every comparison status using only server numbers', () => {
    const base = trackerDto().comparison.nutrients[0]!;
    const mk = (o: object) => ({ ...base, remaining: null, remaining_at_most: null, over_target_by: null, over_target_by_at_least: null, ...o }) as Parameters<typeof comparisonText>[0];
    expect(comparisonText(mk({ comparison_status: 'at_target', remaining: 0, over_target_by: 0 }))).toBe('At target');
    expect(comparisonText(mk({ comparison_status: 'above_target', remaining: 0, over_target_by: 12 }))).toBe('12 kcal over target');
    expect(comparisonText(mk({ comparison_status: 'above_target', remaining: 0, over_target_by_at_least: 5 }))).toBe('At least 5 kcal over target');
    expect(comparisonText(mk({ comparison_status: 'at_or_above_target', remaining: 0 }))).toBe('At or above target');
    expect(comparisonText(mk({ comparison_status: 'actual_unavailable' }))).toBe('Cannot compare: no data for this nutrient');
  });
});

describe('barcode architecture (§28, §40)', () => {
  it('sends the raw scanned string to the MyRecipeBook API, never to a provider', async () => {
    const server = fakeFetch({ 'GET /v1/products/barcode/[^/]+/lookup': () => json(200, { submitted: {}, source: 'none', match: null, product: null, candidates: [], next_step: null }) });
    const api = createApiClient({ baseUrl: 'https://api.test.example', getAccessToken: async () => 't', onUnauthorized: jest.fn(), fetch: server.fetch });
    await lookupBarcode(api, ' 0 12345/678905 ');
    const url = new URL(server.calls[0]!.url);
    expect(url.host).toBe('api.test.example');
    expect(url.pathname).toBe('/v1/products/barcode/%200%2012345%2F678905%20/lookup');
    expect(url.searchParams.get('mode')).toBe('first');
  });
});

describe('logging (§36)', () => {
  it('redacts token, password, secret, session and email fields', () => {
    expect(redact({ accessToken: 'a', refresh_token: 'b', password: 'c', clientSecret: 'd', session: 'e', email: 'f', authorization: 'g', kind: 'offline', status: 500 })).toEqual({
      accessToken: '[redacted]',
      refresh_token: '[redacted]',
      password: '[redacted]',
      clientSecret: '[redacted]',
      session: '[redacted]',
      email: '[redacted]',
      authorization: '[redacted]',
      kind: 'offline',
      status: 500,
    });
  });
});

describe('navigation gate and dates', () => {
  it('routes by auth status and Profile selection', () => {
    expect(navigationGate('restoring', false)).toBe('restoring');
    expect(navigationGate('signed_out', true)).toBe('auth');
    expect(navigationGate('signed_in', false)).toBe('select-profile');
    expect(navigationGate('signed_in', true)).toBe('app');
  });

  it('computes the local calendar day in the given IANA zone', () => {
    const instant = new Date('2026-09-30T21:30:00Z');
    expect(localDate(instant, 'UTC')).toBe('2026-09-30');
    expect(localDate(instant, 'Asia/Dubai')).toBe('2026-10-01');
    expect(localDate(instant, 'America/New_York')).toBe('2026-09-30');
    expect(addDays('2026-03-01', -1)).toBe('2026-02-28');
  });
});
