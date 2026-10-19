// Layer 12B.4 — nutrition display, completeness and wording, against a
// scripted API. Every value on screen comes from a server response; these
// tests check the app shows it faithfully: total and available carbohydrate
// apart, known zero vs missing, partial explained, small values not shown as
// zero, and history read from snapshots. Values are invented test data except
// where marked as mirroring the real DEV Heinz label (v1, per 100 g).

import { fireEvent, screen } from '@testing-library/react-native';
import { Pressable, Text } from 'react-native';

import type { ScannerProps } from '../src/features/log/CameraScanner';
import { LogItemScreen } from '../src/features/log/LogItemScreen';
import { ScanScreen } from '../src/features/log/ScanScreen';
import { TodayScreen } from '../src/features/today/TodayScreen';
import { tp } from '../src/i18n';
import { PROFILE_A, profileDto, profilePage, summaryEntry, trackerDto } from './helpers/fixtures';
import { json } from './helpers/fakeServer';
import { renderApp } from './helpers/renderApp';

const NOW = () => new Date('2026-10-19T12:00:00Z');
const PRODUCT = 'cccccccc-0000-4000-8000-000000000001';
const FOOD = 'cccccccc-0000-4000-8000-000000000002';
const profiles = () => json(200, profilePage([profileDto(PROFILE_A, 'Sam', 'full_management')]));
const today = <TodayScreen now={NOW} timeZone="UTC" />;

type Cov = 'complete' | 'partial' | 'unavailable';
/** An aggregate nutrient (day/meal), as GET /daily-tracker returns it. */
const agg = (key: string, unit: string, value: number | null, coverage: Cov, resolved = 1, count = 1, below = false) => ({
  nutrient_id: `id-${key}`,
  nutrient_key: key,
  nutrient_role: 'other',
  unit,
  coverage,
  value,
  is_zero: value === 0,
  below_output_precision: below,
  resolved_item_count: resolved,
  item_count: count,
  missing: [],
});
/** An item nutrient (Food/Product preview), as the calculate endpoints return it. */
const item = (key: string, unit: string, value: number | null, source: string | null = 'manufacturer_label', below = false) => ({
  nutrient_id: `id-${key}`,
  nutrient_key: key,
  nutrient_role: 'other',
  unit,
  status: value === null ? 'no_data' : 'resolved',
  value,
  is_zero: value === 0,
  below_output_precision: below,
  excluded: [],
  conversion_reason: null,
  source: value === null || !source ? null : { source, authority: source === 'manufacturer_label' ? 'exact_product' : 'global_reference', amount_per_basis: 1, basis_quantity: 100, basis_unit: 'g', quantity_in_basis_unit: 1 },
});
const NEW_KEYS_UNKNOWN = ['available_carbohydrate', 'total_sugars', 'added_sugars', 'saturated_fat'];

/** A day with one US-style meal (total carbohydrate) and one EU-style meal (available carbohydrate). */
function mixedDay() {
  return trackerDto({
    meal_count: 2,
    active_item_count: 2,
    actual: {
      basis: 'recorded_snapshots',
      summary: {
        energy_kcal: summaryEntry('energy', 400, 'complete', 2, 2),
        protein_g: summaryEntry('protein', 10, 'complete', 2, 2),
        carbohydrate_g: summaryEntry('carbohydrate', 30, 'partial', 1, 2),
        fat_g: summaryEntry('fat', 12, 'complete', 2, 2),
        fiber_g: summaryEntry('fiber', 1.5, 'partial', 1, 2),
      },
      item_count: 2,
      coverage_summary: {},
      nutrients: [
        agg('energy', 'kcal', 400, 'complete', 2, 2),
        agg('carbohydrate', 'g', 30, 'partial', 1, 2),
        agg('available_carbohydrate', 'g', 30, 'partial', 1, 2),
        agg('total_sugars', 'g', 10, 'partial', 1, 2),
        agg('added_sugars', 'g', null, 'unavailable', 0, 2),
        agg('saturated_fat', 'g', 0, 'partial', 1, 2),
        agg('fat', 'g', 12, 'complete', 2, 2),
        agg('protein', 'g', 0.04, 'complete', 2, 2, true),
        agg('omega_3', 'mg', 5, 'complete', 2, 2),
      ],
    },
    meal_groups: [
      {
        meal_type: 'breakfast',
        meals: [
          {
            id: 'meal-1',
            meal_type: 'breakfast',
            active_item_count: 1,
            nutrition: { item_count: 1, summary: { energy_kcal: summaryEntry('energy', 200, 'complete'), protein_g: summaryEntry('protein', 5, 'complete'), carbohydrate_g: summaryEntry('carbohydrate', 30, 'complete'), fat_g: summaryEntry('fat', 6, 'complete'), fiber_g: summaryEntry('fiber', 1.5, 'complete') } },
          },
        ],
      },
      {
        meal_type: 'snack',
        meals: [
          {
            id: 'meal-2',
            meal_type: 'snack',
            active_item_count: 1,
            nutrition: { item_count: 1, summary: { energy_kcal: summaryEntry('energy', 200, 'complete'), protein_g: summaryEntry('protein', 5, 'complete'), carbohydrate_g: summaryEntry('carbohydrate', null, 'unavailable', 0, 1), fat_g: summaryEntry('fat', 6, 'complete'), fiber_g: summaryEntry('fiber', null, 'unavailable', 0, 1) } },
          },
        ],
      },
    ],
  });
}

