// Layer 13A — importing a recipe from a website link against a scripted API
// (docs/30_API.md §33). The app sends the link, shows the server's draft for
// review and saves what the user reviewed through the import. Values are
// invented test data.

import { fireEvent, screen, waitFor } from '@testing-library/react-native';

import { RecipeImportScreen } from '../src/features/recipes/RecipeImportScreen';
import { RecipeScreen } from '../src/features/recipes/RecipeScreen';
import { RecipesScreen } from '../src/features/recipes/RecipesScreen';
import { PROFILE_A, profileDto, profilePage } from './helpers/fixtures';
import { json, type Call } from './helpers/fakeServer';
import { renderApp } from './helpers/renderApp';

const IMPORT = 'bbbbbbbb-1111-4000-8000-000000000001';
const RECIPE = 'bbbbbbbb-1111-4000-8000-0000000000r1';
const PATH = `/v1/profiles/${PROFILE_A}/recipe-imports`;
const LINK = 'https://www.kitchen.example.com/rice-bowl';
const profiles = (scope = 'full_management') => () => json(200, profilePage([profileDto(PROFILE_A, 'Sam', scope)]));

function imported(o: Partial<{ status: string; error_code: string | null; servings: number | null; yield_text: string | null; recipe_id: string | null; existing_recipe_id: string | null }> = {}) {
  const ok = (o.status ?? 'needs_confirmation') === 'needs_confirmation' || o.status === 'succeeded';
  return {
    id: IMPORT,
    status: o.status ?? 'needs_confirmation',
    error_code: o.error_code ?? null,
    source: { url: LINK, original_url: LINK, provider: 'web' },
    draft: ok
      ? {
          title: 'Rice Bowl',
          description: 'Quick.',
          servings: o.servings === undefined ? 4 : o.servings,
          yield_text: o.yield_text ?? null,
          ingredients: [
            { text: '200 g cooked rice', quantity: 200, unit: 'g' },
            { text: '2 cups spinach', note: 'ambiguous_unit' },
            { text: '1 egg', quantity: 1 },
          ],
          instructions: ['Cook.', 'Serve.'],
          truncated: false,
        }
      : null,
    recipe_id: o.recipe_id ?? null,
    existing_recipe_id: o.existing_recipe_id ?? null,
  };
}

const savedRecipe = {
  id: RECIPE,
  title: 'Rice Bowl',
  updated_at: '2026-10-31T00:00:00Z',
  version_count: 1,
  current_version: { id: 'v1', version_number: 1, is_current: true, title: 'Rice Bowl', description: 'Quick.', servings: 4, ingredients: [], instructions: [] },
};

