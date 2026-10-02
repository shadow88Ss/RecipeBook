// Layer 12B — food/product search, server preview, meal logging and barcode
// lookup, against a scripted API. Every nutrition number on screen comes from
// a server response; the request bodies carry no nutrition.

import { fireEvent, screen, waitFor } from '@testing-library/react-native';
import { Pressable, Text, View } from 'react-native';

import { LogItemScreen, type LogTarget } from '../src/features/log/LogItemScreen';
import { LogScreen } from '../src/features/log/LogScreen';
import { ScanScreen } from '../src/features/log/ScanScreen';
import type { ScannerProps } from '../src/features/log/CameraScanner';
import { TodayScreen } from '../src/features/today/TodayScreen';
import { noConsumptionTrackerDto, PROFILE_A, profileDto, profilePage, summaryEntry, trackerDto } from './helpers/fixtures';
import { json, type Call } from './helpers/fakeServer';
import { renderApp } from './helpers/renderApp';

const NOW = () => new Date('2026-09-30T12:00:00Z');
const FOOD = 'aaaaaaaa-0000-4000-8000-000000000001';
const SERVING = 'aaaaaaaa-0000-4000-8000-000000000002';
const PRODUCT = 'bbbbbbbb-0000-4000-8000-000000000001';
const PSERVING = 'bbbbbbbb-0000-4000-8000-000000000002';
const LABEL = 'bbbbbbbb-0000-4000-8000-000000000003';

const profiles = (scope = 'full_management') => () => json(200, profilePage([profileDto(PROFILE_A, 'Sam', scope)]));
const apiCalls = (calls: Call[], method: string, path: RegExp) => calls.filter((c) => c.method === method && path.test(new URL(c.url).pathname));

const summary = (energy: number | null) => ({
  energy_kcal: energy === null ? summaryEntry('energy', null, 'unavailable', 0, 1) : summaryEntry('energy', energy, 'complete'),
  protein_g: summaryEntry('protein', 3.1, 'complete'),
  carbohydrate_g: summaryEntry('carbohydrate', null, 'unavailable', 0, 1),
  fat_g: summaryEntry('fat', 0, 'complete'),
  fiber_g: summaryEntry('fiber', null, 'unavailable', 0, 1),
});

const foodSearch = { data: [{ id: FOOD, canonical_name: 'apple_raw', category: 'fruit', source: 'trusted_database', display_name: 'Apple, raw', display_locale: 'en', match: { source: 'alias', text: 'apple', locale: 'en', kind: 'prefix', alias_source: 'trusted_database', identity_confirmation_required: false } }], pagination: { nextCursor: null, limit: 20 } };
const foodDetail = { id: FOOD, canonical_name: 'apple_raw', category: 'fruit', source: 'trusted_database', display_name: 'Apple, raw', display_locale: 'en', locale: 'en', region: null, density: null, aliases: [], servings: [{ id: SERVING, serving_description: '1 medium apple', region: null, canonical_quantity: 182, canonical_unit: 'g', source: 'trusted_database' }], nutrients: [] };
const productSummary = { id: PRODUCT, brand_name: 'Acme', product_name: 'Oat Bar', variant_name: 'Honey', manufacturer_name: null, display_name: 'Acme Oat Bar Honey', market: 'AE', package: { quantity: 40, unit: 'g' }, status: 'active', generic_food_id: null };
const productDetail = (label = true) => ({
  ...productSummary,
  current_label: label ? { id: LABEL, version_number: 1, status: 'published', nutrition_source: 'manufacturer_label', authority: 'exact_product', servings: [{ id: PSERVING, serving_description: '1 bar', canonical_quantity: 40, canonical_unit: 'g', source: 'manufacturer_label', provenance_reference: null }], nutrients: [] } : null,
  barcodes: [],
  label_versions: [],
});
const units = { base_units: { mass: 'g', volume: 'ml' }, data: [{ code: 'g', dimension: 'mass', label: 'gram' }, { code: 'oz', dimension: 'mass', label: 'ounce (avoirdupois)' }, { code: 'ml', dimension: 'volume', label: 'millilitre' }, { code: 'cup_us_legal', dimension: 'volume', label: 'US nutrition-labeling cup' }] };
const foodPreview = (energy: number | null = 95, status = 'converted') => ({ calculation_version: 'v', items: [{ normalized_quantity: { status } }], aggregate: {}, summary: summary(energy) });
const productPreview = (labelStatus = 'authoritative_label') => ({ label_status: labelStatus, normalized_quantity: { status: 'converted' }, summary: summary(190) });
const mealCreated = { id: 'meal-1', profile_id: PROFILE_A, meal_type: 'lunch', logged_date: '2026-09-30', local_timezone: 'UTC', item_count: 1, active_item_count: 1, items: [], nutrition: {} };

