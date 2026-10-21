// Layer 12C — Meal plan screens against a scripted API (docs/30_API.md §21).
// The app shows planned intent as the server reported it: live vs confirmed
// nutrition, current items counted, cancelled and replaced items listed but
// not counted, and a day with nothing planned never shown as zero intake.
// Values are invented test data.

import { fireEvent, screen } from '@testing-library/react-native';

import { MealPlanScreen } from '../src/features/plan/MealPlanScreen';
import { MealPlansScreen } from '../src/features/plan/MealPlansScreen';
import { PROFILE_A, profileDto, profilePage, summaryEntry } from './helpers/fixtures';
import { json, type Call } from './helpers/fakeServer';
import { renderApp } from './helpers/renderApp';

const PLAN = 'eeeeeeee-0000-4000-8000-000000000001';
const profiles = () => json(200, profilePage([profileDto(PROFILE_A, 'Sam')]));

const summary = (plan: { id: string; name: string; start_date: string; end_date: string; status: string }) => ({
  profile_id: PROFILE_A,
  description: null,
  local_timezone: 'Asia/Dubai',
  created_at: '2026-10-01T00:00:00Z',
  updated_at: '2026-10-01T00:00:00Z',
  ...plan,
});

type Cov = 'complete' | 'partial' | 'unavailable';
const planned = (energy: number | null, coverage: Cov, count = 1, resolved = count) => ({
  basis: count ? 'planned_items' : 'no_planned_items',
  summary: {
    energy_kcal: summaryEntry('energy', energy, coverage, resolved, count),
    protein_g: summaryEntry('protein', 20, 'complete', count, count),
    carbohydrate_g: summaryEntry('carbohydrate', null, 'unavailable', 0, count),
    fat_g: summaryEntry('fat', 5, 'complete', count, count),
    fiber_g: summaryEntry('fiber', 0, 'complete', count, count),
  },
  item_count: count,
  coverage_summary: {},
});
const nothingPlanned = () => ({ ...planned(0, 'complete', 0), summary: { ...planned(0, 'complete', 0).summary } });

const item = (id: string, overrides: Record<string, unknown>) => ({
  id,
  planned_meal_id: 'm1',
  source_type: 'food',
  food: { food_id: 'f1', canonical_name: 'Rolled oats' },
  recipe: null,
  amount: { quantity: 60, unit: 'g', serving_id: null, serving_description: null },
  position: 1,
  status: 'confirmed',
  confirmed_at: '2026-10-01T00:00:00Z',
  is_current: true,
  is_pending_replacement: false,
  supersedes_planned_meal_item_id: null,
  superseded_by_planned_meal_item_id: null,
  created_at: '2026-10-01T00:00:00Z',
  nutrition: { ...planned(230, 'complete'), basis: 'confirmed_snapshot' },
  ...overrides,
});

function planDetail(overrides: Record<string, unknown> = {}) {
  return {
    ...summary({ id: PLAN, name: 'October week', start_date: '2026-10-20', end_date: '2026-10-21', status: 'active' }),
    item_counts: { draft: 1, planned: 0, confirmed: 2, cancelled: 1 },
    current_item_count: 3,
    includes_unconfirmed: true,
    nutrition: planned(780, 'partial', 3, 2),
    days: [
      {
        id: 'd1',
        plan_date: '2026-10-20',
        nutrition: planned(780, 'partial', 3, 2),
        meals: [
          {
            id: 'm1',
            meal_type: 'breakfast',
            scheduled_local_time: '07:30',
            notes: 'Before the gym',
            position: 1,
            nutrition: planned(780, 'partial', 3, 2),
            items: [
              item('i-oats', {}),
              item('i-bowl', {
                source_type: 'recipe',
                food: null,
                recipe: { recipe_id: 'r1', recipe_version_id: 'rv2', version_number: 2, title: 'Rice bowl' },
                amount: { servings: 1.5 },
                status: 'draft',
                confirmed_at: null,
                nutrition: { ...planned(550, 'partial', 1, 0), basis: 'live_calculation' },
              }),
              item('i-egg', { food: { food_id: 'f2', canonical_name: 'Egg' }, amount: { quantity: 2, unit: null, serving_id: 's1', serving_description: 'large egg' } }),
              item('i-old', { food: { food_id: 'f3', canonical_name: 'Banana' }, is_current: false, superseded_by_planned_meal_item_id: 'i-egg' }),
              item('i-cancel', { food: { food_id: 'f4', canonical_name: 'Juice' }, status: 'cancelled', is_current: false, confirmed_at: null }),
            ],
          },
        ],
      },
      { id: 'd2', plan_date: '2026-10-21', nutrition: nothingPlanned(), meals: [] },
    ],
    ...overrides,
  };
}

const detailRoutes = (dto: unknown = planDetail()) => ({ 'GET /v1/profiles': profiles, [`GET /v1/profiles/${PROFILE_A}/meal-plans/${PLAN}`]: () => json(200, dto) });

