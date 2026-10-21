// Layer 12D — creating and editing recipes against a scripted API
// (docs/30_API.md §17). The form sends only what the user entered; an edit
// sends only the changed fields plus the version it started from; an
// unconfirmed food suggestion is never turned into a confirmed match; and only
// full_management gets the form. Values are invented test data.

import { fireEvent, screen, waitFor } from '@testing-library/react-native';

import { RecipeEditScreen } from '../src/features/recipes/RecipeEditScreen';
import { RecipeScreen } from '../src/features/recipes/RecipeScreen';
import { RecipesScreen } from '../src/features/recipes/RecipesScreen';
import { PROFILE_A, profileDto, profilePage } from './helpers/fixtures';
import { json, type Call } from './helpers/fakeServer';
import { renderApp } from './helpers/renderApp';

const RECIPE = 'aaaaaaaa-1111-4000-8000-000000000001';
const VERSION = 'aaaaaaaa-1111-4000-8000-0000000000v1';
const EGG = 'aaaaaaaa-1111-4000-8000-0000000000f1';
const EGG_SERVING = 'aaaaaaaa-1111-4000-8000-0000000000s1';
const RICE = 'aaaaaaaa-1111-4000-8000-0000000000f2';
const PATH = `/v1/profiles/${PROFILE_A}/recipes`;
const profiles = (scope = 'full_management') => () => json(200, profilePage([profileDto(PROFILE_A, 'Sam', scope)]));

const searchRow = (id: string, name: string) => ({ id, canonical_name: name.toLowerCase(), category: null, display_name: name, match: { identity_confirmation_required: false } });
const foods = {
  'GET /v1/foods': (call: Call) => {
    const q = new URL(call.url).searchParams.get('q');
    return json(200, { data: q === 'egg' ? [searchRow(EGG, 'Egg')] : q === 'rice' ? [searchRow(RICE, 'Rice, cooked')] : [], pagination: { nextCursor: null, limit: 20 } });
  },
  [`GET /v1/foods/${EGG}`]: () => json(200, { id: EGG, canonical_name: 'egg', category: null, display_name: 'Egg', servings: [{ id: EGG_SERVING, serving_description: 'large egg', canonical_quantity: 50, canonical_unit: 'g' }] }),
  [`GET /v1/foods/${RICE}`]: () => json(200, { id: RICE, canonical_name: 'rice', category: null, display_name: 'Rice, cooked', servings: [] }),
  'GET /v1/units': () => json(200, { data: [{ code: 'g', dimension: 'mass', label: 'g' }, { code: 'ml', dimension: 'volume', label: 'ml' }] }),
};

function detail(o: { servings?: number | null; ingredients?: object[]; title?: string } = {}) {
  return {
    id: RECIPE,
    title: o.title ?? 'Egg rice',
    updated_at: '2026-10-21T00:00:00Z',
    version_count: 1,
    current_version: {
      id: VERSION,
      version_number: 1,
      is_current: true,
      title: o.title ?? 'Egg rice',
      description: null,
      servings: o.servings === undefined ? 2 : o.servings,
      ingredients: o.ingredients ?? [
        { id: 'i1', position: 1, text: '2 large eggs', food_id: EGG, serving_id: EGG_SERVING, quantity: 2, unit: null, match_status: 'matched' },
        { id: 'i2', position: 2, text: 'salt to taste', food_id: null, serving_id: null, quantity: null, unit: null, match_status: 'unmatched' },
      ],
      instructions: [{ id: 's1', step_number: 1, text: 'Cook.' }],
    },
  };
}

async function addTextLine(text: string) {
  await fireEvent.press(screen.getByTestId('add-ingredient'));
  await fireEvent.changeText(await screen.findByTestId('ingredient-text'), text);
  await fireEvent.press(screen.getByTestId('ingredient-save'));
  await screen.findByTestId('recipe-save');
}

