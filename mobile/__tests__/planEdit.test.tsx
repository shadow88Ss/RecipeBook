// Layer 12E — creating and filling in meal plans against a scripted API
// (docs/30_API.md §21). The app sends only planning facts (dates, meal type,
// a Food amount or servings of an exact RecipeVersion), never nutrition or a
// status the server owns; confirmation is the server's, behind a second tap;
// and only scopes that can plan get write controls. Values are invented.

import { fireEvent, screen, waitFor } from '@testing-library/react-native';

import { MealPlanCreateScreen, planDatesError } from '../src/features/plan/MealPlanCreateScreen';
import { MealPlanScreen, missingDates } from '../src/features/plan/MealPlanScreen';
import { MealPlansScreen } from '../src/features/plan/MealPlansScreen';
import { PlanItemScreen } from '../src/features/plan/PlanItemScreen';
import { RecipesScreen } from '../src/features/recipes/RecipesScreen';
import { PROFILE_A, profileDto, profilePage, summaryEntry } from './helpers/fixtures';
import { json, type Call } from './helpers/fakeServer';
import { renderApp } from './helpers/renderApp';

const PLAN = 'eeeeeeee-0000-4000-8000-000000000001';
const OATS = 'eeeeeeee-0000-4000-8000-0000000000f1';
const OATS_SERVING = 'eeeeeeee-0000-4000-8000-0000000000s1';
const RECIPE = 'eeeeeeee-0000-4000-8000-0000000000r1';
const VERSION_2 = 'eeeeeeee-0000-4000-8000-0000000000v2';
const PLANS = `/v1/profiles/${PROFILE_A}/meal-plans`;
const profiles = (scope = 'full_management') => () => json(200, profilePage([profileDto(PROFILE_A, 'Sam', scope)]));

const planned = (count: number) => ({
  basis: count ? 'planned_items' : 'no_planned_items',
  summary: {
    energy_kcal: summaryEntry('energy', count ? 300 : 0, 'complete', count, count),
    protein_g: summaryEntry('protein', 10, 'complete', count, count),
    carbohydrate_g: summaryEntry('carbohydrate', 50, 'complete', count, count),
    fat_g: summaryEntry('fat', 5, 'complete', count, count),
    fiber_g: summaryEntry('fiber', 8, 'complete', count, count),
  },
  item_count: count,
});

const item = (id: string, status: string) => ({
  id,
  source_type: 'food',
  food: { food_id: OATS, canonical_name: 'Rolled oats' },
  recipe: null,
  amount: { quantity: 80, unit: 'g', serving_id: null, serving_description: null },
  status,
  is_current: status !== 'cancelled',
  is_pending_replacement: false,
  superseded_by_planned_meal_item_id: null,
  nutrition: { ...planned(1), basis: status === 'confirmed' ? 'confirmed_snapshot' : 'live_calculation' },
});

function plan(o: { status?: string; days?: object[] } = {}) {
  return {
    id: PLAN,
    name: 'Test week',
    description: null,
    start_date: '2026-10-21',
    end_date: '2026-10-23',
    local_timezone: 'Asia/Dubai',
    status: o.status ?? 'draft',
    current_item_count: 0,
    includes_unconfirmed: false,
    days: o.days ?? [],
  };
}

const dayWith = (items: object[]) => ({
  id: 'd1',
  plan_date: '2026-10-21',
  nutrition: planned(items.length),
  meals: [{ id: 'm1', meal_type: 'breakfast', scheduled_local_time: null, notes: null, items, nutrition: planned(items.length) }],
});

