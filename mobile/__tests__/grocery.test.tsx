// Layer 12C — grocery lists and shopping against a scripted API
// (docs/30_API.md §23–24). The app shows the server's amounts and statuses,
// sends the server's own remaining amount back as a purchase (no arithmetic),
// checks off items with no quantity, undoes by revoking, and shows write
// buttons only when the server says the list is writable AND the scope can
// record shopping. Values are invented test data.

import { fireEvent, screen } from '@testing-library/react-native';

import { GroceryListsScreen } from '../src/features/grocery/GroceryListsScreen';
import { ShoppingScreen } from '../src/features/grocery/ShoppingScreen';
import { PROFILE_A, profileDto, profilePage } from './helpers/fixtures';
import { json, type Call } from './helpers/fakeServer';
import { renderApp } from './helpers/renderApp';

const LIST = 'ffffffff-0000-4000-8000-000000000001';
const RICE = 'ffffffff-0000-4000-8000-0000000000a1';
const SALT = 'ffffffff-0000-4000-8000-0000000000a2';
const NAPKINS = 'ffffffff-0000-4000-8000-0000000000m1';
const BASE = `/v1/profiles/${PROFILE_A}/grocery-lists/${LIST}`;
const profiles = (scope = 'full_management') => () => json(200, profilePage([profileDto(PROFILE_A, 'Sam', scope)]));

const listSummary = (id: string, generation: number, status: string) => ({
  id,
  profile_id: PROFILE_A,
  meal_plan_id: 'plan-1',
  generation_number: generation,
  status,
  generated_at: '2026-10-20T08:00:00Z',
  plan_context: { status_at_generation: 'active', start_date: '2026-10-20', end_date: '2026-10-26', local_timezone: 'Asia/Dubai' },
});

const progress = (o: Record<string, unknown>) => ({
  shopping_target: null,
  shopping_target_source: null,
  purchased: { quantity: null, unit: null, counted_purchase_ids: [], not_counted: [], checked_off: false },
  remaining_to_purchase: null,
  over_purchased: null,
  status: 'need_to_buy',
  purchase_mode: 'quantity',
  ...o,
});

const purchase = (id: string, at: string, revoked: string | null = null) => ({ id, quantity: 100, unit: 'g', note: null, recorded_at: at, revoked_at: revoked });

function shopping(o: { rice?: Record<string, unknown>; writable?: boolean; list?: Record<string, unknown> } = {}) {
  return {
    grocery_list: { ...listSummary(LIST, 2, 'active'), is_current_generation: true, superseded_by_grocery_list_id: null, is_stale: false, current_plan_status: 'active', calculation_version: 'x', ...o.list },
    rules_version: 'grocery-shopping-9b.1',
    state_writable: o.writable ?? true,
    carry_forward: 'none',
    summary: {},
    items: [
      {
        grocery_list_item_id: RICE,
        position: 1,
        food: { food_id: 'f1', canonical_name: 'Rice' },
        display_name: 'Rice',
        generation_resolution_status: 'resolved',
        generation_unresolved_reason: null,
        generated_quantity: { quantity: 300, quantity_exact: '300', unit: 'g' },
        already_have: null,
        derived_need: { quantity: 300, unit: 'g' },
        already_have_surplus: null,
        shopping_adjustment: null,
        ...progress({ shopping_target: { quantity: 300, unit: 'g' }, remaining_to_purchase: { quantity: 300, unit: 'g' } }),
        history: { already_have: [], shopping_adjustments: [], purchases: [] },
        ...o.rice,
      },
      {
        grocery_list_item_id: SALT,
        position: 2,
        food: null,
        display_name: 'salt to taste',
        generation_resolution_status: 'unresolved_quantity',
        generation_unresolved_reason: 'no_quantity',
        generated_quantity: null,
        already_have: null,
        derived_need: null,
        already_have_surplus: null,
        shopping_adjustment: null,
        ...progress({ status: 'comparison_unresolved', purchase_mode: 'check_off' }),
        history: { already_have: [], shopping_adjustments: [], purchases: [] },
      },
    ],
    manual_items: [
      {
        grocery_manual_item_id: NAPKINS,
        source: 'manual',
        name: 'Napkins',
        food: null,
        notes: 'the big pack',
        input: { quantity: null, unit: null },
        ...progress({ status: 'need_to_buy', purchase_mode: 'check_off' }),
        purchases: [],
        created_at: '2026-10-20T09:00:00Z',
        revoked_at: null,
      },
    ],
    removed_manual_items: [],
  };
}

