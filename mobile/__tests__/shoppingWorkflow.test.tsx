// Layer 12F — the full shopping workflow against a scripted API
// (docs/30_API.md §23–24): already-have, shopping quantity, purchases of a
// typed amount (partial), check-off, undo, manual items, regeneration of a
// stale list and the superseded view. The app sends the user's facts as
// typed and shows the server's need, target and remaining; it never works
// them out. Values are invented test data.

import { fireEvent, screen, waitFor } from '@testing-library/react-native';

import { ShoppingScreen, parseAmount, unitChoices } from '../src/features/grocery/ShoppingScreen';
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

const UNITS = {
  data: [
    { code: 'g', dimension: 'mass', label: 'g' },
    { code: 'kg', dimension: 'mass', label: 'kg' },
    { code: 'ml', dimension: 'volume', label: 'ml' },
  ],
};

type Routes = Record<string, (call: Call) => Response>;
const base = (view: object, scope = 'full_management'): Routes => ({
  'GET /v1/profiles': profiles(scope),
  'GET /v1/units': () => json(200, UNITS),
  [`GET ${BASE}/shopping`]: () => json(200, view),
});

/** A route that records its calls and answers with `view`. */
function capture(view: object, status = 201) {
  const calls: Call[] = [];
  return { calls, route: (call: Call) => (calls.push(call), json(status, view)) };
}

const RICE_ID = `shopping-item-${RICE}`;

describe('Units and amounts (input only)', () => {
  it('offers units of the item’s own dimension, count for a count, and everything for no amount', () => {
    expect(unitChoices('g', UNITS.data as never)).toEqual(['g', 'kg']);
    expect(unitChoices('ml', UNITS.data as never)).toEqual(['ml']);
    expect(unitChoices('count', UNITS.data as never)).toEqual(['count']);
    expect(unitChoices(null, UNITS.data as never)).toEqual(['g', 'kg', 'ml', 'count']);
  });

  it('accepts zero only where the API does', () => {
    expect(parseAmount('0', true)).toBe(0);
    expect(parseAmount('0', false)).toBeNull();
    expect(parseAmount('1,5', false)).toBe(1.5);
    expect(parseAmount('-1', true)).toBeNull();
    expect(parseAmount('', true)).toBeNull();
  });
});

describe('Already have and amount to buy', () => {
  it('records what I already have as typed and shows the server’s new target', async () => {
    const after = shopping({
      rice: {
        already_have: { id: 'h1', input: { quantity: 100, unit: 'g' }, normalized_quantity: 100, normalized_unit: 'g', comparison: 'comparable' },
        derived_need: { quantity: 200, unit: 'g' },
        ...progress({ shopping_target: { quantity: 200, unit: 'g' }, remaining_to_purchase: { quantity: 200, unit: 'g' } }),
      },
    });
    const post = capture(after);
    await renderApp(<ShoppingScreen listId={LIST} />, { routes: { ...base(shopping()), [`POST ${BASE}/items/${RICE}/already-have`]: post.route } });
    await fireEvent.press(await screen.findByTestId(`${RICE_ID}-have-edit`));
    expect(await screen.findByTestId(`${RICE_ID}-have-form-unit-kg`)).toBeTruthy();
    expect(screen.queryByTestId(`${RICE_ID}-have-form-unit-ml`)).toBeNull();
    await fireEvent.changeText(screen.getByTestId(`${RICE_ID}-have-form-quantity`), '100');
    await fireEvent.press(screen.getByTestId(`${RICE_ID}-have-form-save`));
    expect(await screen.findByTestId(`${RICE_ID}-have`)).toHaveTextContent('Already have 100 g');
    expect(screen.getByTestId(`${RICE_ID}-target`)).toHaveTextContent('To buy: 200 g');
    expect(post.calls[0]!.body).toEqual({ quantity: 100, unit: 'g' });
    expect(screen.queryByTestId(`${RICE_ID}-have-form`)).toBeNull();
  });

  it('allows "none" (0) but not an empty or negative amount', async () => {
    const post = capture(shopping());
    await renderApp(<ShoppingScreen listId={LIST} />, { routes: { ...base(shopping()), [`POST ${BASE}/items/${RICE}/already-have`]: post.route } });
    await fireEvent.press(await screen.findByTestId(`${RICE_ID}-have-edit`));
    await fireEvent.changeText(await screen.findByTestId(`${RICE_ID}-have-form-quantity`), '-2');
    await fireEvent.press(screen.getByTestId(`${RICE_ID}-have-form-save`));
    expect(post.calls).toHaveLength(0);
    await fireEvent.changeText(screen.getByTestId(`${RICE_ID}-have-form-quantity`), '0');
    await fireEvent.press(screen.getByTestId(`${RICE_ID}-have-form-save`));
    await waitFor(() => expect(post.calls).toHaveLength(1));
    expect(post.calls[0]!.body).toEqual({ quantity: 0, unit: 'g' });
  });

  it('clears what I have with an empty request', async () => {
    const withHave = shopping({ rice: { already_have: { id: 'h1', input: { quantity: 100, unit: 'g' } } } });
    const post = capture(shopping(), 200);
    await renderApp(<ShoppingScreen listId={LIST} />, { routes: { ...base(withHave), [`POST ${BASE}/items/${RICE}/already-have/clear`]: post.route } });
    await fireEvent.press(await screen.findByTestId(`${RICE_ID}-have-clear`));
    await waitFor(() => expect(screen.queryByTestId(`${RICE_ID}-have`)).toBeNull());
    expect(post.calls[0]!.body).toEqual({});
  });

  it('sets my own amount to buy, labels it, and goes back to the plan amount', async () => {
    const adjusted = shopping({ rice: { ...progress({ shopping_target: { quantity: 0.5, unit: 'kg' }, shopping_target_source: 'user_adjusted', remaining_to_purchase: { quantity: 0.5, unit: 'kg' } }) } });
    const set = capture(adjusted);
    const clear = capture(shopping(), 200);
    await renderApp(<ShoppingScreen listId={LIST} />, {
      routes: { ...base(shopping()), [`POST ${BASE}/items/${RICE}/shopping-quantity`]: set.route, [`POST ${BASE}/items/${RICE}/shopping-quantity/clear`]: clear.route },
    });
    expect(screen.queryByTestId(`${RICE_ID}-target-clear`)).toBeNull();
    await fireEvent.press(await screen.findByTestId(`${RICE_ID}-target-edit`));
    await fireEvent.press(await screen.findByTestId(`${RICE_ID}-target-form-unit-kg`));
    await fireEvent.changeText(screen.getByTestId(`${RICE_ID}-target-form-quantity`), '0.5');
    await fireEvent.press(screen.getByTestId(`${RICE_ID}-target-form-save`));
    expect(await screen.findByTestId(`${RICE_ID}-target`)).toHaveTextContent('To buy (your amount): 0.5 kg');
    expect(set.calls[0]!.body).toEqual({ quantity: 0.5, unit: 'kg' });
    await fireEvent.press(screen.getByTestId(`${RICE_ID}-target-clear`));
    expect(await screen.findByText('To buy: 300 g')).toBeTruthy();
    expect(clear.calls).toHaveLength(1);
  });
});

