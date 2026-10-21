// Layer 12F — a plan's grocery list against a scripted API (docs/30_API.md
// §23): the server's preview is shown as it is (an unworked-out amount says
// so); a draft plan only previews; an active plan makes a list with an empty
// POST and opens it; only scopes that can plan may make one. Values are
// invented test data.

import { fireEvent, screen, waitFor } from '@testing-library/react-native';

import { MealPlanScreen } from '../src/features/plan/MealPlanScreen';
import { PROFILE_A, profileDto, profilePage } from './helpers/fixtures';
import { json, type Call } from './helpers/fakeServer';
import { renderApp } from './helpers/renderApp';

const PLAN = 'eeeeeeee-0000-4000-8000-000000000001';
const PLANS = `/v1/profiles/${PROFILE_A}/meal-plans`;
const profiles = (scope = 'full_management') => () => json(200, profilePage([profileDto(PROFILE_A, 'Sam', scope)]));

const plan = (status: string) => ({
  id: PLAN,
  name: 'Test week',
  description: null,
  start_date: '2026-10-21',
  end_date: '2026-10-21',
  local_timezone: 'Asia/Dubai',
  status,
  current_item_count: 0,
  includes_unconfirmed: false,
  days: [],
});

const preview = (o: { type?: string; current?: object | null; excluded?: number } = {}) => ({
  preview_type: o.type ?? 'active_plan_preview',
  persisted: false,
  includes_unconfirmed: o.type === 'unconfirmed_plan_preview',
  meal_plan_id: PLAN,
  current_grocery_list: o.current ?? null,
  excluded_unconfirmed_sources: Array.from({ length: o.excluded ?? 0 }, (_, i) => ({ planned_meal_item_id: `x${i}`, reason: 'unconfirmed' })),
  excluded_skipped_sources: [],
  items: [
    { display_name: 'Rolled oats', quantity: 80, quantity_exact: '80', unit: 'g', resolution_status: 'resolved', unresolved_reason: null, sources: [] },
    { display_name: 'pinch of cinnamon', quantity: null, quantity_exact: null, unit: null, resolution_status: 'unresolved_food', unresolved_reason: 'unmatched_ingredient', sources: [] },
  ],
});

function routes(status: string, previewDto: object, extra: Record<string, (call: Call) => Response> = {}, scope = 'full_management') {
  return {
    'GET /v1/profiles': profiles(scope),
    [`GET ${PLANS}/${PLAN}`]: () => json(200, plan(status)),
    [`GET ${PLANS}/${PLAN}/grocery-preview`]: () => json(200, previewDto),
    ...extra,
  };
}

async function openGrocery() {
  await fireEvent.press(await screen.findByTestId('plan-grocery-toggle'));
}

describe('Plan grocery list', () => {
  it('previews a draft plan with the server’s amounts, and cannot make a list yet', async () => {
    await renderApp(<MealPlanScreen planId={PLAN} onAddItem={jest.fn()} onOpenList={jest.fn()} />, { routes: routes('draft', preview({ type: 'unconfirmed_plan_preview' })) });
    await openGrocery();
    expect(await screen.findByTestId('grocery-draft-note')).toHaveTextContent(/Confirm the plan to make a shopping list/);
    expect(screen.getByTestId('grocery-req-0')).toHaveTextContent(/Rolled oats.*80 g/);
    expect(screen.getByTestId('grocery-req-1')).toHaveTextContent(/pinch of cinnamon.*could not be worked out/);
    expect(screen.queryByTestId('grocery-generate')).toBeNull();
  });

  it('makes a list from an active plan with an empty body and opens it', async () => {
    const posted: Call[] = [];
    const onOpenList = jest.fn();
    await renderApp(<MealPlanScreen planId={PLAN} onAddItem={jest.fn()} onOpenList={onOpenList} />, {
      routes: routes('active', preview({ excluded: 1 }), {
        [`POST ${PLANS}/${PLAN}/grocery-lists`]: (call) => {
          posted.push(call);
          return json(201, { id: 'list-1', generation_number: 1, items: [] });
        },
      }),
    });
    await openGrocery();
    expect(await screen.findByTestId('grocery-excluded')).toHaveTextContent('1 item is not confirmed, so it is not included.');
    await fireEvent.press(screen.getByTestId('grocery-generate'));
    await waitFor(() => expect(onOpenList).toHaveBeenCalledWith('list-1'));
    expect(posted[0]!.body).toEqual({});
  });

  it('opens the current list, and offers a new version only when it is out of date', async () => {
    const onOpenList = jest.fn();
    await renderApp(<MealPlanScreen planId={PLAN} onAddItem={jest.fn()} onOpenList={onOpenList} />, {
      routes: routes('active', preview({ current: { id: 'list-2', generation_number: 2, is_stale: false } })),
    });
    await openGrocery();
    expect(await screen.findByTestId('grocery-current')).toHaveTextContent(/List version 2/);
    expect(screen.queryByTestId('grocery-generate')).toBeNull();
    await fireEvent.press(screen.getByTestId('grocery-open'));
    expect(onOpenList).toHaveBeenCalledWith('list-2');
  });

  it('says a stale list may be out of date and offers a new version', async () => {
    await renderApp(<MealPlanScreen planId={PLAN} onAddItem={jest.fn()} onOpenList={jest.fn()} />, {
      routes: routes('active', preview({ current: { id: 'list-2', generation_number: 2, is_stale: true } })),
    });
    await openGrocery();
    expect(await screen.findByTestId('grocery-current-stale')).toBeTruthy();
    expect(screen.getByTestId('grocery-generate')).toHaveTextContent('Make a new version of the list');
  });

  it('view_only can open the list but not make one', async () => {
    await renderApp(<MealPlanScreen planId={PLAN} onOpenList={jest.fn()} />, {
      routes: routes('active', preview({ current: { id: 'list-2', generation_number: 2, is_stale: true } }), {}, 'view_only'),
    });
    await openGrocery();
    expect(await screen.findByTestId('grocery-open')).toBeTruthy();
    expect(screen.queryByTestId('grocery-generate')).toBeNull();
  });

  it('shows the server’s refusal', async () => {
    await renderApp(<MealPlanScreen planId={PLAN} onAddItem={jest.fn()} onOpenList={jest.fn()} />, {
      routes: routes('active', preview(), {
        [`POST ${PLANS}/${PLAN}/grocery-lists`]: () => json(400, { error: { code: 'VALIDATION_ERROR', message: 'x', requestId: 'req-400' } }),
      }),
    });
    await openGrocery();
    await fireEvent.press(await screen.findByTestId('grocery-generate'));
    expect(await screen.findByTestId('grocery-generate-error')).toBeTruthy();
  });

  it('has no grocery section on a completed plan (its lists stay under Grocery list)', async () => {
    await renderApp(<MealPlanScreen planId={PLAN} onOpenList={jest.fn()} />, { routes: routes('completed', preview()) });
    await screen.findByTestId('plan-meta');
    expect(screen.queryByTestId('plan-grocery')).toBeNull();
  });
});