describe('Log: search (Layer 12B)', () => {
  const log = <LogScreen onOpenFood={jest.fn()} onOpenProduct={jest.fn()} onScan={jest.fn()} />;

  it('searches generic Foods through /v1/foods and labels them as generic', async () => {
    const onOpenFood = jest.fn();
    const { server } = await renderApp(<LogScreen onOpenFood={onOpenFood} onOpenProduct={jest.fn()} onScan={jest.fn()} />, {
      routes: { 'GET /v1/profiles': profiles(), 'GET /v1/foods': () => json(200, foodSearch) },
    });
    await fireEvent.changeText(await screen.findByTestId('search-input'), ' apple ');
    await fireEvent.press(screen.getByTestId('search-submit'));
    expect(await screen.findByText('Apple, raw')).toBeTruthy();
    expect(screen.getByText('Generic food · fruit')).toBeTruthy();
    const call = apiCalls(server.calls, 'GET', /^\/v1\/foods$/)[0]!;
    expect(new URL(call.url).searchParams.get('q')).toBe('apple');
    await fireEvent.press(screen.getByTestId(`food-${FOOD}`));
    expect(onOpenFood).toHaveBeenCalledWith(FOOD);
  });

  it('searches branded Products through /v1/products and shows brand, market and package', async () => {
    const onOpenProduct = jest.fn();
    await renderApp(<LogScreen onOpenFood={jest.fn()} onOpenProduct={onOpenProduct} onScan={jest.fn()} />, {
      routes: { 'GET /v1/profiles': profiles(), 'GET /v1/products': () => json(200, { data: [{ ...productSummary, active_barcodes: ['05012345678900'], match: { kind: 'prefix' } }], pagination: { nextCursor: null, limit: 20 } }) },
    });
    await fireEvent.press(await screen.findByTestId('search-kind-product'));
    await fireEvent.changeText(screen.getByTestId('search-input'), 'oat');
    await fireEvent.press(screen.getByTestId('search-submit'));
    expect(await screen.findByText('Acme Oat Bar Honey')).toBeTruthy();
    expect(screen.getByText('Branded product · Acme')).toBeTruthy();
    expect(screen.getByText('Market: AE')).toBeTruthy();
    expect(screen.getByText('Package: 40 g')).toBeTruthy();
    await fireEvent.press(screen.getByTestId(`product-${PRODUCT}`));
    expect(onOpenProduct).toHaveBeenCalledWith(PRODUCT);
  });

  it('says plainly when the reference database has no match (empty DEV data)', async () => {
    await renderApp(log, { routes: { 'GET /v1/profiles': profiles(), 'GET /v1/foods': () => json(200, { data: [], pagination: { nextCursor: null, limit: 20 } }) } });
    await fireEvent.changeText(await screen.findByTestId('search-input'), 'apple');
    await fireEvent.press(screen.getByTestId('search-submit'));
    expect(await screen.findByTestId('search-empty')).toHaveTextContent('No foods found for “apple”. The food database may not include it yet.');
  });

  it('shows a retryable error state', async () => {
    let fail = true;
    await renderApp(log, { routes: { 'GET /v1/profiles': profiles(), 'GET /v1/foods': () => (fail ? json(503, { error: { code: 'UNAVAILABLE', requestId: 'r1' } }) : json(200, foodSearch)) } });
    await fireEvent.changeText(await screen.findByTestId('search-input'), 'apple');
    await fireEvent.press(screen.getByTestId('search-submit'));
    expect(await screen.findByText('This service is temporarily unavailable.')).toBeTruthy();
    fail = false;
    await fireEvent.press(screen.getByText('Try again'));
    expect(await screen.findByText('Apple, raw')).toBeTruthy();
  });

  it('gives a view_only Profile no logging UI', async () => {
    await renderApp(log, { routes: { 'GET /v1/profiles': profiles('view_only') } });
    expect(await screen.findByTestId('log-read-only')).toHaveTextContent('You can view this profile but not log food for it.');
    expect(screen.queryByTestId('search-input')).toBeNull();
    expect(screen.queryByTestId('open-scanner')).toBeNull();
  });

  it('offers logging to a pediatric_weight_management Profile (server-documented write scope)', async () => {
    await renderApp(log, { routes: { 'GET /v1/profiles': profiles('pediatric_weight_management') } });
    expect(await screen.findByTestId('search-input')).toBeTruthy();
  });
});