const trackerRoute = (dto: unknown) => ({ 'GET /v1/profiles': profiles, 'GET /v1/profiles/[^/]+/daily-tracker': () => json(200, dto) });

describe('Today: five-field summary, mixed US/EU day and details (A, B, C, D, E, F, G, H, I, J, O)', () => {
  it('keeps total carbohydrate partial and explains available carbohydrate instead of substituting it', async () => {
    await renderApp(today, { routes: trackerRoute(mixedDay()) });
    expect(await screen.findByTestId('tracker-view')).toBeTruthy();
    // A/B/J: the summary is the server's: total carbohydrate partial, never filled from available carbohydrate
    expect(screen.getByTestId('nutrient-carbohydrate_g')).toHaveTextContent(/Total carbohydrate/);
    expect(screen.getByTestId('amount-carbohydrate_g')).toHaveTextContent('30 g');
    expect(screen.getByTestId('coverage-carbohydrate_g')).toHaveTextContent('Partial: 1 of 2 items have data, so the total may be higher');
    expect(screen.getByTestId('carb-note')).toHaveTextContent(/available carbohydrate \(excluding fiber\).*never added to total carbohydrate/);
    for (const field of ['energy_kcal', 'protein_g', 'carbohydrate_g', 'fat_g', 'fiber_g']) expect(screen.getByTestId(`nutrient-${field}`)).toBeTruthy();
  });

  it('lists every nutrient separately, with known zero, missing, partial and an unknown future key', async () => {
    await renderApp(today, { routes: trackerRoute(mixedDay()) });
    await fireEvent.press(await screen.findByTestId('day-details-toggle'));
    // C/D: two distinct identities, each with its own value and meaning
    expect(screen.getByTestId('nutrient-row-carbohydrate')).toHaveTextContent(/Total carbohydrate.*30 g.*Includes fiber/);
    expect(screen.getByTestId('nutrient-row-available_carbohydrate')).toHaveTextContent(/Available carbohydrate.*30 g.*Excludes fiber\. Not the same as total carbohydrate/);
    // E/F/G
    expect(screen.getByTestId('nutrient-amount-total_sugars')).toHaveTextContent('10 g');
    expect(screen.getByTestId('nutrient-state-total_sugars')).toHaveTextContent('Partial: 1 of 2 items have data, so the total may be higher');
    expect(screen.getByTestId('nutrient-row-saturated_fat')).toHaveTextContent(/Saturated fat.*0 g.*Part of total fat/);
    // I: missing added sugars is listed as not available, never shown as 0
    expect(screen.queryByTestId('nutrient-row-added_sugars')).toBeNull();
    expect(screen.getByTestId('day-details-unavailable')).toHaveTextContent('Not available: Added sugars');
    // L: a tiny nonzero value is not displayed as 0
    expect(screen.getByTestId('nutrient-amount-protein')).toHaveTextContent('less than 0.1 g');
    // open vocabulary: a key the app does not know is still shown
    expect(screen.getByTestId('nutrient-row-omega_3')).toHaveTextContent(/Other nutrient \(omega 3\).*5 mg/);
  });

  it('shows the meal breakdown with each meal’s own server totals', async () => {
    await renderApp(today, { routes: trackerRoute(mixedDay()) });
    expect(await screen.findByTestId('meal-meal-1')).toHaveTextContent(/Breakfast.*1 item.*Energy: 200 kcal \(Complete\)/);
    expect(screen.getByTestId('meal-meal-2')).toHaveTextContent(/Snack.*1 item/);
  });
});