describe('Grocery lists', () => {
  it('lists every generation with its plan dates, and labels a replaced one', async () => {
    const onOpen = jest.fn();
    await renderApp(<GroceryListsScreen onOpen={onOpen} />, {
      routes: {
        'GET /v1/profiles': profiles(),
        'GET /v1/profiles/[^/]+/grocery-lists': () => json(200, { data: [listSummary(LIST, 2, 'active'), listSummary('old', 1, 'superseded')], pagination: { nextCursor: null, limit: 20 } }),
      },
    });
    expect(await screen.findByTestId(`grocery-list-${LIST}`)).toHaveTextContent(/Groceries for 2026-10-20 to 2026-10-26.*List version 2$/);
    expect(screen.getByTestId('grocery-list-old')).toHaveTextContent(/List version 1 · Replaced by a newer version/);
    await fireEvent.press(screen.getByTestId(`grocery-list-${LIST}`));
    expect(onOpen).toHaveBeenCalledWith(LIST);
  });

  it('explains an empty state', async () => {
    await renderApp(<GroceryListsScreen onOpen={jest.fn()} />, {
      routes: { 'GET /v1/profiles': profiles(), 'GET /v1/profiles/[^/]+/grocery-lists': () => json(200, { data: [], pagination: { nextCursor: null, limit: 20 } }) },
    });
    expect(await screen.findByTestId('grocery-empty')).toHaveTextContent(/made from a confirmed meal plan/);
  });
});