describe('Who can plan', () => {
  it('view_only gets no New meal plan, no plan controls and a read-only form', async () => {
    await renderApp(
      <>
        <MealPlansScreen onOpen={jest.fn()} onNew={jest.fn()} />
        <MealPlanScreen planId={PLAN} onAddItem={jest.fn()} />
        <MealPlanCreateScreen onCreated={jest.fn()} />
        <PlanItemScreen planId={PLAN} mealId="m1" onDone={jest.fn()} />
      </>,
      {
        routes: {
          'GET /v1/profiles': profiles('view_only'),
          [`GET ${PLANS}`]: () => json(200, { data: [], pagination: { nextCursor: null, limit: 20 } }),
          [`GET ${PLANS}/${PLAN}`]: () => json(200, plan({ days: [dayWith([item('i1', 'draft')])] })),
        },
      },
    );
    expect(await screen.findByTestId('plan-new-read-only')).toBeTruthy();
    expect(screen.getByTestId('plan-item-read-only')).toBeTruthy();
    await screen.findByTestId('planned-item-i1');
    expect(screen.queryByTestId('new-plan')).toBeNull();
    expect(screen.queryByTestId('plan-add-day')).toBeNull();
    expect(screen.queryByTestId('add-item-m1')).toBeNull();
    expect(screen.queryByTestId('cancel-item-i1')).toBeNull();
    expect(screen.queryByTestId('plan-confirm')).toBeNull();
  });

  it('pediatric_weight_management can plan', async () => {
    await renderApp(
      <>
        <MealPlansScreen onOpen={jest.fn()} onNew={jest.fn()} />
        <MealPlanScreen planId={PLAN} onAddItem={jest.fn()} />
      </>,
      {
        routes: {
          'GET /v1/profiles': profiles('pediatric_weight_management'),
          [`GET ${PLANS}`]: () => json(200, { data: [], pagination: { nextCursor: null, limit: 20 } }),
          [`GET ${PLANS}/${PLAN}`]: () => json(200, plan({ days: [dayWith([item('i1', 'draft')])] })),
        },
      },
    );
    expect(await screen.findByTestId('new-plan')).toBeTruthy();
    expect(await screen.findByTestId('add-item-m1')).toBeTruthy();
    expect(screen.getByTestId('cancel-item-i1')).toBeTruthy();
  });

  it('a completed plan has no write controls', async () => {
    await renderApp(<MealPlanScreen planId={PLAN} onAddItem={jest.fn()} />, {
      routes: { 'GET /v1/profiles': profiles(), [`GET ${PLANS}/${PLAN}`]: () => json(200, plan({ status: 'completed', days: [dayWith([item('i1', 'confirmed')])] })) },
    });
    await screen.findByTestId('planned-item-i1');
    expect(screen.queryByTestId('add-item-m1')).toBeNull();
    expect(screen.queryByTestId('plan-add-day')).toBeNull();
  });
});

describe('Create a plan', () => {
  it('sends the name, the typed dates and the device time zone, then opens the plan', async () => {
    const posted: Call[] = [];
    const onCreated = jest.fn();
    await renderApp(<MealPlanCreateScreen onCreated={onCreated} now={() => new Date('2026-10-21T08:00:00Z')} timeZone="Asia/Dubai" />, {
      routes: {
        'GET /v1/profiles': profiles(),
        [`POST ${PLANS}`]: (call) => {
          posted.push(call);
          return json(201, plan());
        },
      },
    });
    expect(await screen.findByTestId('plan-start')).toHaveProp('value', '2026-10-21');
    expect(screen.getByTestId('plan-end')).toHaveProp('value', '2026-10-27');
    await fireEvent.changeText(screen.getByTestId('plan-name'), ' Test week ');
    await fireEvent.changeText(screen.getByTestId('plan-end'), '2026-10-23');
    await fireEvent.press(screen.getByTestId('plan-create'));
    await waitFor(() => expect(onCreated).toHaveBeenCalledWith(PLAN));
    expect(posted[0]!.body).toEqual({ name: 'Test week', description: null, start_date: '2026-10-21', end_date: '2026-10-23', local_timezone: 'Asia/Dubai' });
  });

  it('checks the name and dates before sending anything', async () => {
    const posted: Call[] = [];
    await renderApp(<MealPlanCreateScreen onCreated={jest.fn()} timeZone="Asia/Dubai" />, {
      routes: { 'GET /v1/profiles': profiles(), [`POST ${PLANS}`]: (call) => (posted.push(call), json(201, plan())) },
    });
    await fireEvent.changeText(await screen.findByTestId('plan-name'), 'Week');
    await fireEvent.changeText(screen.getByTestId('plan-start'), '2026-10-25');
    await fireEvent.changeText(screen.getByTestId('plan-end'), '2026-10-21');
    await fireEvent.press(screen.getByTestId('plan-create'));
    expect(screen.getByTestId('plan-dates-error')).toHaveTextContent('The last day cannot be before the first day.');
    expect(posted).toHaveLength(0);
  });

  it('applies the API date rules', () => {
    expect(planDatesError('2026-10-21', '2026-10-21')).toBeNull();
    expect(planDatesError('2026-02-30', '2026-03-01')).toBe('start');
    expect(planDatesError('2026-10-21', '21/10/2026')).toBe('end');
    expect(planDatesError('2026-01-01', '2026-12-31')).toBeNull();
    expect(planDatesError('2026-01-01', '2027-01-01')).toBeNull();
    expect(planDatesError('2026-01-01', '2027-01-02')).toBe('length');
  });
});