describe('Import from a link', () => {
  it('is offered only to scopes that can manage recipes', async () => {
    await renderApp(<RecipesScreen onOpen={jest.fn()} onNew={jest.fn()} onImport={jest.fn()} />, {
      routes: {
        'GET /v1/profiles': profiles('view_only'),
        [`GET /v1/profiles/${PROFILE_A}/recipes`]: () => json(200, { data: [], pagination: { nextCursor: null, limit: 20 } }),
      },
    });
    await screen.findByTestId('recipes-empty');
    expect(screen.queryByTestId('import-recipe')).toBeNull();
  });

  it('sends the link, shows the draft for review and saves what was reviewed', async () => {
    const started: Call[] = [];
    const saved: Call[] = [];
    const onSaved = jest.fn();
    await renderApp(<RecipeImportScreen onSaved={onSaved} onOpenRecipe={jest.fn()} />, {
      routes: {
        'GET /v1/profiles': profiles(),
        [`POST ${PATH}`]: (call) => {
          started.push(call);
          return json(201, imported());
        },
        [`POST ${PATH}/${IMPORT}/save`]: (call) => {
          saved.push(call);
          return json(201, savedRecipe);
        },
      },
    });
    await fireEvent.changeText(await screen.findByTestId('import-url'), `  ${LINK} `);
    await fireEvent.press(screen.getByTestId('import-submit'));

    expect(await screen.findByTestId('import-source')).toHaveTextContent('From kitchen.example.com');
    expect(started[0]!.body).toEqual({ url: LINK, idempotency_key: expect.stringMatching(/^import-[a-z0-9-]+$/) });
    expect(screen.getByTestId('recipe-title').props.value).toBe('Rice Bowl');
    expect(screen.getByTestId('recipe-servings-input').props.value).toBe('4');
    // Nothing is linked to a food; the cup line has no amount.
    expect(screen.getByTestId('draft-ingredient-status-1')).toHaveTextContent('Text only, not counted in nutrition');

    await fireEvent.changeText(screen.getByTestId('recipe-title'), 'My Rice Bowl');
    await fireEvent.press(screen.getByTestId('recipe-save'));
    await waitFor(() => expect(onSaved).toHaveBeenCalledWith(RECIPE));
    expect(saved[0]!.body).toEqual({
      title: 'My Rice Bowl',
      description: 'Quick.',
      servings: 4,
      ingredients: [{ text: '200 g cooked rice', quantity: 200, unit: 'g' }, { text: '2 cups spinach' }, { text: '1 egg', quantity: 1 }],
      instructions: ['Cook.', 'Serve.'],
    });
  });

  it('asks for servings when the page gives none', async () => {
    await renderApp(<RecipeImportScreen onSaved={jest.fn()} onOpenRecipe={jest.fn()} />, {
      routes: {
        'GET /v1/profiles': profiles(),
        [`POST ${PATH}`]: () => json(201, imported({ servings: null, yield_text: 'Makes 24 cookies' })),
      },
    });
    await fireEvent.changeText(await screen.findByTestId('import-url'), LINK);
    await fireEvent.press(screen.getByTestId('import-submit'));
    expect(await screen.findByTestId('import-yield')).toHaveTextContent(/The page says: “Makes 24 cookies”/);
    expect(screen.getByTestId('recipe-servings-input').props.value).toBe('');
  });

  it('explains a page without recipe data and lets the user try another link', async () => {
    await renderApp(<RecipeImportScreen onSaved={jest.fn()} onOpenRecipe={jest.fn()} />, {
      routes: {
        'GET /v1/profiles': profiles(),
        [`POST ${PATH}`]: () => json(201, imported({ status: 'permanently_failed', error_code: 'no_recipe_found' })),
      },
    });
    await fireEvent.changeText(await screen.findByTestId('import-url'), LINK);
    await fireEvent.press(screen.getByTestId('import-submit'));
    expect(await screen.findByTestId('import-failed')).toHaveTextContent(/does not publish recipe details/);
    await fireEvent.press(screen.getByTestId('import-try-again'));
    expect(await screen.findByTestId('import-url')).toBeTruthy();
  });

  it('shows a refused link (e.g. Instagram) without the server wording', async () => {
    await renderApp(<RecipeImportScreen onSaved={jest.fn()} onOpenRecipe={jest.fn()} />, {
      routes: {
        'GET /v1/profiles': profiles(),
        [`POST ${PATH}`]: () => json(400, { error: { code: 'VALIDATION_ERROR', message: 'server text', details: { issues: [{ path: 'url', message: 'unsupported_provider' }] }, requestId: 'r' } }),
      },
    });
    await fireEvent.changeText(await screen.findByTestId('import-url'), 'https://www.instagram.com/p/abc/');
    await fireEvent.press(screen.getByTestId('import-submit'));
    expect(await screen.findByTestId('import-error')).toHaveTextContent(/Instagram, TikTok and YouTube are not supported yet/);
    expect(screen.queryByText('server text')).toBeNull();
  });

  it('points to the recipe already imported from the same link', async () => {
    const onOpen = jest.fn();
    await renderApp(<RecipeImportScreen onSaved={jest.fn()} onOpenRecipe={onOpen} />, {
      routes: {
        'GET /v1/profiles': profiles(),
        [`POST ${PATH}`]: () => json(201, imported({ existing_recipe_id: RECIPE })),
      },
    });
    await fireEvent.changeText(await screen.findByTestId('import-url'), LINK);
    await fireEvent.press(screen.getByTestId('import-submit'));
    await fireEvent.press(await screen.findByTestId('import-open-existing'));
    expect(onOpen).toHaveBeenCalledWith(RECIPE);
    expect(screen.queryByTestId('recipe-save')).toBeNull();
  });

  it('a save refused because it was saved meanwhile switches to the saved recipe', async () => {
    const onOpen = jest.fn();
    await renderApp(<RecipeImportScreen onSaved={jest.fn()} onOpenRecipe={onOpen} />, {
      routes: {
        'GET /v1/profiles': profiles(),
        [`POST ${PATH}`]: () => json(201, imported()),
        [`POST ${PATH}/${IMPORT}/save`]: () => json(409, { error: { code: 'CONFLICT', message: 'x', requestId: 'r' } }),
        [`GET ${PATH}/${IMPORT}`]: () => json(200, imported({ status: 'succeeded', recipe_id: RECIPE, existing_recipe_id: RECIPE })),
      },
    });
    await fireEvent.changeText(await screen.findByTestId('import-url'), LINK);
    await fireEvent.press(screen.getByTestId('import-submit'));
    await fireEvent.press(await screen.findByTestId('recipe-save'));
    await fireEvent.press(await screen.findByTestId('import-open-existing'));
    expect(onOpen).toHaveBeenCalledWith(RECIPE);
  });
});

