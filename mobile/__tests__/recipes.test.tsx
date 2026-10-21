// Layer 12C — Recipe Book screens against a scripted API (docs/30_API.md
// §17). Every value on screen comes from a server response: the app shows
// per-serving and whole-recipe nutrition as returned, never divides or adds,
// keeps an uncounted ingredient visible with its reason, and never turns a
// missing value into 0. Values are invented test data.

import { fireEvent, screen } from '@testing-library/react-native';

import { RecipeScreen } from '../src/features/recipes/RecipeScreen';
import { RecipesScreen } from '../src/features/recipes/RecipesScreen';
import { PROFILE_A, profileDto, profilePage, summaryEntry } from './helpers/fixtures';
import { json, type Call } from './helpers/fakeServer';
import { renderApp } from './helpers/renderApp';

const RECIPE = 'dddddddd-0000-4000-8000-000000000001';
const VERSION = 'dddddddd-0000-4000-8000-0000000000v2';
const ING_RICE = 'dddddddd-0000-4000-8000-0000000000i1';
const ING_SALT = 'dddddddd-0000-4000-8000-0000000000i2';
const profiles = (scope = 'full_management') => () => json(200, profilePage([profileDto(PROFILE_A, 'Sam', scope)]));

const listItem = (id: string, title: string, servings: number | null) => ({
  id,
  profile_id: PROFILE_A,
  visibility: 'private',
  title,
  current_version_id: 'v',
  current_version_number: 1,
  servings,
  created_at: '2026-10-01T00:00:00Z',
  updated_at: '2026-10-02T00:00:00Z',
});

function detail(servings: number | null = 4) {
  return {
    id: RECIPE,
    profile_id: PROFILE_A,
    visibility: 'private',
    title: 'Rice bowl',
    created_at: '2026-10-01T00:00:00Z',
    updated_at: '2026-10-02T00:00:00Z',
    version_count: 2,
    current_version: {
      id: VERSION,
      recipe_id: RECIPE,
      version_number: 2,
      is_current: true,
      title: 'Rice bowl',
      servings,
      description: 'Simple and quick.',
      created_at: '2026-10-02T00:00:00Z',
      provenance: { origin: 'manual' },
      ingredients: [
        { id: ING_RICE, position: 1, text: '400 g cooked rice', food_id: 'f1', serving_id: null, quantity: 400, unit: 'g', match_status: 'matched', match_confidence: null },
        { id: ING_SALT, position: 2, text: 'salt to taste', food_id: null, serving_id: null, quantity: null, unit: null, match_status: 'unmatched', match_confidence: null },
      ],
      instructions: [
        { id: 's1', step_number: 1, text: 'Warm the rice.' },
        { id: 's2', step_number: 2, text: 'Season and serve.' },
      ],
    },
    nutrition: null,
  };
}

const agg = (key: string, unit: string, value: number | null, coverage: 'complete' | 'partial' | 'unavailable', resolved = 1, count = 2) => ({
  nutrient_key: key,
  nutrient_role: 'other',
  unit,
  coverage,
  value,
  is_zero: value === 0,
  below_output_precision: false,
  resolved_item_count: resolved,
  item_count: count,
  missing: [],
});

/** Whole recipe 520 kcal; the server's per-serving view (÷4) is 130 kcal. One of two ingredients is uncounted. */
function nutrition(perServing = true) {
  const view = (energy: number, protein: number) => ({
    summary: {
      energy_kcal: summaryEntry('energy', energy, 'partial', 1, 2),
      protein_g: summaryEntry('protein', protein, 'partial', 1, 2),
      carbohydrate_g: summaryEntry('carbohydrate', null, 'unavailable', 0, 2),
      fat_g: summaryEntry('fat', 0, 'partial', 1, 2),
      fiber_g: summaryEntry('fiber', null, 'unavailable', 0, 2),
    },
    item_count: 2,
    coverage_summary: {},
    nutrients: [agg('energy', 'kcal', energy, 'partial'), agg('protein', 'g', protein, 'partial'), agg('sodium', 'mg', null, 'unavailable', 0)],
  });
  return {
    recipe_id: RECIPE,
    recipe_version_id: VERSION,
    version_number: 2,
    is_current: true,
    calculation_version: 'x',
    conversion_version: 'y',
    precision: {},
    servings: perServing ? 4 : null,
    ingredient_count: 2,
    calculated_ingredient_count: 1,
    whole_recipe: view(520, 10.8),
    per_serving: perServing ? { servings: 4, ...view(130, 2.7) } : null,
    per_serving_status: perServing ? 'available' : 'servings_not_defined',
    ingredients: [
      { ingredient_id: ING_RICE, index: 0, nutrition_status: 'calculated', calculation: {} },
      { ingredient_id: ING_SALT, index: 1, nutrition_status: 'food_unmatched', calculation: null },
    ],
  };
}