async function addLinkedLine(text: string, q: string, foodId: string, quantity: string) {
  await fireEvent.press(screen.getByTestId('add-ingredient'));
  await fireEvent.changeText(await screen.findByTestId('ingredient-text'), text);
  await fireEvent.changeText(screen.getByTestId('ingredient-food-search'), q);
  await fireEvent.press(screen.getByTestId('ingredient-food-search-submit'));
  await fireEvent.press(await screen.findByTestId(`pick-food-${foodId}`));
  await fireEvent.changeText(await screen.findByTestId('ingredient-quantity'), quantity);
  await fireEvent.press(screen.getByTestId('ingredient-save'));
  await screen.findByTestId('recipe-save');
}

describe('Who can create and edit', () => {
  it.each(['view_only', 'pediatric_weight_management'])('%s gets no New recipe or Edit button, and a read-only form', async (scope) => {
    await renderApp(
      <>
        <RecipesScreen onOpen={jest.fn()} onNew={jest.fn()} />
        <RecipeScreen recipeId={RECIPE} onEdit={jest.fn()} />
        <RecipeEditScreen onSaved={jest.fn()} />
      </>,
      {
        routes: {
          'GET /v1/profiles': profiles(scope),
          [`GET ${PATH}`]: () => json(200, { data: [], pagination: { nextCursor: null, limit: 20 } }),
          [`GET ${PATH}/${RECIPE}`]: () => json(200, detail()),
          [`GET ${PATH}/${RECIPE}/nutrition`]: () => json(500, { error: { code: 'X', requestId: 'r' } }),
        },
      },
    );
    expect(await screen.findByTestId('recipe-edit-read-only')).toBeTruthy();
    await screen.findByTestId('recipe-version');
    expect(screen.queryByTestId('new-recipe')).toBeNull();
    expect(screen.queryByTestId('edit-recipe')).toBeNull();
  });

  it('full_management gets New recipe and Edit', async () => {
    const onNew = jest.fn();
    const onEdit = jest.fn();
    await renderApp(
      <>
        <RecipesScreen onOpen={jest.fn()} onNew={onNew} />
        <RecipeScreen recipeId={RECIPE} onEdit={onEdit} />
      </>,
      {
        routes: {
          'GET /v1/profiles': profiles(),
          [`GET ${PATH}`]: () => json(200, { data: [], pagination: { nextCursor: null, limit: 20 } }),
          [`GET ${PATH}/${RECIPE}`]: () => json(200, detail()),
          [`GET ${PATH}/${RECIPE}/nutrition`]: () => json(500, { error: { code: 'X', requestId: 'r' } }),
        },
      },
    );
    await fireEvent.press(await screen.findByTestId('new-recipe'));
    await fireEvent.press(await screen.findByTestId('edit-recipe'));
    expect(onNew).toHaveBeenCalled();
    expect(onEdit).toHaveBeenCalled();
  });
});