// ---- Layer 13A.1 — nutrition of imported recipes --------------------------

const SPINACH = 'bbbbbbbb-1111-4000-8000-0000000000f9';
const withSuggestions = () => {
  const base = imported();
  return {
    ...base,
    draft: {
      ...base.draft!,
      ingredients: [
        { text: '200 g cooked rice', quantity: 200, unit: 'g' },
        { text: '2 cups spinach', note: 'ambiguous_unit', suggestion: { food_id: SPINACH, name: 'Spinach', match_kind: 'exact', confidence: 0.8, term: 'spinach' } },
        { text: '1 egg', quantity: 1 },
      ],
      source_nutrition: {
        basis: 'per_serving',
        serving_size: '1 bowl',
        values: [
          { field: 'calories', text: '320 calories', amount: 320, unit: 'kcal' },
          { field: 'proteinContent', text: '12 g', amount: 12, unit: 'g' },
        ],
      },
    },
  };
};

describe('Imported recipe nutrition (13A.1)', () => {
  it('shows suggestions as unconfirmed, flags cup lines, shows stated nutrition, and saves an unconfirmed suggestion as a suggestion', async () => {
    const saved: Call[] = [];
    await renderApp(<RecipeImportScreen onSaved={jest.fn()} onOpenRecipe={jest.fn()} />, {
      routes: {
        'GET /v1/profiles': profiles(),
        [`POST ${PATH}`]: () => json(201, withSuggestions()),
        [`POST ${PATH}/${IMPORT}/save`]: (call) => {
          saved.push(call);
          return json(201, savedRecipe);
        },
      },
    });
    await fireEvent.changeText(await screen.findByTestId('import-url'), LINK);
    await fireEvent.press(screen.getByTestId('import-submit'));
    expect(await screen.findByTestId('draft-ingredient-status-1')).toHaveTextContent('Suggested food: Spinach. Not counted until you confirm it.');
    expect(screen.getByTestId('draft-ingredient-note-1')).toHaveTextContent(/cup and spoon sizes differ/);
    expect(screen.getByTestId('confirm-suggestion-1')).toBeTruthy();
    expect(screen.queryByTestId('confirm-suggestion-0')).toBeNull();
    expect(screen.getByTestId('stated-nutrition')).toHaveTextContent(/Nutrition stated by kitchen\.example\.com/);
    expect(screen.getByTestId('stated-calories')).toHaveTextContent('Calories: 320 calories');

    await fireEvent.press(screen.getByTestId('recipe-save'));
    await waitFor(() => expect(saved).toHaveLength(1));
    expect((saved[0]!.body as { ingredients: unknown[] }).ingredients[1]).toEqual({ text: '2 cups spinach', suggested_food_id: SPINACH, suggestion_confidence: 0.8 });
  });

  it('Confirm opens the line with the suggested food linked, ready for an amount', async () => {
    await renderApp(<RecipeImportScreen onSaved={jest.fn()} onOpenRecipe={jest.fn()} />, {
      routes: {
        'GET /v1/profiles': profiles(),
        [`POST ${PATH}`]: () => json(201, withSuggestions()),
        [`GET /v1/foods/${SPINACH}`]: () => json(200, { id: SPINACH, canonical_name: 'spinach', category: null, display_name: 'Spinach', servings: [] }),
        'GET /v1/units': () => json(200, { data: [{ code: 'g', dimension: 'mass', label: 'g' }] }),
      },
    });
    await fireEvent.changeText(await screen.findByTestId('import-url'), LINK);
    await fireEvent.press(screen.getByTestId('import-submit'));
    await fireEvent.press(await screen.findByTestId('confirm-suggestion-1'));
    expect(await screen.findByTestId('linked-food')).toHaveTextContent('Linked to Spinach');
  });
});