describe('Purchases', () => {
  it('records a partial purchase as typed and shows the server’s remaining amount', async () => {
    const after = shopping({
      rice: {
        ...progress({ status: 'partially_purchased', shopping_target: { quantity: 300, unit: 'g' }, remaining_to_purchase: { quantity: 200, unit: 'g' } }),
        history: { already_have: [], shopping_adjustments: [], purchases: [purchase('p1', '2026-10-21T10:00:00Z')] },
      },
    });
    const post = capture(after);
    await renderApp(<ShoppingScreen listId={LIST} />, { routes: { ...base(shopping()), [`POST ${BASE}/items/${RICE}/purchases`]: post.route } });
    await fireEvent.press(await screen.findByTestId(`${RICE_ID}-buy-amount`));
    await fireEvent.changeText(await screen.findByTestId(`${RICE_ID}-buy-form-quantity`), '0');
    await fireEvent.press(screen.getByTestId(`${RICE_ID}-buy-form-save`));
    expect(post.calls).toHaveLength(0);
    await fireEvent.changeText(screen.getByTestId(`${RICE_ID}-buy-form-quantity`), '100');
    await fireEvent.press(screen.getByTestId(`${RICE_ID}-buy-form-save`));
    expect(await screen.findByTestId(`${RICE_ID}-remaining`)).toHaveTextContent('Still to buy: 200 g');
    expect(screen.getByTestId(`${RICE_ID}-status`)).toHaveTextContent('Partly bought');
    expect(screen.getByTestId(`${RICE_ID}-buy`)).toHaveTextContent('Bought 200 g');
    expect(post.calls[0]!.body).toEqual({ quantity: 100, unit: 'g' });
  });

  it('offers no typed amount for a check-off item', async () => {
    await renderApp(<ShoppingScreen listId={LIST} />, { routes: base(shopping()) });
    expect(await screen.findByTestId(`shopping-item-${SALT}-buy`)).toHaveTextContent('Check off');
    expect(screen.queryByTestId(`shopping-item-${SALT}-buy-amount`)).toBeNull();
  });
});