describe('Known zero vs missing, single items (H, I)', () => {
  it('a stated zero shows 0 g "Stated as zero"; a missing value is never 0', async () => {
    const dto = trackerDto({ meal_count: 1, actual: { basis: 'recorded_snapshots', summary: mixedDay().actual.summary, item_count: 1, coverage_summary: {}, nutrients: [agg('saturated_fat', 'g', 0, 'complete'), agg('total_sugars', 'g', null, 'unavailable', 0, 1)] }, meal_groups: [] });
    await renderApp(today, { routes: trackerRoute(dto) });
    await fireEvent.press(await screen.findByTestId('day-details-toggle'));
    expect(screen.getByTestId('nutrient-amount-saturated_fat')).toHaveTextContent('0 g');
    expect(screen.getByTestId('nutrient-state-saturated_fat')).toHaveTextContent('Stated as zero');
    expect(screen.getByTestId('day-details-unavailable')).toHaveTextContent('Not available: Total sugars');
  });
});

describe('Meal count wording (R)', () => {
  it('uses singular and plural correctly', async () => {
    expect(tp('today.meals', 1)).toBe('1 meal logged');
    expect(tp('today.meals', 2)).toBe('2 meals logged');
    expect(tp('today.mealItems', 1)).toBe('1 item');
    await renderApp(today, { routes: trackerRoute(trackerDto({ meal_count: 1 })) });
    expect(await screen.findByTestId('meal-count')).toHaveTextContent('1 meal logged');
  });
});

describe('Historical day (P) and targets (Q)', () => {
  it('older snapshots without the new identities show them as not available, not 0; no carbohydrate note', async () => {
    const dto = trackerDto({
      is_current_day: false,
      date: '2026-10-10',
      actual: {
        basis: 'recorded_snapshots',
        summary: mixedDay().actual.summary,
        item_count: 3,
        coverage_summary: {},
        nutrients: [agg('energy', 'kcal', 802.1, 'complete', 3, 3), agg('carbohydrate', 'g', 131.1, 'complete', 3, 3), ...NEW_KEYS_UNKNOWN.map((k) => agg(k, 'g', null, 'unavailable', 0, 3))],
      },
    });
    await renderApp(today, { routes: trackerRoute(dto) });
    await fireEvent.press(await screen.findByTestId('day-details-toggle'));
    expect(screen.getByTestId('day-details-unavailable')).toHaveTextContent('Not available: Saturated fat, Available carbohydrate, Total sugars, Added sugars');
    expect(screen.queryByTestId('carb-note')).toBeNull();
    for (const key of NEW_KEYS_UNKNOWN) expect(screen.queryByTestId(`nutrient-row-${key}`)).toBeNull();
  });

  it('keeps the server’s uncertain comparison wording', async () => {
    await renderApp(today, { routes: trackerRoute(trackerDto()) });
    expect(await screen.findByTestId('comparison-protein_g')).toHaveTextContent('At most 60 g remaining (some items have no data)');
  });
});