describe('Recipe screen: per-ingredient nutrition and stated nutrition (13A.1)', () => {
  const R = 'cccccccc-1111-4000-8000-000000000001';
  const V = 'cccccccc-1111-4000-8000-0000000000v1';
  const entry = (key: string, value: number | null, coverage: 'complete' | 'partial' | 'unavailable', resolved = 1, count = 1) => ({
    nutrient_key: key, value, is_zero: value === 0, below_output_precision: false, coverage, status: null, resolved_item_count: resolved, item_count: count,
  });
  const summary = (e: number | null, p: number | null, c: number | null, f: number | null, fi: number | null, coverage: 'complete' | 'partial' = 'complete', resolved = 1, count = 1) => ({
    energy_kcal: entry('energy', e, e === null ? 'unavailable' : coverage, resolved, count),
    protein_g: entry('protein', p, p === null ? 'unavailable' : coverage, resolved, count),
    carbohydrate_g: entry('carbohydrate', c, c === null ? 'unavailable' : coverage, resolved, count),
    fat_g: entry('fat', f, f === null ? 'unavailable' : coverage, resolved, count),
    fiber_g: entry('fiber', fi, fi === null ? 'unavailable' : coverage, resolved, count),
  });
  const view = (energy: number) => ({ summary: summary(energy, 5.4, 56.4, 0.6, 0.8, 'partial', 1, 2), item_count: 2, nutrients: [] });
  const recipeDetail = {
    id: R,
    title: 'Spinach Rice',
    updated_at: '2026-11-02T00:00:00Z',
    version_count: 1,
    current_version: {
      id: V, version_number: 1, is_current: true, title: 'Spinach Rice', description: null, servings: 2,
      ingredients: [
        { id: 'i1', position: 1, text: '200 g cooked rice', food_id: 'f1', serving_id: null, quantity: 200, unit: 'g', match_status: 'matched' },
        { id: 'i2', position: 2, text: '2 cups spinach', food_id: SPINACH, serving_id: null, quantity: null, unit: null, match_status: 'needs_confirmation' },
      ],
      instructions: [],
    },
    imported_source: { url: LINK, provider: 'web', stated_nutrition: { basis: 'per_serving', serving_size: null, values: [{ field: 'calories', text: '320 kcal', amount: 320, unit: 'kcal' }] } },
  };
  const recipeNutrition = {
    recipe_version_id: V, version_number: 1, servings: 2, ingredient_count: 2, calculated_ingredient_count: 1,
    whole_recipe: view(260), per_serving: { servings: 2, ...view(130) }, per_serving_status: 'available',
    ingredients: [
      {
        ingredient_id: 'i1', index: 0, nutrition_status: 'calculated',
        calculation: {
          summary: summary(260, 5.4, 56.4, 0.6, 0.8),
          nutrients: [{ nutrient_key: 'iron', unit: 'mg', value: 2.4, is_zero: false, below_output_precision: false, status: 'resolved', source: { source: 'trusted_database', authority: 'trusted_reference' } }],
        },
      },
      { ingredient_id: 'i2', index: 1, nutrition_status: 'food_needs_confirmation', calculation: null },
    ],
  };

  it('shows each counted ingredient’s calories and macros, its nutrients on tap, why others are not counted, and the source’s stated nutrition apart', async () => {
    await renderApp(<RecipeScreen recipeId={R} />, {
      routes: {
        'GET /v1/profiles': profiles(),
        [`GET /v1/profiles/${PROFILE_A}/recipes/${R}`]: () => json(200, recipeDetail),
        [`GET /v1/profiles/${PROFILE_A}/recipes/${R}/nutrition`]: () => json(200, recipeNutrition),
      },
    });
    expect(await screen.findByTestId('ingredient-nutrition-i1')).toHaveTextContent('260 kcal · protein 5.4 g · carbohydrate 56.4 g · fat 0.6 g · fiber 0.8 g');
    expect(screen.queryByTestId('ingredient-nutrition-i2')).toBeNull();
    expect(screen.getByTestId('ingredient-status-i2')).toHaveTextContent('Not counted in nutrition: the food match is not confirmed');
    await fireEvent.press(screen.getByTestId('ingredient-details-i1-toggle'));
    expect(await screen.findByTestId('ingredient-details-i1-list')).toHaveTextContent(/Iron/);
    expect(screen.getByTestId('recipe-source')).toHaveTextContent('Imported from kitchen.example.com');
    expect(screen.getByTestId('stated-nutrition')).toHaveTextContent(/not used in the nutrition calculated above/);
    expect(screen.getByTestId('recipe-summary-amount-energy_kcal')).toHaveTextContent('130 kcal');
  });
});