describe('Days and meals', () => {
  it('offers only the plan’s dates that have no day yet, and adds the one chosen', async () => {
    expect(missingDates({ start_date: '2026-10-30', end_date: '2026-11-02', days: [{ plan_date: '2026-10-31' }] as never })).toEqual(['2026-10-30', '2026-11-01', '2026-11-02']);
    const posted: Call[] = [];
    await renderApp(<MealPlanScreen planId={PLAN} onAddItem={jest.fn()} />, {
      routes: {
        'GET /v1/profiles': profiles(),
        [`GET ${PLANS}/${PLAN}`]: () => json(200, plan({ days: [dayWith([])] })),
        [`POST ${PLANS}/${PLAN}/days`]: (call) => {
          posted.push(call);
          return json(201, plan({ days: [dayWith([]), { id: 'd2', plan_date: '2026-10-22', nutrition: planned(0), meals: [] }] }));
        },
      },
    });
    await screen.findByTestId('plan-add-day');
    expect(screen.queryByTestId('add-day-2026-10-21')).toBeNull();
    await fireEvent.press(screen.getByTestId('add-day-2026-10-22'));
    expect(await screen.findByTestId('plan-day-2026-10-22')).toHaveTextContent(/Nothing planned/);
    expect(posted[0]!.body).toEqual({ plan_date: '2026-10-22' });
  });

  it('adds a meal with its type and optional time, and no items', async () => {
    const posted: Call[] = [];
    await renderApp(<MealPlanScreen planId={PLAN} onAddItem={jest.fn()} />, {
      routes: {
        'GET /v1/profiles': profiles(),
        [`GET ${PLANS}/${PLAN}`]: () => json(200, plan({ days: [{ ...dayWith([]), meals: [] }] })),
        [`POST ${PLANS}/${PLAN}/days/d1/meals`]: (call) => {
          posted.push(call);
          return json(201, plan({ days: [dayWith([])] }));
        },
      },
    });
    await fireEvent.press(await screen.findByTestId('add-meal-2026-10-21'));
    await fireEvent.press(screen.getByTestId('meal-type-dinner'));
    await fireEvent.changeText(screen.getByTestId('meal-time'), '7pm');
    await fireEvent.press(screen.getByTestId('meal-save'));
    expect(posted).toHaveLength(0);
    await fireEvent.changeText(screen.getByTestId('meal-time'), '19:30');
    await fireEvent.press(screen.getByTestId('meal-save'));
    await screen.findByTestId('planned-meal-m1');
    expect(posted[0]!.body).toEqual({ meal_type: 'dinner', scheduled_local_time: '19:30', items: [] });
  });
});