describe('Product preview (M, N) and Food preview (V)', () => {
  const productDetail = { id: PRODUCT, brand_name: 'Heinz', product_name: 'Mayonnaise', variant_name: 'Incredibly Light', display_name: 'Heinz Mayonnaise Incredibly Light', market: 'AE', package: { quantity: 600, unit: 'ml' }, status: 'active', current_label: { id: 'label-1', nutrition_source: 'manufacturer_label', servings: [] } };
  const units = { data: [{ code: 'g', dimension: 'mass', label: 'gram' }] };
  const summaryOf = (carb: number | null) => ({
    energy_kcal: summaryEntry('energy', 29.85, 'complete'),
    protein_g: { ...summaryEntry('protein', 0.045, 'complete'), below_output_precision: true },
    carbohydrate_g: carb === null ? summaryEntry('carbohydrate', null, 'unavailable', 0, 1) : summaryEntry('carbohydrate', carb, 'complete'),
    fat_g: summaryEntry('fat', 2.625, 'complete'),
    fiber_g: summaryEntry('fiber', 0.03, 'complete'),
  });
  const preview = (nutrients: unknown[], carb: number | null) => ({
    label_status: 'authoritative_label',
    label_version: { id: 'label-1', version_number: 1, nutrition_source: 'manufacturer_label' },
    normalized_quantity: { status: 'converted' },
    summary: summaryOf(carb),
    nutrients,
  });
  const routes = (body: unknown) => ({
    'GET /v1/profiles': profiles,
    [`GET /v1/products/${PRODUCT}`]: () => json(200, productDetail),
    'GET /v1/units': () => json(200, units),
    [`POST /v1/products/${PRODUCT}/nutrition/calculate`]: () => json(200, body),
  });

  it('M: the Heinz label v1 (US-style, total carbohydrate) shows its label version, values and source; new identities not available', async () => {
    // mirrors DEV: 15 g of Heinz Incredibly Light (label v1, per 100 g)
    const body = preview(
      [item('energy', 'kcal', 29.85), item('fat', 'g', 2.625), item('carbohydrate', 'g', 1.5), item('protein', 'g', 0.045, 'manufacturer_label', true), item('fiber', 'g', 0.03, 'manufacturer_label', true), item('sodium', 'mg', 119.25), ...NEW_KEYS_UNKNOWN.map((k) => item(k, 'g', null))],
      1.5,
    );
    await renderApp(<LogItemScreen target={{ kind: 'product', id: PRODUCT }} now={NOW} timeZone="UTC" onLogged={jest.fn()} />, { routes: routes(body) });
    expect(await screen.findByTestId('label-version')).toHaveTextContent('Manufacturer label, version 1');
    expect(screen.getByTestId('preview-carbohydrate_g')).toHaveTextContent(/Total carbohydrate: 1\.5 g/);
    expect(screen.getByTestId('preview-protein_g')).toHaveTextContent(/less than 0\.1 g/);
    await fireEvent.press(screen.getByTestId('preview-details-toggle'));
    expect(screen.getByTestId('nutrient-row-carbohydrate')).toHaveTextContent(/1\.5 g.*Source: Manufacturer label/);
    expect(screen.getByTestId('nutrient-amount-sodium')).toHaveTextContent('119.3 mg');
    expect(screen.getByTestId('preview-details-unavailable')).toHaveTextContent('Not available: Saturated fat, Available carbohydrate, Total sugars, Added sugars');
  });

  it('N: an EU-style label shows available carbohydrate; total carbohydrate stays not available', async () => {
    const body = preview(
      [item('energy', 'kcal', 200), item('available_carbohydrate', 'g', 30), item('carbohydrate', 'g', null), item('total_sugars', 'g', 10), item('saturated_fat', 'g', 0), item('fat', 'g', 6), item('protein', 'g', 5)],
      null,
    );
    await renderApp(<LogItemScreen target={{ kind: 'product', id: PRODUCT }} now={NOW} timeZone="UTC" onLogged={jest.fn()} />, { routes: routes(body) });
    expect(await screen.findByTestId('preview-carbohydrate_g')).toHaveTextContent(/Total carbohydrate: Not available/);
    await fireEvent.press(screen.getByTestId('preview-details-toggle'));
    expect(screen.getByTestId('nutrient-row-available_carbohydrate')).toHaveTextContent(/Available carbohydrate.*30 g.*Excludes fiber/);
    expect(screen.getByTestId('nutrient-state-saturated_fat')).toHaveTextContent('Stated as zero');
    expect(screen.getByTestId('preview-details-unavailable')).toHaveTextContent(/Total carbohydrate/);
    expect(screen.queryByTestId('nutrient-row-carbohydrate')).toBeNull();
  });

  it('V: a generic Food preview uses the same display, with its reference-database source', async () => {
    const foodDetail = { id: FOOD, canonical_name: 'usda-fdc:1', category: 'Dairy', display_name: 'Cheese, cottage', servings: [] };
    const body = { items: [{ normalized_quantity: { status: 'converted' }, nutrients: [item('energy', 'kcal', 98, 'trusted_database'), item('protein', 'g', 11, 'trusted_database'), item('total_sugars', 'g', null)] }], summary: summaryOf(3.4) };
    await renderApp(<LogItemScreen target={{ kind: 'food', id: FOOD }} now={NOW} timeZone="UTC" onLogged={jest.fn()} />, {
      routes: { 'GET /v1/profiles': profiles, [`GET /v1/foods/${FOOD}`]: () => json(200, foodDetail), 'GET /v1/units': () => json(200, units), 'POST /v1/nutrition/calculate': () => json(200, body) },
    });
    await fireEvent.press(await screen.findByTestId('preview-details-toggle'));
    expect(screen.getByTestId('nutrient-row-protein')).toHaveTextContent(/11 g.*Source: Reference database/);
    expect(screen.getByTestId('preview-details-unavailable')).toHaveTextContent('Not available: Total sugars');
    expect(screen.queryByTestId('label-version')).toBeNull();
  });
});