const detailRoutes = (d = detail(), n: unknown = nutrition()) => ({
  'GET /v1/profiles': profiles(),
  [`GET /v1/profiles/${PROFILE_A}/recipes/${RECIPE}`]: () => json(200, d),
  [`GET /v1/profiles/${PROFILE_A}/recipes/${RECIPE}/nutrition`]: () => json(200, n),
});

describe('Recipe list', () => {
  it('lists the Profile’s recipes with their yield and opens one', async () => {
    const onOpen = jest.fn();
    await renderApp(<RecipesScreen onOpen={onOpen} />, {
      routes: {
        'GET /v1/profiles': profiles(),
        'GET /v1/profiles/[^/]+/recipes': () => json(200, { data: [listItem(RECIPE, 'Rice bowl', 4), listItem('r2', 'Soup', 1), listItem('r3', 'Imported', null)], pagination: { nextCursor: null, limit: 20 } }),
      },
    });
    expect(await screen.findByTestId(`recipe-${RECIPE}`)).toHaveTextContent(/Rice bowl.*Makes 4 servings/);
    expect(screen.getByTestId('recipe-r2')).toHaveTextContent(/Makes 1 serving$/);
    expect(screen.getByTestId('recipe-r3')).toHaveTextContent(/Number of servings not set/);
    await fireEvent.press(screen.getByTestId(`recipe-${RECIPE}`));
    expect(onOpen).toHaveBeenCalledWith(RECIPE);
  });

  it('searches by title on the server and pages with the cursor', async () => {
    const calls: Call[] = [];
    await renderApp(<RecipesScreen onOpen={jest.fn()} />, {
      routes: {
        'GET /v1/profiles': profiles(),
        'GET /v1/profiles/[^/]+/recipes': (call) => {
          calls.push(call);
          const url = new URL(call.url);
          if (url.searchParams.get('cursor') === 'c2') return json(200, { data: [listItem('r9', 'Rice pudding', 2)], pagination: { nextCursor: null, limit: 20 } });
          return json(200, { data: [listItem(RECIPE, 'Rice bowl', 4)], pagination: { nextCursor: 'c2', limit: 20 } });
        },
      },
    });
    await screen.findByTestId(`recipe-${RECIPE}`);
    await fireEvent.changeText(screen.getByTestId('recipe-search-input'), '  rice ');
    await fireEvent.press(screen.getByTestId('recipe-search-submit'));
    await fireEvent.press(await screen.findByTestId('recipes-more'));
    expect(await screen.findByTestId('recipe-r9')).toBeTruthy();
    const urls = calls.map((c) => new URL(c.url));
    expect(urls.some((u) => u.searchParams.get('q') === 'rice')).toBe(true);
    expect(urls.some((u) => u.searchParams.get('q') === 'rice' && u.searchParams.get('cursor') === 'c2')).toBe(true);
    expect(urls.every((u) => u.pathname === `/v1/profiles/${PROFILE_A}/recipes`)).toBe(true);
  });

  it('shows an empty state, and a no-match state for a search', async () => {
    await renderApp(<RecipesScreen onOpen={jest.fn()} />, {
      routes: { 'GET /v1/profiles': profiles(), 'GET /v1/profiles/[^/]+/recipes': () => json(200, { data: [], pagination: { nextCursor: null, limit: 20 } }) },
    });
    expect(await screen.findByTestId('recipes-empty')).toHaveTextContent('No recipes yet.');
    await fireEvent.changeText(screen.getByTestId('recipe-search-input'), 'cake');
    await fireEvent.press(screen.getByTestId('recipe-search-submit'));
    expect(await screen.findByText('No recipes match "cake".')).toBeTruthy();
  });

  it('shows an error with Try again, and no server text', async () => {
    await renderApp(<RecipesScreen onOpen={jest.fn()} />, {
      routes: { 'GET /v1/profiles': profiles(), 'GET /v1/profiles/[^/]+/recipes': () => json(500, { error: { code: 'INTERNAL', message: 'select * from recipe', requestId: 'req-9' } }) },
    });
    expect(await screen.findByTestId('error-state')).toHaveTextContent(/Reference: req-9/);
    expect(screen.queryByText(/select \*/)).toBeNull();
  });

  it('has no create or edit actions, for any scope', async () => {
    await renderApp(<RecipesScreen onOpen={jest.fn()} />, {
      routes: { 'GET /v1/profiles': profiles('view_only'), 'GET /v1/profiles/[^/]+/recipes': () => json(200, { data: [listItem(RECIPE, 'Rice bowl', 4)], pagination: { nextCursor: null, limit: 20 } }) },
    });
    await screen.findByTestId(`recipe-${RECIPE}`);
    expect(screen.queryByText(/new recipe|edit/i)).toBeNull();
  });
});