describe('Create', () => {
  it('sends exactly what was entered: text-only and linked lines, serving and unit amounts, steps', async () => {
    const posted: Call[] = [];
    const onSaved = jest.fn();
    await renderApp(<RecipeEditScreen onSaved={onSaved} />, {
      routes: {
        'GET /v1/profiles': profiles(),
        ...foods,
        [`POST ${PATH}`]: (call) => {
          posted.push(call);
          return json(201, detail());
        },
      },
    });
    await fireEvent.changeText(await screen.findByTestId('recipe-title'), '  Egg rice ');
    await fireEvent.changeText(screen.getByTestId('recipe-servings-input'), '2,5');
    await addLinkedLine('2 large eggs', 'egg', EGG, '2');
    expect(screen.getByTestId('draft-ingredient-status-0')).toHaveTextContent('Linked to a food · 2 × large egg');
    await addLinkedLine('150 g cooked rice', 'rice', RICE, '150');
    await addTextLine('salt to taste');
    expect(screen.getByTestId('draft-ingredient-status-2')).toHaveTextContent('Text only, not counted in nutrition');
    await fireEvent.press(screen.getByTestId('add-step'));
    await fireEvent.changeText(screen.getByTestId('step-0'), 'Cook the rice. ');
    await fireEvent.press(screen.getByTestId('recipe-save'));
    await waitFor(() => expect(onSaved).toHaveBeenCalledWith(RECIPE));
    expect(posted).toHaveLength(1);
    expect(posted[0]!.body).toEqual({
      title: 'Egg rice',
      description: null,
      servings: 2.5,
      ingredients: [
        { text: '2 large eggs', food_id: EGG, quantity: 2, serving_id: EGG_SERVING },
        { text: '150 g cooked rice', food_id: RICE, quantity: 150, unit: 'g' },
        { text: 'salt to taste' },
      ],
      instructions: ['Cook the rice.'],
    });
  });

  it('refuses to send an incomplete recipe and says what is missing', async () => {
    const posted: Call[] = [];
    await renderApp(<RecipeEditScreen onSaved={jest.fn()} />, {
      routes: { 'GET /v1/profiles': profiles(), [`POST ${PATH}`]: (call) => (posted.push(call), json(201, detail())) },
    });
    await fireEvent.changeText(await screen.findByTestId('recipe-servings-input'), '0');
    await fireEvent.press(screen.getByTestId('add-step'));
    await fireEvent.press(screen.getByTestId('recipe-save'));
    expect(screen.getByText('Enter a title.')).toBeTruthy();
    expect(screen.getByText(/servings greater than 0/)).toBeTruthy();
    expect(screen.getByText('Add at least one ingredient.')).toBeTruthy();
    expect(screen.getByText('Fill in or remove empty steps.')).toBeTruthy();
    expect(posted).toHaveLength(0);
  });

  it('needs an amount for a line linked to a food, and unlinking keeps it as text only', async () => {
    await renderApp(<RecipeEditScreen onSaved={jest.fn()} />, { routes: { 'GET /v1/profiles': profiles(), ...foods } });
    await fireEvent.press(await screen.findByTestId('add-ingredient'));
    await fireEvent.changeText(screen.getByTestId('ingredient-text'), 'some rice');
    await fireEvent.changeText(screen.getByTestId('ingredient-food-search'), 'rice');
    await fireEvent.press(screen.getByTestId('ingredient-food-search-submit'));
    await fireEvent.press(await screen.findByTestId(`pick-food-${RICE}`));
    await screen.findByTestId('ingredient-quantity');
    await fireEvent.press(screen.getByTestId('ingredient-save'));
    expect(screen.getByText('Enter an amount and choose a unit or serving.')).toBeTruthy();
    await fireEvent.press(screen.getByTestId('unlink-food'));
    await fireEvent.press(screen.getByTestId('ingredient-save'));
    expect(await screen.findByTestId('draft-ingredient-status-0')).toHaveTextContent(/^Text only/);
  });
});