describe('Meal plan list', () => {
  it('lists plans with dates and status, pages with the cursor and opens one', async () => {
    const onOpen = jest.fn();
    const calls: Call[] = [];
    await renderApp(<MealPlansScreen onOpen={onOpen} />, {
      routes: {
        'GET /v1/profiles': profiles,
        'GET /v1/profiles/[^/]+/meal-plans': (call) => {
          calls.push(call);
          return new URL(call.url).searchParams.get('cursor') === 'c2'
            ? json(200, { data: [summary({ id: 'p0', name: 'September', start_date: '2026-09-01', end_date: '2026-09-07', status: 'archived' })], pagination: { nextCursor: null, limit: 20 } })
            : json(200, { data: [summary({ id: PLAN, name: 'October week', start_date: '2026-10-20', end_date: '2026-10-26', status: 'active' })], pagination: { nextCursor: 'c2', limit: 20 } });
        },
      },
    });
    expect(await screen.findByTestId(`plan-${PLAN}`)).toHaveTextContent(/October week.*2026-10-20 to 2026-10-26 · Active/);
    await fireEvent.press(screen.getByTestId('plans-more'));
    expect(await screen.findByTestId('plan-p0')).toHaveTextContent(/Archived/);
    expect(calls.map((c) => new URL(c.url).searchParams.get('cursor'))).toEqual([null, 'c2']);
    await fireEvent.press(screen.getByTestId(`plan-${PLAN}`));
    expect(onOpen).toHaveBeenCalledWith(PLAN);
  });

  it('shows an empty state', async () => {
    await renderApp(<MealPlansScreen onOpen={jest.fn()} />, {
      routes: { 'GET /v1/profiles': profiles, 'GET /v1/profiles/[^/]+/meal-plans': () => json(200, { data: [], pagination: { nextCursor: null, limit: 20 } }) },
    });
    expect(await screen.findByTestId('plans-empty')).toHaveTextContent('No meal plans yet.');
  });
});

describe('Meal plan detail', () => {
  it('shows days, meals with time and notes, and each item with its amount', async () => {
    await renderApp(<MealPlanScreen planId={PLAN} />, { routes: detailRoutes() });
    expect(await screen.findByTestId('plan-meta')).toHaveTextContent('2026-10-20 to 2026-10-21 · Active');
    expect(screen.getByTestId('planned-meal-m1')).toHaveTextContent(/Breakfast at 07:30.*Before the gym/);
    expect(screen.getByTestId('planned-item-i-oats')).toHaveTextContent(/Rolled oats · 60 g.*Confirmed/);
    expect(screen.getByTestId('planned-item-i-bowl')).toHaveTextContent(/Rice bowl · 1\.5 servings.*Draft/);
    expect(screen.getByTestId('planned-item-i-egg')).toHaveTextContent(/Egg · 2 × large egg/);
  });

  it('labels replaced and cancelled items as not counted', async () => {
    await renderApp(<MealPlanScreen planId={PLAN} />, { routes: detailRoutes() });
    expect(await screen.findByTestId('planned-item-state-i-old')).toHaveTextContent('Replaced, not counted in the totals');
    expect(screen.getByTestId('planned-item-state-i-cancel')).toHaveTextContent('Cancelled, not counted in the totals');
    expect(screen.getByTestId('planned-item-state-i-oats')).toHaveTextContent('Confirmed');
  });

  it('shows the server’s planned totals with coverage, and says when values are live', async () => {
    await renderApp(<MealPlanScreen planId={PLAN} />, { routes: detailRoutes() });
    expect(await screen.findByTestId('plan-unconfirmed')).toHaveTextContent(/calculated live/);
    expect(screen.getByTestId('day-energy-2026-10-20')).toHaveTextContent('Planned energy: 780 kcal (Partial: 2 of 3 items have data, so the total may be higher)');
    await fireEvent.press(screen.getByTestId('day-totals-2026-10-20-toggle'));
    expect(screen.getByTestId('day-totals-2026-10-20-amount-carbohydrate_g')).toHaveTextContent('Not available');
    expect(screen.getByTestId('day-totals-2026-10-20-amount-fiber_g')).toHaveTextContent('0 g');
  });

  it('says "Nothing planned" for an empty day instead of showing 0 kcal', async () => {
    await renderApp(<MealPlanScreen planId={PLAN} />, { routes: detailRoutes() });
    expect(await screen.findByTestId('day-energy-2026-10-21')).toHaveTextContent('Nothing planned');
    expect(screen.queryByTestId('day-totals-2026-10-21-toggle')).toBeNull();
  });

  it('has no live-value notice when every current item is confirmed, and no write actions', async () => {
    await renderApp(<MealPlanScreen planId={PLAN} />, { routes: detailRoutes(planDetail({ includes_unconfirmed: false })) });
    await screen.findByTestId('plan-meta');
    expect(screen.queryByTestId('plan-unconfirmed')).toBeNull();
    expect(screen.queryByText(/confirm plan|add item|edit/i)).toBeNull();
  });

  it('shows an error with a reference for a plan the API refuses', async () => {
    await renderApp(<MealPlanScreen planId={PLAN} />, {
      routes: { 'GET /v1/profiles': profiles, 'GET /v1/profiles/[^/]+/meal-plans/[^/]+': () => json(404, { error: { code: 'NOT_FOUND', message: 'x', requestId: 'req-404' } }) },
    });
    expect(await screen.findByTestId('error-state')).toHaveTextContent(/Reference: req-404/);
  });
});