function LogAndToday({ target, onLogged = jest.fn() }: { target: LogTarget; onLogged?: () => void }) {
  return (
    <View>
      <TodayScreen now={NOW} timeZone="UTC" onLog={jest.fn()} />
      <LogItemScreen target={target} now={NOW} timeZone="UTC" onLogged={onLogged} />
    </View>
  );
}

describe('Log item: amount, meal type, server preview and logging (Layer 12B)', () => {
  it('logs a Food serving: server preview, required meal type, POST without nutrition, then Today re-reads the API', async () => {
    let trackerReads = 0;
    const onLogged = jest.fn();
    const { server } = await renderApp(<LogAndToday target={{ kind: 'food', id: FOOD }} onLogged={onLogged} />, {
      routes: {
        'GET /v1/profiles': profiles(),
        'GET /v1/profiles/[^/]+/daily-tracker': () => json(200, ++trackerReads === 1 ? noConsumptionTrackerDto() : trackerDto({ meal_count: 1, active_item_count: 1 })),
        [`GET /v1/foods/${FOOD}`]: () => json(200, foodDetail),
        'GET /v1/units': () => json(200, units),
        'POST /v1/nutrition/calculate': () => json(200, foodPreview()),
        'POST /v1/profiles/[^/]+/meals': () => json(201, mealCreated),
      },
    });
    expect(await screen.findByText('Generic food')).toBeTruthy();
    // The only serving is preselected with quantity 1; the server computes the preview.
    expect(await screen.findByTestId('nutrition-preview')).toBeTruthy();
    expect(screen.getByTestId('preview-energy_kcal')).toHaveTextContent(/Energy:\ 95\ kcal/);
    expect(screen.getByTestId('preview-carbohydrate_g')).toHaveTextContent(/Carbohydrate:\ Not\ available/);
    expect(screen.getByTestId('preview-fat_g')).toHaveTextContent(/Fat:\ 0\ g/);
    expect(apiCalls(server.calls, 'POST', /^\/v1\/nutrition\/calculate$/)[0]!.body).toEqual({ items: [{ food_id: FOOD, quantity: 1, serving_id: SERVING }] });

    await fireEvent.press(screen.getByTestId('log-submit'));
    expect(await screen.findByTestId('meal-type-required')).toBeTruthy();
    expect(apiCalls(server.calls, 'POST', /\/meals$/)).toHaveLength(0);

    await fireEvent.press(screen.getByTestId('meal-lunch'));
    await fireEvent.changeText(screen.getByTestId('quantity-input'), '1,5');
    await waitFor(() => expect(apiCalls(server.calls, 'POST', /^\/v1\/nutrition\/calculate$/).some((c) => JSON.stringify(c.body).includes('"quantity":1.5'))).toBe(true));
    await fireEvent.press(screen.getByTestId('log-submit'));

    await waitFor(() => expect(onLogged).toHaveBeenCalled());
    const post = apiCalls(server.calls, 'POST', /\/meals$/)[0]!;
    expect(new URL(post.url).pathname).toBe(`/v1/profiles/${PROFILE_A}/meals`);
    expect(post.body).toEqual({ meal_type: 'lunch', logged_date: '2026-09-30', local_timezone: 'UTC', consumed_at: '2026-09-30T12:00:00.000Z', items: [{ type: 'food', food_id: FOOD, quantity: 1.5, serving_id: SERVING }] });
    // Today is refreshed from the server, not adjusted on the device.
    await waitFor(() => expect(trackerReads).toBe(2));
    expect(await screen.findByTestId('amount-energy_kcal')).toHaveTextContent('1,234.5 kcal');
  });

  it('logs a Food by weight in a server unit code', async () => {
    const { server } = await renderApp(<LogItemScreen target={{ kind: 'food', id: FOOD }} now={NOW} timeZone="UTC" onLogged={jest.fn()} />, {
      routes: {
        'GET /v1/profiles': profiles(),
        [`GET /v1/foods/${FOOD}`]: () => json(200, foodDetail),
        'GET /v1/units': () => json(200, units),
        'POST /v1/nutrition/calculate': () => json(200, foodPreview()),
        'POST /v1/profiles/[^/]+/meals': () => json(201, mealCreated),
      },
    });
    await fireEvent.press(await screen.findByTestId('mode-unit'));
    // Only offered units the server lists are shown.
    expect(await screen.findByTestId('unit-oz')).toBeTruthy();
    expect(screen.queryByTestId('unit-kg')).toBeNull();
    await fireEvent.press(screen.getByTestId('unit-oz'));
    await fireEvent.changeText(screen.getByTestId('quantity-input'), '3');
    await fireEvent.press(screen.getByTestId('meal-snack'));
    await fireEvent.press(screen.getByTestId('log-submit'));
    await waitFor(() => expect(apiCalls(server.calls, 'POST', /\/meals$/)).toHaveLength(1));
    expect(apiCalls(server.calls, 'POST', /\/meals$/)[0]!.body).toMatchObject({ meal_type: 'snack', items: [{ type: 'food', food_id: FOOD, quantity: 3, unit: 'oz' }] });
  });

  it('rejects a zero or non-numeric amount before calling the server', async () => {
    const { server } = await renderApp(<LogItemScreen target={{ kind: 'food', id: FOOD }} now={NOW} timeZone="UTC" onLogged={jest.fn()} />, {
      routes: { 'GET /v1/profiles': profiles(), [`GET /v1/foods/${FOOD}`]: () => json(200, foodDetail), 'GET /v1/units': () => json(200, units), 'POST /v1/nutrition/calculate': () => json(200, foodPreview()) },
    });
    await fireEvent.changeText(await screen.findByTestId('quantity-input'), '0');
    expect(screen.getByText('Enter an amount greater than 0.')).toBeTruthy();
    expect(screen.getByTestId('log-submit')).toBeDisabled();
    await fireEvent.changeText(screen.getByTestId('quantity-input'), 'abc');
    expect(screen.getByText('Enter an amount greater than 0.')).toBeTruthy();
    expect(apiCalls(server.calls, 'POST', /\/meals$/)).toHaveLength(0);
  });

  it('says when the server could not convert the amount (values stay unavailable, never 0)', async () => {
    await renderApp(<LogItemScreen target={{ kind: 'food', id: FOOD }} now={NOW} timeZone="UTC" onLogged={jest.fn()} />, {
      routes: { 'GET /v1/profiles': profiles(), [`GET /v1/foods/${FOOD}`]: () => json(200, foodDetail), 'GET /v1/units': () => json(200, units), 'POST /v1/nutrition/calculate': () => json(200, foodPreview(null, 'unresolved')) },
    });
    expect(await screen.findByTestId('not-converted')).toBeTruthy();
    expect(screen.getByTestId('preview-energy_kcal')).toHaveTextContent(/Energy:\ Not\ available/);
  });

  it('logs a Product serving by product_id after a server Product preview', async () => {
    const { server } = await renderApp(<LogItemScreen target={{ kind: 'product', id: PRODUCT }} now={NOW} timeZone="UTC" onLogged={jest.fn()} />, {
      routes: {
        'GET /v1/profiles': profiles(),
        [`GET /v1/products/${PRODUCT}`]: () => json(200, productDetail()),
        'GET /v1/units': () => json(200, units),
        [`POST /v1/products/${PRODUCT}/nutrition/calculate`]: () => json(200, productPreview()),
        'POST /v1/profiles/[^/]+/meals': () => json(201, mealCreated),
      },
    });
    expect(await screen.findByTestId('item-kind')).toHaveTextContent('Branded product · Acme');
    expect(await screen.findByTestId('preview-energy_kcal')).toHaveTextContent(/Energy:\ 190\ kcal/);
    expect(apiCalls(server.calls, 'POST', /nutrition\/calculate$/)[0]!.body).toEqual({ quantity: 1, product_serving_id: PSERVING });
    await fireEvent.press(screen.getByTestId('meal-breakfast'));
    await fireEvent.press(screen.getByTestId('log-submit'));
    await waitFor(() => expect(apiCalls(server.calls, 'POST', /\/meals$/)).toHaveLength(1));
    expect(apiCalls(server.calls, 'POST', /\/meals$/)[0]!.body).toMatchObject({ meal_type: 'breakfast', items: [{ type: 'product', product_id: PRODUCT, quantity: 1, product_serving_id: PSERVING }] });
  });

  it('logs a scanned Product by barcode so the server records it', async () => {
    const { server } = await renderApp(<LogItemScreen target={{ kind: 'product', id: PRODUCT, barcode: '05012345678900' }} now={NOW} timeZone="UTC" onLogged={jest.fn()} />, {
      routes: {
        'GET /v1/profiles': profiles(),
        [`GET /v1/products/${PRODUCT}`]: () => json(200, productDetail()),
        'GET /v1/units': () => json(200, units),
        [`POST /v1/products/${PRODUCT}/nutrition/calculate`]: () => json(200, productPreview()),
        'POST /v1/profiles/[^/]+/meals': () => json(201, mealCreated),
      },
    });
    await fireEvent.press(await screen.findByTestId('meal-dinner'));
    await fireEvent.press(screen.getByTestId('log-submit'));
    await waitFor(() => expect(apiCalls(server.calls, 'POST', /\/meals$/)).toHaveLength(1));
    const item = (apiCalls(server.calls, 'POST', /\/meals$/)[0]!.body as { items: Record<string, unknown>[] }).items[0]!;
    expect(item).toEqual({ type: 'product', barcode: '05012345678900', quantity: 1, product_serving_id: PSERVING });
  });

  it('blocks a Product with no label version and warns about an unverified label', async () => {
    await renderApp(<LogItemScreen target={{ kind: 'product', id: PRODUCT }} now={NOW} timeZone="UTC" onLogged={jest.fn()} />, {
      routes: { 'GET /v1/profiles': profiles(), [`GET /v1/products/${PRODUCT}`]: () => json(200, productDetail(false)), 'GET /v1/units': () => json(200, units) },
    });
    expect(await screen.findByTestId('item-blocked')).toHaveTextContent('This product has no label yet, so it cannot be logged.');
    expect(screen.queryByTestId('log-submit')).toBeNull();
  });

  it('shows the unverified-label notice from the server preview', async () => {
    await renderApp(<LogItemScreen target={{ kind: 'product', id: PRODUCT }} now={NOW} timeZone="UTC" onLogged={jest.fn()} />, {
      routes: {
        'GET /v1/profiles': profiles(),
        [`GET /v1/products/${PRODUCT}`]: () => json(200, productDetail()),
        'GET /v1/units': () => json(200, units),
        [`POST /v1/products/${PRODUCT}/nutrition/calculate`]: () => json(200, productPreview('non_authoritative_label')),
      },
    });
    expect(await screen.findByTestId('label-status')).toHaveTextContent(/This\ product’s\ label\ is\ not\ verified/);
  });

  it('shows a safe message when the server refuses the item (409) and does not leave the screen', async () => {
    const onLogged = jest.fn();
    await renderApp(<LogItemScreen target={{ kind: 'food', id: FOOD }} now={NOW} timeZone="UTC" onLogged={onLogged} />, {
      routes: {
        'GET /v1/profiles': profiles(),
        [`GET /v1/foods/${FOOD}`]: () => json(200, foodDetail),
        'GET /v1/units': () => json(200, units),
        'POST /v1/nutrition/calculate': () => json(200, foodPreview()),
        'POST /v1/profiles/[^/]+/meals': () => json(409, { error: { code: 'CONFLICT', message: 'internal detail', requestId: 'r' } }),
      },
    });
    await fireEvent.press(await screen.findByTestId('meal-other'));
    await fireEvent.press(screen.getByTestId('log-submit'));
    expect(await screen.findByTestId('log-error')).toHaveTextContent(/This\ item\ cannot\ be\ logged\ as\ entered\./);
    expect(screen.queryByText(/internal detail/)).toBeNull();
    expect(onLogged).not.toHaveBeenCalled();
  });

  it('gives a view_only Profile no Log action on an item', async () => {
    await renderApp(<LogItemScreen target={{ kind: 'food', id: FOOD }} now={NOW} timeZone="UTC" onLogged={jest.fn()} />, {
      routes: { 'GET /v1/profiles': profiles('view_only'), [`GET /v1/foods/${FOOD}`]: () => json(200, foodDetail), 'GET /v1/units': () => json(200, units) },
    });
    expect(await screen.findByTestId('log-read-only')).toBeTruthy();
    expect(screen.queryByTestId('log-submit')).toBeNull();
  });

  it('Today offers the Log entry only when the Profile can log', async () => {
    const onLog = jest.fn();
    await renderApp(<TodayScreen now={NOW} timeZone="UTC" onLog={onLog} />, { routes: { 'GET /v1/profiles': profiles(), 'GET /v1/profiles/[^/]+/daily-tracker': () => json(200, trackerDto()) } });
    await fireEvent.press(await screen.findByTestId('today-log'));
    expect(onLog).toHaveBeenCalled();
  });
});