describe('Manual items', () => {
  const manualView = (extra: object[]) => {
    const v = shopping();
    return { ...v, manual_items: [...v.manual_items, ...extra] };
  };
  const eggs = {
    grocery_manual_item_id: 'm-eggs',
    source: 'manual',
    name: 'Eggs',
    food: null,
    notes: null,
    input: { quantity: 6, unit: 'count' },
    ...progress({ shopping_target: { quantity: 6, unit: 'count' }, remaining_to_purchase: { quantity: 6, unit: 'count' } }),
    purchases: [],
    revoked_at: null,
  };

  it('adds an item with an amount, and one without', async () => {
    const post = capture(manualView([eggs]));
    await renderApp(<ShoppingScreen listId={LIST} />, { routes: { ...base(shopping()), [`POST ${BASE}/manual-items`]: post.route } });
    await fireEvent.press(await screen.findByTestId('manual-add-start'));
    await fireEvent.press(screen.getByTestId('manual-save'));
    expect(post.calls).toHaveLength(0);
    await fireEvent.changeText(screen.getByTestId('manual-name'), ' Eggs ');
    await fireEvent.changeText(screen.getByTestId('manual-quantity'), '6');
    await fireEvent.press(screen.getByTestId('manual-save'));
    expect(post.calls).toHaveLength(0);
    await fireEvent.press(await screen.findByTestId('manual-unit-count'));
    await fireEvent.press(screen.getByTestId('manual-save'));
    expect(await screen.findByTestId('shopping-manual-m-eggs')).toHaveTextContent(/Eggs/);
    expect(post.calls[0]!.body).toEqual({ name: 'Eggs', notes: null, quantity: 6, unit: 'count' });
    await fireEvent.press(screen.getByTestId('manual-add-start'));
    await fireEvent.changeText(screen.getByTestId('manual-name'), 'Foil');
    await fireEvent.press(screen.getByTestId('manual-save'));
    await waitFor(() => expect(post.calls).toHaveLength(2));
    expect(post.calls[1]!.body).toEqual({ name: 'Foil', notes: null });
  });

  it('removes a manual item by revoking it', async () => {
    const post = capture(shopping(), 200);
    await renderApp(<ShoppingScreen listId={LIST} />, { routes: { ...base(manualView([eggs])), [`POST ${BASE}/manual-items/m-eggs/revoke`]: post.route } });
    await fireEvent.press(await screen.findByTestId('shopping-manual-m-eggs-remove'));
    await waitFor(() => expect(screen.queryByTestId('shopping-manual-m-eggs')).toBeNull());
    expect(post.calls[0]!.body).toEqual({});
  });
});

describe('Lists that cannot change', () => {
  it('gives a view-only Profile no shopping controls', async () => {
    await renderApp(<ShoppingScreen listId={LIST} onOpenList={jest.fn()} />, { routes: base(shopping({ list: { is_stale: true } }), 'view_only') });
    await screen.findByTestId(RICE_ID);
    expect(screen.queryByTestId(`${RICE_ID}-have-edit`)).toBeNull();
    expect(screen.queryByTestId('manual-add-start')).toBeNull();
    expect(screen.queryByTestId('list-regenerate')).toBeNull();
  });

  it('shows an empty list with the option to add an item', async () => {
    await renderApp(<ShoppingScreen listId={LIST} />, { routes: base({ ...shopping(), items: [], manual_items: [] }) });
    expect(await screen.findByText('This list has no items.')).toBeTruthy();
    expect(screen.getByTestId('manual-add-start')).toBeTruthy();
  });

  it('labels a replaced generation, keeps it read-only and opens the newer one', async () => {
    const onOpenList = jest.fn();
    await renderApp(<ShoppingScreen listId={LIST} onOpenList={onOpenList} />, {
      routes: base(shopping({ writable: false, list: { status: 'superseded', is_current_generation: false, superseded_by_grocery_list_id: 'list-3' } })),
    });
    expect(await screen.findByTestId('list-superseded')).toBeTruthy();
    expect(screen.queryByTestId(`${RICE_ID}-have-edit`)).toBeNull();
    expect(screen.queryByTestId('list-regenerate')).toBeNull();
    await fireEvent.press(screen.getByTestId('list-open-newer'));
    expect(onOpenList).toHaveBeenCalledWith('list-3');
  });
});

describe('Regenerating a stale list', () => {
  it('warns that nothing is carried over, then makes a new version from the plan and opens it', async () => {
    const onOpenList = jest.fn();
    const post = capture({ id: 'list-3', generation_number: 3, items: [] });
    await renderApp(<ShoppingScreen listId={LIST} onOpenList={onOpenList} />, {
      routes: { ...base(shopping({ list: { is_stale: true } })), [`POST /v1/profiles/${PROFILE_A}/meal-plans/plan-1/grocery-lists`]: post.route },
    });
    expect(await screen.findByTestId('list-stale')).toBeTruthy();
    await fireEvent.press(screen.getByTestId('list-regenerate-start'));
    expect(screen.getByTestId('list-regenerate-warning')).toHaveTextContent(/not copied/);
    expect(post.calls).toHaveLength(0);
    await fireEvent.press(screen.getByTestId('list-regenerate-yes'));
    await waitFor(() => expect(onOpenList).toHaveBeenCalledWith('list-3'));
    expect(post.calls[0]!.body).toEqual({});
  });

  it('offers no regeneration for an up-to-date list', async () => {
    await renderApp(<ShoppingScreen listId={LIST} onOpenList={jest.fn()} />, { routes: base(shopping()) });
    await screen.findByTestId(RICE_ID);
    expect(screen.queryByTestId('list-regenerate')).toBeNull();
  });

  it('offers no regeneration when the plan is completed', async () => {
    await renderApp(<ShoppingScreen listId={LIST} onOpenList={jest.fn()} />, { routes: base(shopping({ list: { is_stale: true, current_plan_status: 'completed' } })) });
    expect(await screen.findByTestId('list-stale')).toBeTruthy();
    expect(screen.queryByTestId('list-regenerate')).toBeNull();
  });
});