describe('Recipe detail', () => {
  it('shows the current version, yield, ingredients as written and steps', async () => {
    await renderApp(<RecipeScreen recipeId={RECIPE} />, { routes: detailRoutes() });
    expect(await screen.findByTestId('recipe-version')).toHaveTextContent('Version 2 of 2');
    expect(screen.getByTestId('recipe-servings')).toHaveTextContent('Makes 4 servings');
    expect(screen.getByTestId(`ingredient-${ING_RICE}`)).toHaveTextContent('400 g cooked rice');
    expect(screen.getByTestId('recipe-steps')).toHaveTextContent(/1\. Warm the rice\..*2\. Season and serve\./);
  });

  it('shows the server’s per-serving values by default, and the whole recipe on request', async () => {
    await renderApp(<RecipeScreen recipeId={RECIPE} />, { routes: detailRoutes() });
    expect(await screen.findByTestId('recipe-summary-amount-energy_kcal')).toHaveTextContent('130 kcal');
    expect(screen.getByTestId('recipe-nutrition-basis')).toHaveTextContent(/Showing one serving/);
    await fireEvent.press(screen.getByTestId('basis-whole-recipe'));
    expect(screen.getByTestId('recipe-summary-amount-energy_kcal')).toHaveTextContent('520 kcal');
    expect(screen.getByTestId('recipe-summary-amount-protein_g')).toHaveTextContent('10.8 g');
  });

  it('keeps an uncounted ingredient listed with its reason, and explains the partial total', async () => {
    await renderApp(<RecipeScreen recipeId={RECIPE} />, { routes: detailRoutes() });
    expect(await screen.findByTestId(`ingredient-status-${ING_SALT}`)).toHaveTextContent('Not counted in nutrition: not linked to a food');
    expect(screen.queryByTestId(`ingredient-status-${ING_RICE}`)).toBeNull();
    expect(screen.getByTestId('recipe-uncounted')).toHaveTextContent(/1 of 2 ingredients could not be counted/);
    expect(screen.getByTestId('recipe-summary-coverage-energy_kcal')).toHaveTextContent('Partial: 1 of 2 ingredients have data, so the total may be higher');
  });

  it('shows missing as Not available and a stated zero as 0', async () => {
    await renderApp(<RecipeScreen recipeId={RECIPE} />, { routes: detailRoutes() });
    expect(await screen.findByTestId('recipe-summary-amount-carbohydrate_g')).toHaveTextContent('Not available');
    expect(screen.getByTestId('recipe-summary-amount-fat_g')).toHaveTextContent('0 g');
    await fireEvent.press(screen.getByTestId('recipe-details-toggle'));
    expect(screen.getByTestId('nutrient-state-energy')).toHaveTextContent(/1 of 2 ingredients have data/);
    expect(screen.getByTestId('recipe-details-unavailable')).toHaveTextContent(/Sodium/);
  });

  it('has no per-serving view when the yield is not set, and never assumes one serving', async () => {
    await renderApp(<RecipeScreen recipeId={RECIPE} />, { routes: detailRoutes(detail(null), nutrition(false)) });
    expect(await screen.findByTestId('per-serving-unavailable')).toHaveTextContent(/only the whole recipe/);
    expect(screen.queryByTestId('basis-per-serving')).toBeNull();
    expect(screen.getByTestId('recipe-summary-amount-energy_kcal')).toHaveTextContent('520 kcal');
    expect(screen.getByTestId('recipe-servings')).toHaveTextContent(/Number of servings not set/);
  });

  it('shows a not-found error for a recipe the API does not return', async () => {
    await renderApp(<RecipeScreen recipeId={RECIPE} />, { routes: { 'GET /v1/profiles': profiles() } });
    expect(await screen.findByTestId('error-state')).toBeTruthy();
  });
});