describe('Shopping', () => {
  it('shows each item’s plan amount and status, and an unresolved amount in words', async () => {
    await renderApp(<ShoppingScreen listId={LIST} />, { routes: { 'GET /v1/profiles': profiles(), [`GET ${BASE}/shopping`]: () => json(200, shopping()) } });
    expect(await screen.findByTestId(`shopping-item-${RICE}-plan`)).toHaveTextContent('Plan needs 300 g');
    expect(screen.getByTestId(`shopping-item-${RICE}-status`)).toHaveTextContent('Need to buy');
    expect(screen.getByTestId(`shopping-item-${SALT}-plan`)).toHaveTextContent('The amount could not be worked out from the plan');
    expect(screen.getByTestId(`shopping-manual-${NAPKINS}`)).toHaveTextContent(/Napkins.*Added by hand.*the big pack/);
  });

  it('records "Bought" with the server’s remaining amount, and shows the returned view', async () => {
    const posted: Call[] = [];
    await renderApp(<ShoppingScreen listId={LIST} />, {
      routes: {
        'GET /v1/profiles': profiles(),
        [`GET ${BASE}/shopping`]: () => json(200, shopping({ rice: progress({ shopping_target: { quantity: 300, unit: 'g' }, remaining_to_purchase: { quantity: 120.5, unit: 'g' }, status: 'partially_purchased' }) })),
        [`POST ${BASE}/items/${RICE}/purchases`]: (call) => {
          posted.push(call);
          return json(201, shopping({ rice: { ...progress({ shopping_target: { quantity: 300, unit: 'g' }, remaining_to_purchase: { quantity: 0, unit: 'g' }, status: 'purchased' }), history: { purchases: [purchase('p1', '2026-10-20T10:00:00Z')] } } }));
        },
      },
    });
    expect(await screen.findByTestId(`shopping-item-${RICE}-remaining`)).toHaveTextContent('Still to buy: 120.5 g');
    await fireEvent.press(screen.getByTestId(`shopping-item-${RICE}-buy`));
    expect(await screen.findByText('Bought')).toBeTruthy();
    expect(posted).toHaveLength(1);
    expect(posted[0]!.body).toEqual({ quantity: 120.5, unit: 'g' });
    expect(screen.queryByTestId(`shopping-item-${RICE}-buy`)).toBeNull();
    expect(screen.getByTestId(`shopping-item-${RICE}-undo`)).toBeTruthy();
  });

  it('checks off an item with no quantity with an empty purchase', async () => {
    const posted: Call[] = [];
    await renderApp(<ShoppingScreen listId={LIST} />, {
      routes: {
        'GET /v1/profiles': profiles(),
        [`GET ${BASE}/shopping`]: () => json(200, shopping()),
        [`POST ${BASE}/manual-items/${NAPKINS}/purchases`]: (call) => {
          posted.push(call);
          return json(201, shopping());
        },
      },
    });
    await fireEvent.press(await screen.findByTestId(`shopping-manual-${NAPKINS}-buy`));
    await screen.findByTestId(`shopping-manual-${NAPKINS}-buy`);
    expect(posted[0]!.body).toEqual({});
    expect(screen.getByTestId(`shopping-item-${SALT}-buy`)).toHaveTextContent('Check off');
  });

  it('undoes the latest purchase still in effect by revoking it', async () => {
    const posted: Call[] = [];
    const history = { purchases: [purchase('p-old', '2026-10-20T09:00:00Z'), purchase('p-new', '2026-10-20T11:00:00Z'), purchase('p-rev', '2026-10-20T12:00:00Z', '2026-10-20T12:01:00Z')] };
    await renderApp(<ShoppingScreen listId={LIST} />, {
      routes: {
        'GET /v1/profiles': profiles(),
        [`GET ${BASE}/shopping`]: () => json(200, shopping({ rice: { history } })),
        [`POST ${BASE}/purchases/[^/]+/revoke`]: (call) => {
          posted.push(call);
          return json(200, shopping());
        },
      },
    });
    await fireEvent.press(await screen.findByTestId(`shopping-item-${RICE}-undo`));
    await screen.findByTestId(`shopping-item-${RICE}-buy`);
    expect(new URL(posted[0]!.url).pathname).toBe(`${BASE}/purchases/p-new/revoke`);
  });

  it('shows no write buttons when the server says the list is not writable', async () => {
    await renderApp(<ShoppingScreen listId={LIST} />, { routes: { 'GET /v1/profiles': profiles(), [`GET ${BASE}/shopping`]: () => json(200, shopping({ writable: false })) } });
    expect(await screen.findByTestId('list-read-only')).toBeTruthy();
    expect(screen.queryByTestId(`shopping-item-${RICE}-buy`)).toBeNull();
    expect(screen.queryByTestId(`shopping-manual-${NAPKINS}-buy`)).toBeNull();
  });

  it('shows no write buttons for a view-only Profile', async () => {
    await renderApp(<ShoppingScreen listId={LIST} />, { routes: { 'GET /v1/profiles': profiles('view_only'), [`GET ${BASE}/shopping`]: () => json(200, shopping()) } });
    expect(await screen.findByTestId('scope-read-only')).toBeTruthy();
    expect(screen.queryByTestId(`shopping-item-${RICE}-buy`)).toBeNull();
  });

  it('labels a replaced generation and a stale list', async () => {
    await renderApp(<ShoppingScreen listId={LIST} />, {
      routes: { 'GET /v1/profiles': profiles(), [`GET ${BASE}/shopping`]: () => json(200, shopping({ writable: false, list: { is_current_generation: false, status: 'superseded' } })) },
    });
    expect(await screen.findByTestId('list-superseded')).toBeTruthy();
    expect(screen.queryByTestId('list-read-only')).toBeNull();
  });

  it('shows a stale notice on the current generation', async () => {
    await renderApp(<ShoppingScreen listId={LIST} />, { routes: { 'GET /v1/profiles': profiles(), [`GET ${BASE}/shopping`]: () => json(200, shopping({ list: { is_stale: true } })) } });
    expect(await screen.findByTestId('list-stale')).toHaveTextContent(/may be out of date/);
  });

  it('shows a safe error when a write is refused, and keeps the list', async () => {
    await renderApp(<ShoppingScreen listId={LIST} />, {
      routes: {
        'GET /v1/profiles': profiles(),
        [`GET ${BASE}/shopping`]: () => json(200, shopping()),
        [`POST ${BASE}/items/${RICE}/purchases`]: () => json(409, { error: { code: 'CONFLICT', message: 'grocery_shopping_list_writable', requestId: 'r' } }),
      },
    });
    await fireEvent.press(await screen.findByTestId(`shopping-item-${RICE}-buy`));
    expect(await screen.findByTestId('shopping-write-error')).toBeTruthy();
    expect(screen.queryByText(/grocery_shopping_list_writable/)).toBeNull();
    expect(screen.getByTestId(`shopping-item-${RICE}`)).toBeTruthy();
  });
});