describe('Edit (new version)', () => {
  const editRoutes = (d: object, onPatch: (call: Call) => Response) => ({
    'GET /v1/profiles': profiles(),
    ...foods,
    [`GET ${PATH}/${RECIPE}`]: () => json(200, d),
    [`PATCH ${PATH}/${RECIPE}`]: onPatch,
  });

  it('sends nothing when nothing changed', async () => {
    const patched: Call[] = [];
    await renderApp(<RecipeEditScreen recipeId={RECIPE} onSaved={jest.fn()} />, { routes: editRoutes(detail(), (c) => (patched.push(c), json(200, detail()))) });
    expect(await screen.findByText(/Version 1 stays as it is/)).toBeTruthy();
    await fireEvent.press(screen.getByTestId('recipe-save'));
    expect(screen.getByTestId('nothing-changed')).toBeTruthy();
    expect(patched).toHaveLength(0);
  });

  it('sends only the changed field and the version it started from, so the ingredient list is carried over', async () => {
    const patched: Call[] = [];
    const onSaved = jest.fn();
    await renderApp(<RecipeEditScreen recipeId={RECIPE} onSaved={onSaved} />, { routes: editRoutes(detail(), (c) => (patched.push(c), json(200, detail({ title: 'Egg fried rice' })))) });
    await fireEvent.changeText(await screen.findByTestId('recipe-title'), 'Egg fried rice');
    await fireEvent.press(screen.getByTestId('recipe-save'));
    await waitFor(() => expect(onSaved).toHaveBeenCalledWith(RECIPE));
    expect(patched[0]!.body).toEqual({ title: 'Egg fried rice', expected_current_version_id: VERSION });
  });

  it('keeps stored lines as they were when the list is reordered', async () => {
    const patched: Call[] = [];
    await renderApp(<RecipeEditScreen recipeId={RECIPE} onSaved={jest.fn()} />, { routes: editRoutes(detail(), (c) => (patched.push(c), json(200, detail()))) });
    await fireEvent.press(await screen.findByTestId('down-ingredient-0'));
    await fireEvent.press(screen.getByTestId('recipe-save'));
    await waitFor(() => expect(patched).toHaveLength(1));
    expect(patched[0]!.body).toEqual({
      ingredients: [{ text: 'salt to taste' }, { text: '2 large eggs', food_id: EGG, quantity: 2, serving_id: EGG_SERVING }],
      expected_current_version_id: VERSION,
    });
  });

  it('never confirms an unconfirmed food suggestion, and warns before dropping it', async () => {
    const patched: Call[] = [];
    const d = detail({
      ingredients: [
        { id: 'i1', position: 1, text: '1 cup rice', food_id: RICE, serving_id: null, quantity: 1, unit: 'cup_us', match_status: 'needs_confirmation' },
        { id: 'i2', position: 2, text: 'water', food_id: null, serving_id: null, quantity: null, unit: null, match_status: 'unmatched' },
      ],
    });
    await renderApp(<RecipeEditScreen recipeId={RECIPE} onSaved={jest.fn()} />, { routes: editRoutes(d, (c) => (patched.push(c), json(200, d))) });
    expect(await screen.findByTestId('draft-ingredient-status-0')).toHaveTextContent(/^Suggested food not confirmed/);
    await fireEvent.press(screen.getByTestId('remove-ingredient-1'));
    expect(screen.getByTestId('drops-suggestion')).toBeTruthy();
    await fireEvent.press(screen.getByTestId('recipe-save'));
    await waitFor(() => expect(patched).toHaveLength(1));
    expect(patched[0]!.body).toEqual({ ingredients: [{ text: '1 cup rice', quantity: 1, unit: 'cup_us' }], expected_current_version_id: VERSION });
  });

  it('explains a 409 when the recipe changed somewhere else', async () => {
    await renderApp(<RecipeEditScreen recipeId={RECIPE} onSaved={jest.fn()} />, {
      routes: editRoutes(detail(), () => json(409, { error: { code: 'CONFLICT', message: 'The recipe has a newer version', requestId: 'r' } })),
    });
    await fireEvent.changeText(await screen.findByTestId('recipe-servings-input'), '3');
    await fireEvent.press(screen.getByTestId('recipe-save'));
    expect(await screen.findByTestId('recipe-save-error')).toHaveTextContent(/changed somewhere else/);
  });

  it('asks for a yield before saving a version that has none', async () => {
    const patched: Call[] = [];
    await renderApp(<RecipeEditScreen recipeId={RECIPE} onSaved={jest.fn()} />, { routes: editRoutes(detail({ servings: null }), (c) => (patched.push(c), json(200, detail()))) });
    await fireEvent.changeText(await screen.findByTestId('recipe-title'), 'Renamed');
    await fireEvent.press(screen.getByTestId('recipe-save'));
    expect(screen.getByText(/servings greater than 0/)).toBeTruthy();
    expect(patched).toHaveLength(0);
  });
});