describe('Open Food Facts wording (S)', () => {
  it('names the provider once and keeps the full attribution, licence and link', async () => {
    const attribution = { required: true, text: 'Product data from Open Food Facts (openfoodfacts.org), available under the Open Database License (ODbL).', link: 'https://openfoodfacts.org', licence: 'ODbL-1.0 (database), DbCL-1.0 (contents)' };
    const candidate = {
      contract_version: 'c1',
      status: 'unconfirmed_external_candidate',
      loggable: false,
      provider_key: 'open_food_facts',
      external_product_id: '6290090018434',
      retrieved_at: '2026-10-19T12:00:00Z',
      barcode: { canonical_gtin: '06290090018434', provider_code: '6290090018434' },
      brand_name: 'Heinz',
      product_name: 'Heinze incredibly light mayonnaise',
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
        provider_record_url: null,
        attribution,
      },
      completeness: { identity: true, barcode: true, package: false, servings: false, nutrition: 'partial', ingredients: false },
      warnings: [],
      unresolved_fields: [],
      storage: {},
    };
    const Scanner = ({ onScanned, active }: ScannerProps) => (
      <Pressable testID="fake-scan" disabled={!active} onPress={() => onScanned('6290090018434')}>
        <Text>scan</Text>
      </Pressable>
    );
    await renderApp(<ScanScreen onLogProduct={jest.fn()} Scanner={Scanner} />, {
      routes: {
        'GET /v1/profiles': profiles,
        'GET /v1/products/barcode/[^/]+/lookup': () => json(200, { submitted: { canonical_gtin: '06290090018434' }, source: 'external_candidate', match: null, product: null, candidates: [candidate], disagreements: [], external_lookup: { status: 'found' }, next_step: 'confirmation_required_before_use' }),
      },
    });
    await fireEvent.press(await screen.findByTestId('fake-scan'));
    const notice = await screen.findByTestId('candidate-unconfirmed');
    expect(notice).toHaveTextContent('Unconfirmed information from Open Food Facts. It cannot be logged until it has been reviewed and added to MyRecipeBook.');
    expect(notice).not.toHaveTextContent(/from Product data/);
    expect(screen.getByText(`Source: ${attribution.text}`)).toBeTruthy();
    expect(screen.getByText(`Licence: ${attribution.licence}`)).toBeTruthy();
    expect(screen.getByText('More: https://openfoodfacts.org')).toBeTruthy();
  });
});

describe('Accessibility and states (T, U)', () => {
  it('rows speak label, meaning, value and completeness in words; the toggle is a button', async () => {
    await renderApp(today, { routes: trackerRoute(mixedDay()) });
    const toggle = await screen.findByTestId('day-details-toggle');
    expect(toggle.props.accessibilityRole ?? toggle.props.role).toBe('button');
    await fireEvent.press(toggle);
    expect(screen.getByTestId('nutrient-row-available_carbohydrate').props.accessibilityLabel).toBe(
      'Available carbohydrate. Excludes fiber. Not the same as total carbohydrate. 30 g. Partial: 1 of 2 items have data, so the total may be higher',
    );
    expect(screen.getByTestId('nutrient-row-saturated_fat').props.accessibilityLabel).toMatch(/Saturated fat\. Part of total fat\. 0 g\. Partial/);
  });

  it('an empty day shows the server’s known zeros and no detail list or carbohydrate note', async () => {
    const { noConsumptionTrackerDto } = jest.requireActual('./helpers/fixtures') as typeof import('./helpers/fixtures');
    await renderApp(today, { routes: trackerRoute(noConsumptionTrackerDto()) });
    expect(await screen.findByTestId('no-consumption')).toBeTruthy();
    expect(screen.queryByTestId('day-details')).toBeNull();
    expect(screen.queryByTestId('carb-note')).toBeNull();
    expect(screen.queryByTestId('meal-breakdown')).toBeNull();
  });

  it('a server error shows the error state with retry, never values', async () => {
    await renderApp(today, { routes: { 'GET /v1/profiles': profiles, 'GET /v1/profiles/[^/]+/daily-tracker': () => json(500, { error: { code: 'INTERNAL', message: 'x' } }) } });
    expect(await screen.findByText('Try again')).toBeTruthy();
    expect(screen.queryByTestId('tracker-view')).toBeNull();
  });
});