/** A stand-in camera: a button that "scans" a fixed code. */
function fakeScanner(code: string) {
  return function FakeScanner({ onScanned, active }: ScannerProps) {
    return (
      <Pressable testID="fake-scan" disabled={!active} onPress={() => onScanned(code)}>
        <Text>scan</Text>
      </Pressable>
    );
  };
}

const candidate = {
  contract_version: 'c1',
  status: 'unconfirmed_external_candidate',
  loggable: false,
  provider_key: 'open_food_facts',
  external_product_id: '3017620422003',
  retrieved_at: '2026-09-30T12:00:00Z',
  barcode: { canonical_gtin: '03017620422003', provider_code: '3017620422003' },
  brand_name: 'Brand X',
  product_name: 'Hazelnut spread',
  variant_name: null,
  markets: [],
  package: null,
  servings: [],
  nutrition: [],
  nutrient_mapping_status: 'partial',
  ingredients_text: null,
  provenance: {
    source_type: 'external_provider',
    provider_key: 'open_food_facts',
    provider_classification: 'community',
    authority: 'external_candidate',
    provider_record_url: 'https://example.test/product/3017620422003',
    attribution: { required: true, text: 'Open Food Facts contributors', link: 'https://example.test/attribution', licence: 'ODbL' },
  },
  completeness: { identity: true, barcode: true, package: false, servings: false, nutrition: 'partial', ingredients: false },
  warnings: [],
  unresolved_fields: [],
  storage: {},
};

