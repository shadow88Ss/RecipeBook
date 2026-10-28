// Layer 12F correction — USDA-backed Foods are shown by their display name
// (the Food's alias, sent by the server), never by the internal key
// `usda-fdc:<fdcId>`, on plan, grocery preview and shopping lines. The serving
// and quantities are unchanged; nothing is derived from the key. Values are
// invented test data.

import { screen } from '@testing-library/react-native';

import { isInternalFoodKey, readableFoodName } from '../src/features/food/foodName';
import { groceryItemName, ShoppingScreen } from '../src/features/grocery/ShoppingScreen';
import { MealPlanScreen } from '../src/features/plan/MealPlanScreen';
import { PROFILE_A, profileDto, profilePage, summaryEntry } from './helpers/fixtures';
import { json } from './helpers/fakeServer';
import { renderApp } from './helpers/renderApp';

const KEY = 'usda-fdc:169228';
const PLAN = 'eeeeeeee-0000-4000-8000-000000000001';
const LIST = 'ffffffff-0000-4000-8000-000000000001';
const profiles = () => json(200, profilePage([profileDto(PROFILE_A, 'Sam')]));

const planned = () => ({
  basis: 'planned_items',
  summary: Object.fromEntries(['energy_kcal', 'protein_g', 'carbohydrate_g', 'fat_g', 'fiber_g'].map((k) => [k, summaryEntry(k, 10, 'complete')])),
  item_count: 1,
});

const planItem = (id: string, food: object) => ({
  id,
  source_type: 'food',
  food,
  recipe: null,
  amount: { quantity: 1, unit: null, serving_id: 's1', serving_description: '1 cup, cubes' },
  status: 'confirmed',
  is_current: true,
  is_pending_replacement: false,
  superseded_by_planned_meal_item_id: null,
  nutrition: { ...planned(), basis: 'confirmed_snapshot' },
});

describe('Which food name is shown', () => {
  it('prefers the display name, hides internal keys, keeps readable names', () => {
    expect(isInternalFoodKey(KEY)).toBe(true);
    expect(isInternalFoodKey('fixture rice')).toBe(false);
    expect(readableFoodName('Papayas, raw', KEY, 'Food')).toBe('Papayas, raw');
    expect(readableFoodName(null, KEY, 'Food')).toBe('Food');
    expect(readableFoodName(undefined, 'Basmati rice', 'Food')).toBe('Basmati rice');
    // A line without a Food keeps its own text, even if it has a colon.
    expect(groceryItemName({ display_name: 'note:pinch', food: null })).toBe('note:pinch');
  });

  it('a plan line shows the alias with the serving, never the USDA key', async () => {
    await renderApp(<MealPlanScreen planId={PLAN} />, {
      routes: {
        'GET /v1/profiles': profiles,
        [`GET /v1/profiles/${PROFILE_A}/meal-plans/${PLAN}`]: () =>
          json(200, {
            id: PLAN,
            name: 'Week',
            description: null,
            start_date: '2026-10-28',
            end_date: '2026-10-28',
            local_timezone: 'Asia/Dubai',
            status: 'active',
            current_item_count: 2,
            includes_unconfirmed: false,
            days: [
              {
                id: 'd1',
                plan_date: '2026-10-28',
                nutrition: planned(),
                meals: [
                  {
                    id: 'm1',
                    meal_type: 'breakfast',
                    scheduled_local_time: null,
                    notes: null,
                    nutrition: planned(),
                    items: [
                      planItem('i1', { food_id: 'f1', canonical_name: KEY, display_name: 'Papayas, raw' }),
                      planItem('i2', { food_id: 'f2', canonical_name: 'usda-fdc:999', display_name: null }),
                    ],
                  },
                ],
              },
            ],
          }),
      },
    });
    expect(await screen.findByTestId('planned-item-i1')).toHaveTextContent(/Papayas, raw · 1 × 1 cup, cubes/);
    expect(screen.getByTestId('planned-item-i2')).toHaveTextContent(/^Food · 1 × 1 cup, cubes/);
    expect(screen.queryByText(/usda-fdc/)).toBeNull();
  });

  it('a shopping line shows the alias; quantities stay the server’s', async () => {
    const progress = {
      shopping_target: { quantity: 140, unit: 'g' },
      shopping_target_source: 'generated',
      purchased: { quantity: null, unit: null, checked_off: false },
      remaining_to_purchase: { quantity: 140, unit: 'g' },
      over_purchased: null,
      status: 'need_to_buy',
      purchase_mode: 'quantity',
    };
    await renderApp(<ShoppingScreen listId={LIST} />, {
      routes: {
        'GET /v1/profiles': profiles,
        [`GET /v1/profiles/${PROFILE_A}/grocery-lists/${LIST}/shopping`]: () =>
          json(200, {
            grocery_list: {
              id: LIST,
              meal_plan_id: PLAN,
              generation_number: 1,
              status: 'active',
              is_current_generation: true,
              superseded_by_grocery_list_id: null,
              is_stale: false,
              generated_at: '2026-10-28T08:00:00Z',
              plan_context: { start_date: '2026-10-28', end_date: '2026-10-28' },
              current_plan_status: 'active',
            },
            state_writable: true,
            items: [
              {
                grocery_list_item_id: 'g1',
                display_name: KEY,
                food: { food_id: 'f1', canonical_name: KEY, display_name: 'Papayas, raw' },
                generation_resolution_status: 'resolved',
                generation_unresolved_reason: null,
                generated_quantity: { quantity: 140, quantity_exact: '140', unit: 'g' },
                already_have: null,
                ...progress,
                history: { purchases: [] },
              },
            ],
            manual_items: [],
          }),
      },
    });
    expect(await screen.findByTestId('shopping-item-g1-name')).toHaveTextContent('Papayas, raw');
    expect(screen.getByTestId('shopping-item-g1-plan')).toHaveTextContent('Plan needs 140 g');
    expect(screen.queryByText(/usda-fdc/)).toBeNull();
  });
});