describe('Adding items', () => {
  const foods = {
    'GET /v1/foods': () => json(200, { data: [{ id: OATS, canonical_name: 'oats', category: null, display_name: 'Rolled oats', match: { identity_confirmation_required: false } }], pagination: { nextCursor: null, limit: 20 } }),
    [`GET /v1/foods/${OATS}`]: () => json(200, { id: OATS, canonical_name: 'oats', category: null, display_name: 'Rolled oats', servings: [{ id: OATS_SERVING, serving_description: 'cup', canonical_quantity: 80, canonical_unit: 'g' }] }),
    'GET /v1/units': () => json(200, { data: [{ code: 'g', dimension: 'mass', label: 'g' }] }),
  };

  async function pickOats() {
    await fireEvent.changeText(await screen.findByTestId('ingredient-food-search'), 'oats');
    await fireEvent.press(screen.getByTestId('ingredient-food-search-submit'));
    await fireEvent.press(await screen.findByTestId(`pick-food-${OATS}`));
  }

  it.each([
    ['a serving', null, { type: 'food', food_id: OATS, quantity: 1.5, serving_id: OATS_SERVING }],
    ['a unit', 'g', { type: 'food', food_id: OATS, quantity: 1.5, unit: 'g' }],
  ])('sends a Food with %s and nothing else', async (_label, unit, expected) => {
    const posted: Call[] = [];
    const onDone = jest.fn();
    await renderApp(<PlanItemScreen planId={PLAN} mealId="m1" onDone={onDone} />, {
      routes: {
        'GET /v1/profiles': profiles(),
        ...foods,
        [`POST ${PLANS}/${PLAN}/meals/m1/items`]: (call) => {
          posted.push(call);
          return json(201, plan({ days: [dayWith([item('i1', 'draft')])] }));
        },
      },
    });
    await pickOats();
    if (unit) {
      await fireEvent.press(await screen.findByTestId('ing-mode-unit'));
      await fireEvent.press(await screen.findByTestId(`ing-unit-${unit}`));
    }
    await fireEvent.press(await screen.findByTestId('plan-item-add'));
    expect(posted).toHaveLength(0);
    await fireEvent.changeText(screen.getByTestId('ingredient-quantity'), '1,5');
    await fireEvent.press(screen.getByTestId('plan-item-add'));
    await waitFor(() => expect(onDone).toHaveBeenCalled());
    expect(posted[0]!.body).toEqual({ items: [expected] });
  });

  const recipeRoutes = (servings: number | null) => ({
    [`GET /v1/profiles/${PROFILE_A}/recipes`]: () => json(200, { data: [{ id: RECIPE, title: 'Test oatmeal', current_version_number: 2, servings, updated_at: '2026-10-21T00:00:00Z' }], pagination: { nextCursor: null, limit: 20 } }),
    [`GET /v1/profiles/${PROFILE_A}/recipes/${RECIPE}`]: () =>
      json(200, {
        id: RECIPE,
        title: 'Test oatmeal',
        updated_at: '2026-10-21T00:00:00Z',
        version_count: 2,
        current_version: { id: VERSION_2, version_number: 2, is_current: true, title: 'Test oatmeal', description: null, servings, ingredients: [], instructions: [] },
      }),
  });

  it('sends servings of the recipe’s exact current version', async () => {
    const posted: Call[] = [];
    await renderApp(<PlanItemScreen planId={PLAN} mealId="m1" onDone={jest.fn()} />, {
      routes: {
        'GET /v1/profiles': profiles(),
        ...recipeRoutes(2),
        [`POST ${PLANS}/${PLAN}/meals/m1/items`]: (call) => (posted.push(call), json(201, plan())),
      },
    });
    await fireEvent.press(await screen.findByTestId('source-recipe'));
    await fireEvent.press(await screen.findByTestId(`pick-recipe-${RECIPE}`));
    expect(await screen.findByTestId('plan-recipe-version')).toHaveTextContent(/Version 2 · Makes 2 servings/);
    await fireEvent.changeText(screen.getByTestId('plan-recipe-servings'), '101');
    await fireEvent.press(screen.getByTestId('plan-item-add'));
    expect(posted).toHaveLength(0);
    await fireEvent.changeText(screen.getByTestId('plan-recipe-servings'), '0.5');
    await fireEvent.press(screen.getByTestId('plan-item-add'));
    await waitFor(() => expect(posted).toHaveLength(1));
    expect(posted[0]!.body).toEqual({ items: [{ type: 'recipe', recipe_id: RECIPE, recipe_version_id: VERSION_2, servings: 0.5 }] });
  });

  it('does not offer a recipe without a yield', async () => {
    await renderApp(<PlanItemScreen planId={PLAN} mealId="m1" onDone={jest.fn()} />, { routes: { 'GET /v1/profiles': profiles(), ...recipeRoutes(null) } });
    await fireEvent.press(await screen.findByTestId('source-recipe'));
    await fireEvent.press(await screen.findByTestId(`pick-recipe-${RECIPE}`));
    expect(await screen.findByTestId('plan-recipe-no-yield')).toBeTruthy();
    expect(screen.queryByTestId('plan-item-add')).toBeNull();
  });

  it('shares the Recipes list cache without breaking (phone bug in the first 12E build)', async () => {
    await renderApp(
      <>
        <RecipesScreen onOpen={jest.fn()} />
        <PlanItemScreen planId={PLAN} mealId="m1" onDone={jest.fn()} />
      </>,
      { routes: { 'GET /v1/profiles': profiles(), ...recipeRoutes(2) } },
    );
    await screen.findByTestId(`recipe-${RECIPE}`);
    await fireEvent.press(screen.getByTestId('source-recipe'));
    await fireEvent.press(await screen.findByTestId(`pick-recipe-${RECIPE}`));
    expect(await screen.findByTestId('plan-recipe-version')).toBeTruthy();
  });

  it('shows the server’s refusal', async () => {
    await renderApp(<PlanItemScreen planId={PLAN} mealId="m1" onDone={jest.fn()} />, {
      routes: {
        'GET /v1/profiles': profiles(),
        ...recipeRoutes(2),
        [`POST ${PLANS}/${PLAN}/meals/m1/items`]: () => json(409, { error: { code: 'CONFLICT', message: 'x', requestId: 'req-409' } }),
      },
    });
    await fireEvent.press(await screen.findByTestId('source-recipe'));
    await fireEvent.press(await screen.findByTestId(`pick-recipe-${RECIPE}`));
    await fireEvent.press(await screen.findByTestId('plan-item-add'));
    expect(await screen.findByTestId('plan-item-error')).toHaveTextContent(/changed somewhere else/);
  });
});