describe('Scan: barcode lookup (Layer 12B)', () => {
  it('sends the raw camera string to the API lookup and offers normal logging for an internal Product', async () => {
    const onLogProduct = jest.fn();
    const { server } = await renderApp(<ScanScreen onLogProduct={onLogProduct} Scanner={fakeScanner('5012345678900')} />, {
      routes: {
        'GET /v1/profiles': profiles(),
        'GET /v1/products/barcode/[^/]+/lookup': () =>
          json(200, { submitted: { rules_version: 'b1', digits: '5012345678900', barcode_type: 'ean_13', canonical_gtin: '05012345678900' }, source: 'internal', match: {}, product: productDetail(), candidates: [], disagreements: [], external_lookup: null }),
      },
    });
    await fireEvent.press(await screen.findByTestId('fake-scan'));
    expect(await screen.findByTestId('barcode-product')).toHaveTextContent(/In MyRecipeBook · Branded product/);
    const call = apiCalls(server.calls, 'GET', /\/lookup$/)[0]!;
    expect(new URL(call.url).pathname).toBe('/v1/products/barcode/5012345678900/lookup');
    await fireEvent.press(screen.getByTestId('barcode-log-product'));
    expect(onLogProduct).toHaveBeenCalledWith(PRODUCT, '05012345678900');
  });

  it('shows an external candidate as unconfirmed, attributed and NOT loggable', async () => {
    await renderApp(<ScanScreen onLogProduct={jest.fn()} Scanner={fakeScanner('3017620422003')} />, {
      routes: {
        'GET /v1/profiles': profiles(),
        'GET /v1/products/barcode/[^/]+/lookup': () =>
          json(200, { submitted: { canonical_gtin: '03017620422003' }, source: 'external_candidate', match: null, product: null, candidates: [candidate], preferred_candidate: null, disagreements: [], external_lookup: { status: 'found' }, next_step: 'confirmation_required_before_use' }),
      },
    });
    await fireEvent.press(await screen.findByTestId('fake-scan'));
    expect(await screen.findByTestId('barcode-candidate')).toBeTruthy();
    expect(screen.getByText('Not yet in MyRecipeBook')).toBeTruthy();
    expect(screen.getByTestId('candidate-name')).toHaveTextContent('Brand X · Hazelnut spread');
    expect(screen.getByTestId('candidate-unconfirmed')).toHaveTextContent(/cannot\ be\ logged\ until\ it\ has\ been\ reviewed\ and\ added\ to\ MyRecipeBook/);
    expect(screen.getByText('Source: Open Food Facts contributors')).toBeTruthy();
    expect(screen.getByText('Licence: ODbL')).toBeTruthy();
    expect(screen.queryByTestId('barcode-log-product')).toBeNull();
  });

  it('rejects a lookup response that claims a candidate is loggable (contract guard)', async () => {
    await renderApp(<ScanScreen onLogProduct={jest.fn()} Scanner={fakeScanner('1')} />, {
      routes: {
        'GET /v1/profiles': profiles(),
        'GET /v1/products/barcode/[^/]+/lookup': () => json(200, { source: 'external_candidate', product: null, candidates: [{ ...candidate, loggable: true }] }),
      },
    });
    await fireEvent.press(await screen.findByTestId('fake-scan'));
    expect(await screen.findByText('The app received a response it did not understand.')).toBeTruthy();
    expect(screen.queryByTestId('barcode-log-product')).toBeNull();
  });

  it('reports nothing found, and an invalid code (400) from manual entry', async () => {
    await renderApp(<ScanScreen onLogProduct={jest.fn()} Scanner={fakeScanner('0000')} />, {
      routes: {
        'GET /v1/profiles': profiles(),
        'GET /v1/products/barcode/[^/]+/lookup': (call) =>
          new URL(call.url).pathname.includes('123')
            ? json(400, { error: { code: 'VALIDATION_ERROR', requestId: 'r', details: { reason: 'invalid_check_digit', issues: [{ path: 'code' }] } } })
            : json(200, { source: 'none', match: null, product: null, candidates: [], external_lookup: { status: 'not_configured' }, next_step: null }),
      },
    });
    await fireEvent.press(await screen.findByTestId('fake-scan'));
    expect(await screen.findByTestId('barcode-none')).toHaveTextContent('No product found for this barcode.');
    await fireEvent.press(screen.getByTestId('scan-again'));
    await fireEvent.changeText(screen.getByTestId('barcode-input'), '123');
    await fireEvent.press(screen.getByTestId('barcode-submit'));
    expect(await screen.findByTestId('barcode-invalid')).toHaveTextContent(/This\ does\ not\ look\ like\ a\ product\ barcode\./);
  });

  it('gives a view_only Profile the lookup result but no Log action', async () => {
    await renderApp(<ScanScreen onLogProduct={jest.fn()} Scanner={fakeScanner('5012345678900')} />, {
      routes: {
        'GET /v1/profiles': profiles('view_only'),
        'GET /v1/products/barcode/[^/]+/lookup': () => json(200, { source: 'internal', product: productDetail(), candidates: [] }),
      },
    });
    await fireEvent.press(await screen.findByTestId('fake-scan'));
    expect(await screen.findByTestId('barcode-product')).toBeTruthy();
    expect(screen.queryByTestId('barcode-log-product')).toBeNull();
  });
});