describe('Removing and confirming', () => {
  it('cancels a draft item (status only) and re-reads the plan; confirmed items have no Remove', async () => {
    const patched: Call[] = [];
    let cancelled = false;
    await renderApp(<MealPlanScreen planId={PLAN} onAddItem={jest.fn()} />, {
      routes: {
        'GET /v1/profiles': profiles(),
        [`GET ${PLANS}/${PLAN}`]: () => json(200, plan({ status: 'active', days: [dayWith([item('i1', cancelled ? 'cancelled' : 'draft'), item('i2', 'confirmed')])] })),
        [`PATCH ${PLANS}/${PLAN}/items/i1`]: (call) => {
          patched.push(call);
          cancelled = true;
          return json(200, { id: 'i1', status: 'cancelled' });
        },
      },
    });
    expect(await screen.findByTestId('cancel-item-i1')).toBeTruthy();
    expect(screen.queryByTestId('cancel-item-i2')).toBeNull();
    await fireEvent.press(screen.getByTestId('cancel-item-i1'));
    expect(await screen.findByText('Cancelled, not counted in the totals')).toBeTruthy();
    expect(patched[0]!.body).toEqual({ status: 'cancelled' });
    expect(screen.queryByTestId('cancel-item-i1')).toBeNull();
  });

  it('confirms only after a second tap, with an empty body, and shows the server’s result', async () => {
    const posted: Call[] = [];
    await renderApp(<MealPlanScreen planId={PLAN} onAddItem={jest.fn()} />, {
      routes: {
        'GET /v1/profiles': profiles(),
        [`GET ${PLANS}/${PLAN}`]: () => json(200, plan({ days: [dayWith([item('i1', 'draft'), item('i2', 'planned')])] })),
        [`POST ${PLANS}/${PLAN}/confirm`]: (call) => {
          posted.push(call);
          return json(200, plan({ status: 'active', days: [dayWith([item('i1', 'confirmed'), item('i2', 'confirmed')])] }));
        },
      },
    });
    expect(await screen.findByTestId('plan-confirm')).toHaveTextContent(/2 items are not confirmed yet/);
    await fireEvent.press(screen.getByTestId('plan-confirm-start'));
    expect(screen.getByTestId('plan-confirm-warning')).toHaveTextContent(/cannot be changed or removed/);
    expect(posted).toHaveLength(0);
    await fireEvent.press(screen.getByTestId('plan-confirm-yes'));
    await waitFor(() => expect(screen.getByTestId('plan-meta')).toHaveTextContent(/Active/));
    expect(posted[0]!.body).toEqual({});
    expect(screen.queryByTestId('plan-confirm')).toBeNull();
    expect(screen.getByTestId('planned-item-state-i1')).toHaveTextContent('Confirmed');
  });
});
